import { dialog, BrowserWindow, type BrowserView } from "electron"
import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { browserManager } from "./browser-manager"
import { DOM_EXTRACTION_SCRIPT } from "./browser-inject"
import * as cdp from "./browser-cdp"
import { FIXED_VIEWPORT_ENABLED } from "./browser-cdp"
import { basename } from "node:path"
import { getRegisteredApps, resolveApp, launchApp, isProtocolUri, launchProtocol } from "./app-launcher"

// Resolve a DOM element (tagged by browser_getdom as data-webagent-id) to the
// CSS-pixel center of its bounding box — the same coordinate space clicks and
// drags use. elementId is JSON-encoded into the snippet so it can't break out
// of the string / inject script.
async function elementCenter(view: BrowserView, elementId: string): Promise<{ x: number; y: number; inViewport: boolean } | null> {
  return view.webContents.executeJavaScript(
    `(() => {
      const els = document.querySelectorAll('[data-webagent-id]');
      for (const el of els) {
        if (el.getAttribute('data-webagent-id') === ${JSON.stringify(elementId)}) {
          const r = el.getBoundingClientRect();
          const vw = window.innerWidth || document.documentElement.clientWidth;
          const vh = window.innerHeight || document.documentElement.clientHeight;
          // inViewport requires the element's box to actually overlap the
          // viewport (not just touch an edge), with non-zero size. Elements
          // scrolled off (r.top > vh or r.bottom < 0) are NOT inViewport.
          const inViewport = r.width > 0 && r.height > 0
            && r.bottom > 0 && r.top < vh
            && r.right > 0 && r.left < vw;
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, inViewport };
        }
      }
      return null;
    })()`,
  )
}

// Click-marker overlay: paints a fixed-position crosshair at the page-CSS coords
// of the most recent browser_click / browser_drag. The marker persists in the
// page DOM so it shows up in the NEXT browser_screenshot — letting the model
// see exactly where its (x,y) landed and self-diagnose misfired clicks. The
// screenshot handler clears ALL markers AFTER capturing them, so each screenshot
// shows the clicks since the last screenshot and the next one starts clean.
let markerSeq = 0
async function injectClickMarker(view: BrowserView, pageCssX: number, pageCssY: number, label?: string) {
  const id = `aria-click-marker-${markerSeq++}`
  await view.webContents.executeJavaScript(
    `(() => {
      const m = document.createElement('div');
      m.id = ${JSON.stringify(id)};
      m.className = 'aria-click-marker';
      m.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;';
      const markerX = String(${pageCssX});
      const markerY = String(${pageCssY});
      m.style.left = markerX + 'px';
      m.style.top = markerY + 'px';
      const outer = document.createElement('div');
      outer.style.cssText = 'position:absolute;transform:translate(-50%,-50%);width:40px;height:40px;border-radius:50%;background:rgba(232,17,35,0.25);border:2px solid #e81123;box-shadow:0 0 0 2px rgba(255,255,255,0.8),0 0 12px rgba(232,17,35,0.6);';
      m.appendChild(outer);
      const crossH = document.createElement('div');
      crossH.style.cssText = 'position:absolute;transform:translate(-50%,-50%);width:24px;height:2px;background:#e81123;';
      m.appendChild(crossH);
      const crossV = document.createElement('div');
      crossV.style.cssText = 'position:absolute;transform:translate(-50%,-50%);width:2px;height:24px;background:#e81123;';
      m.appendChild(crossV);
      const labelText = ${JSON.stringify(label ?? "")};
      if (labelText) {
        const t = document.createElement('div');
        t.style.cssText = 'position:absolute;transform:translate(-50%,-50%);top:30px;font:11px/1.4 -apple-system,Segoe UI,sans-serif;color:#fff;background:rgba(232,17,35,0.9);padding:2px 6px;border-radius:3px;white-space:nowrap;';
        t.textContent = labelText;
        m.appendChild(t);
      }
      document.documentElement.appendChild(m);
    })()`,
  ).catch(() => {})
}

async function clearClickMarkers(view: BrowserView) {
  await view.webContents
    .executeJavaScript(`(() => { document.querySelectorAll('.aria-click-marker').forEach((el) => el.remove()); return null; })()`)
    .catch(() => {})
}

export function startBrowserServer(): Promise<{ url: string; port: number; secret: string }> {
  return new Promise((resolve, reject) => {
    const secret = randomBytes(24).toString("hex")
    const server = createServer((req, res) => handleRequest(req, res, secret))
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      resolve({ url: `http://127.0.0.1:${port}/${secret}/`, port, secret })
    })
  })
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => (data += chunk))
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        reject(e)
      }
    })
    req.on("error", reject)
  })
}

function sendJson(res: ServerResponse, status: number, body: any) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

function handleRequest(req: IncomingMessage, res: ServerResponse, secret: string) {
  const url = new URL(req.url ?? "", "http://localhost")
  const pathParts = url.pathname.split("/").filter(Boolean)

  if (pathParts[0] !== secret) {
    sendJson(res, 401, { error: "Unauthorized" })
    return
  }

  const route = pathParts[1]
  if (!route) {
    sendJson(res, 404, { error: "Not found" })
    return
  }

  parseBody(req)
    .then(async (body) => {
      // Desktop-level routes (registered applications) — no browser session.
      if (route === "list-apps") return handleListApps(res)
      if (route === "run-app") return handleRunApp(res, body)

      const sessionId = body.sessionId as string
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId required" })
        return
      }

      switch (route) {
        case "navigate":
          return handleNavigate(res, sessionId, body.url)
        case "screenshot":
          return handleScreenshot(res, sessionId)
        case "getdom":
          return handleGetDom(res, sessionId, body.maxElements)
        case "click":
          return handleClick(res, sessionId, body)
        case "type":
          return handleType(res, sessionId, body)
        case "keystrokes":
          return handleKeystrokes(res, sessionId, body.keys)
        case "scroll":
          return handleScroll(res, sessionId, body.dx, body.dy)
        case "drag":
          return handleDrag(res, sessionId, body)
        case "draw":
          return handleDraw(res, sessionId, body)
        case "holdkey":
          return handleHoldKey(res, sessionId, body)
        case "zoom":
          return handleZoom(res, sessionId, body)
        case "copy":
          return handleCopy(res, sessionId, body.elementId)
        case "paste":
          return handlePaste(res, sessionId, body)
        case "state":
          return handleState(res, sessionId)
        default:
          sendJson(res, 404, { error: `Unknown route: ${route}` })
      }
    })
    .catch((e) => {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
    })
}

function handleListApps(res: ServerResponse) {
  const apps = getRegisteredApps().map((a) => ({
    id: a.id,
    name: a.name,
    binary: basename(a.path),
    autoAllow: Boolean(a.autoAllow),
  }))
  sendJson(res, 200, { apps })
}

async function handleRunApp(res: ServerResponse, body: any) {
  const query = (body.id as string) || (body.query as string) || ""
  const app = resolveApp(query)
  if (!app) {
    sendJson(res, 200, {
      ok: false,
      notFound: true,
      available: getRegisteredApps().map((a) => a.name),
    })
    return
  }
  // Per-app gate: apps the user marked auto-allow launch immediately; the rest
  // require an explicit confirmation before Aria may launch them.
  if (!app.autoAllow) {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const { response } = await dialog.showMessageBox(win ?? undefined!, {
      type: "question",
      buttons: ["Cancel", "Launch"],
      defaultId: 1,
      cancelId: 0,
      title: "Launch application",
      message: `Allow Aria to launch “${app.name}”?`,
      detail: app.path + (body.extraArgs ? `\nArgs: ${body.extraArgs}` : ""),
    })
    if (response !== 1) {
      sendJson(res, 200, { ok: false, declined: true, app: { id: app.id, name: app.name } })
      return
    }
  }
  const r = isProtocolUri(app.path)
    ? await launchProtocol(app)
    : launchApp(app, body.extraArgs)
  sendJson(res, 200, { ...r, app: { id: app.id, name: app.name } })
}

async function handleNavigate(res: ServerResponse, sessionId: string, url: string) {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    sendJson(res, 400, { error: "Invalid URL" })
    return
  }
  browserManager.navigate(sessionId, url)
  sendJson(res, 200, { url, title: "", loading: true })
}

async function handleScreenshot(res: ServerResponse, sessionId: string) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  // Fixed-viewport mode: capture the emulated viewport through CDP. The image is
  // exactly the logical viewport size (dsf 1), so pixels map 1:1 to click/drag
  // coordinates — none of the dpr/displayScale normalization below is needed.
  if (FIXED_VIEWPORT_ENABLED) {
    const zoom = browserManager.getZoom(sessionId)
    const shot = await cdp.capture(view.webContents, zoom)
    if (!shot) {
      sendJson(res, 500, { error: "CDP screenshot failed (fixed-viewport mode)" })
      return
    }
    await clearClickMarkers(view)
    sendJson(res, 200, { dataUrl: shot.dataUrl, width: shot.width, height: shot.height, dpr: 1, zoom })
    return
  }
  try {
    const image = await view.webContents.capturePage()
    // capturePage() returns PHYSICAL pixels (view-DIP size × display scale). Clicks
    // and drags operate in view-DIP pixels, so on a HiDPI/scaled display the raw
    // screenshot would be larger than the click coordinate space and any (x,y)
    // read off it would miss by the scale factor. Electron folds page zoom into
    // window.devicePixelRatio (dpr = displayScale × zoom), while capturePage size
    // depends only on displayScale — so divide by displayScale = dpr / zoom to get
    // the view-DIP grid. Normalizing to that makes screenshot pixels map 1:1 to
    // browser_click / browser_drag coordinates at any display scale AND any zoom.
    const dpr = (await view.webContents
      .executeJavaScript(`window.devicePixelRatio || 1`)
      .catch(() => 1)) as number
    const zoom = view.webContents.getZoomFactor() || 1
    const displayScale = dpr / zoom
    const raw = image.getSize()
    const normalized =
      displayScale && Math.abs(displayScale - 1) > 0.001
        ? image.resize({
            width: Math.max(1, Math.round(raw.width / displayScale)),
            height: Math.max(1, Math.round(raw.height / displayScale)),
          })
        : image
    const dataUrl = normalized.toDataURL()
    const size = normalized.getSize()
    // Clear click markers AFTER capturing — they were painted by prior
    // browser_click / browser_drag calls so the model could see where its
    // coordinates landed. Clearing here means the NEXT screenshot starts clean
    // (no stale markers), but THIS screenshot shows the markers for diagnosis.
    await clearClickMarkers(view)
    sendJson(res, 200, { dataUrl, width: size.width, height: size.height, dpr, zoom })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

async function handleGetDom(res: ServerResponse, sessionId: string, maxElements: number) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  try {
    const script = maxElements
      ? DOM_EXTRACTION_SCRIPT.replace("MAX_ELEMENTS = 500", `MAX_ELEMENTS = ${maxElements}`)
      : DOM_EXTRACTION_SCRIPT
    const result = await view.webContents.executeJavaScript(script)
    sendJson(res, 200, result ?? { url: "", title: "", elementCount: 0, elements: [] })
  } catch (e) {
    sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
  }
}

async function handleClick(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }

  let x = body.x
  let y = body.y

  if (body.elementId) {
    try {
      const coords = await elementCenter(view, body.elementId)
      if (coords) {
        if (!coords.inViewport) {
          // Element exists in the DOM but is scrolled offscreen. Clicking it
          // via synthetic input events won't work reliably (and a click on
          // offscreen coords is a no-op in most browsers). Tell the model to
          // scroll the element into view first — it can use browser_scroll
          // (page-relative deltas) or its elementId-based scroll hint.
          sendJson(res, 400, { error: `Element ${body.elementId} is offscreen — use browser_scroll to bring it into view, then re-screenshot and retry. (rect center: x=${Math.round(coords.x)}, y=${Math.round(coords.y)}, negative/out-of-range y means above/below the viewport.)` })
          return
        }
        // Legacy: getBoundingClientRect is page CSS px, input events are view-DIP,
        // and at page zoom Z view-DIP = pageCSS × Z, so scale the resolved center.
        // Fixed-viewport: CDP mouse shares the emulated CSS space with
        // getBoundingClientRect, so no scaling (factor stays 1).
        const zoom = FIXED_VIEWPORT_ENABLED ? 1 : view.webContents.getZoomFactor() || 1
        x = coords.x * zoom
        y = coords.y * zoom
      } else {
        sendJson(res, 400, { error: `Element ${body.elementId} not found` })
        return
      }
    } catch (e) {
      sendJson(res, 500, { error: `Failed to resolve element: ${e}` })
      return
    }
  }

  if (x === undefined || y === undefined) {
    sendJson(res, 400, { error: "No coordinates or elementId" })
    return
  }

  browserManager.sendClick(view, x, y, body.button)
  // Paint a persistent marker at the click location so the next screenshot shows
  // exactly where the (x,y) landed. Marker lives in page-CSS space; divide by the
  // same factor used above (1 in fixed-viewport mode) to convert back.
  const zoom = FIXED_VIEWPORT_ENABLED ? 1 : view.webContents.getZoomFactor() || 1
  await injectClickMarker(view, (x as number) / zoom, (y as number) / zoom, `click ${body.button ?? "left"}`)
  sendJson(res, 200, { ok: true, navigated: false })
}

async function handleType(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }

  if (body.elementId) {
    try {
      const coords = await elementCenter(view, body.elementId)
      if (!coords) {
        sendJson(res, 400, { error: `Element ${body.elementId} not found` })
        return
      }
      if (!coords.inViewport) {
        sendJson(res, 400, { error: `Element ${body.elementId} is offscreen — use browser_scroll to bring it into view, then re-screenshot and retry.` })
        return
      }
      const zoom = FIXED_VIEWPORT_ENABLED ? 1 : view.webContents.getZoomFactor() || 1
      browserManager.sendClick(view, coords.x * zoom, coords.y * zoom)
      await injectClickMarker(view, coords.x, coords.y, "type-focus")
      await new Promise((r) => setTimeout(r, 80))
    } catch {}
  }

  await browserManager.sendType(view, body.text ?? "", body.clear ?? true)
  sendJson(res, 200, { ok: true })
}

async function handleKeystrokes(res: ServerResponse, sessionId: string, keys: string) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  browserManager.sendKeystrokes(view, keys)
  sendJson(res, 200, { ok: true })
}

async function handleScroll(res: ServerResponse, sessionId: string, dx: number, dy: number) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  const r = await browserManager.sendScroll(view, dx ?? 0, dy ?? 0)
  // Report whether the page actually moved so the agent can tell "already at the
  // bottom" from a genuine failure instead of assuming the scroll worked.
  sendJson(res, 200, { ok: r.ok, scrolled: r.scrolled })
}

async function handleDrag(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }

  // Each endpoint may be given as a DOM element (fromElementId/toElementId) or as
  // raw CSS-pixel coordinates (fromX/fromY, toX/toY). Resolve any element ids to
  // their center first, then drag in the unified coordinate space.
  let fromX = body.fromX
  let fromY = body.fromY
  let toX = body.toX
  let toY = body.toY
  const zoom = FIXED_VIEWPORT_ENABLED ? 1 : view.webContents.getZoomFactor() || 1
  try {
    if (body.fromElementId) {
      const c = await elementCenter(view, body.fromElementId)
      if (!c) {
        sendJson(res, 400, { error: `Element ${body.fromElementId} not found` })
        return
      }
      if (!c.inViewport) {
        sendJson(res, 400, { error: `Element ${body.fromElementId} (drag start) is offscreen — use browser_scroll to bring it into view, then re-screenshot and retry.` })
        return
      }
      fromX = c.x * zoom
      fromY = c.y * zoom
    }
    if (body.toElementId) {
      const c = await elementCenter(view, body.toElementId)
      if (!c) {
        sendJson(res, 400, { error: `Element ${body.toElementId} not found` })
        return
      }
      if (!c.inViewport) {
        sendJson(res, 400, { error: `Element ${body.toElementId} (drag end) is offscreen — use browser_scroll to bring it into view, then re-screenshot and retry.` })
        return
      }
      toX = c.x * zoom
      toY = c.y * zoom
    }
  } catch (e) {
    sendJson(res, 500, { error: `Failed to resolve element: ${e}` })
    return
  }

  if ([fromX, fromY, toX, toY].some((v) => typeof v !== "number")) {
    sendJson(res, 400, { error: "Drag needs both endpoints as coordinates or element ids" })
    return
  }

  await browserManager.sendDrag(view, fromX, fromY, toX, toY, body.duration ?? 500)
  // Mark both drag endpoints so the next screenshot shows the trajectory. Drag
  // coords are view-DIP; convert to page-CSS for the marker.
  await injectClickMarker(view, (fromX as number) / zoom, (fromY as number) / zoom, "drag start")
  await injectClickMarker(view, (toX as number) / zoom, (toY as number) / zoom, "drag end")
  sendJson(res, 200, { ok: true })
}

async function handleDraw(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  const points = Array.isArray(body.points) ? body.points : []
  const clean = points
    .filter((p: any) => p && typeof p.x === "number" && typeof p.y === "number")
    .map((p: any) => ({ x: p.x, y: p.y }))
  if (clean.length < 2) {
    sendJson(res, 400, { error: "draw needs at least 2 points" })
    return
  }
  await browserManager.sendDraw(view, clean, body.duration ?? 800)
  sendJson(res, 200, { ok: true, points: clean.length })
}

async function handleHoldKey(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  if (!body.keys || typeof body.keys !== "string") {
    sendJson(res, 400, { error: "holdkey needs a keys string" })
    return
  }
  await browserManager.sendHoldKey(view, body.keys, typeof body.durationMs === "number" ? body.durationMs : 1000)
  sendJson(res, 200, { ok: true })
}

function handleZoom(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  const factor = browserManager.setZoom(sessionId, { factor: body.factor, direction: body.direction })
  sendJson(res, 200, { ok: true, factor })
}

async function handleCopy(res: ServerResponse, sessionId: string, elementId: string | undefined) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }

  if (elementId) {
    try {
      const text = await view.webContents.executeJavaScript(
        `(() => {
          const els = document.querySelectorAll('[data-webagent-id]');
          for (const el of els) {
            if (el.getAttribute('data-webagent-id') === '${elementId}') {
              return el.innerText || el.textContent || '';
            }
          }
          return '';
        })()`,
      )
      sendJson(res, 200, { text })
    } catch (e) {
      sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
    }
  } else {
    try {
      const text = await view.webContents.executeJavaScript("window.getSelection().toString()")
      sendJson(res, 200, { text })
    } catch (e) {
      sendJson(res, 200, { text: "" })
    }
  }
}

async function handlePaste(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }

  if (body.elementId) {
    try {
      const coords = await view.webContents.executeJavaScript(
        `(() => {
          const els = document.querySelectorAll('[data-webagent-id]');
          for (const el of els) {
            if (el.getAttribute('data-webagent-id') === '${body.elementId}') {
              const rect = el.getBoundingClientRect();
              return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
            }
          }
          return null;
        })()`,
      )
      if (coords) {
        browserManager.sendClick(view, coords.x, coords.y)
        await new Promise((r) => setTimeout(r, 80))
      }
    } catch {}
  }

  await browserManager.sendType(view, body.text ?? "", body.clear ?? false)
  sendJson(res, 200, { ok: true })
}

function handleState(res: ServerResponse, sessionId: string) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  sendJson(res, 200, {
    url: browserManager.getUrl(sessionId),
    title: browserManager.getTitle(sessionId),
    loading: browserManager.isLoading(sessionId),
  })
}
