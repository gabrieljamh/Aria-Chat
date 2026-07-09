import { createServer, IncomingMessage, ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"
import { browserManager } from "./browser-manager"
import { DOM_EXTRACTION_SCRIPT } from "./browser-inject"

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
      const sessionId = body.sessionId as string
      if (!sessionId) {
        sendJson(res, 400, { error: "sessionId required" })
        return
      }

      switch (route) {
        case "navigate":
          return handleNavigate(res, sessionId, body.url)
        case "screenshot":
          return handleScreenshot(res, sessionId, body.fullPage)
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

async function handleNavigate(res: ServerResponse, sessionId: string, url: string) {
  if (!url || (!url.startsWith("http://") && !url.startsWith("https://"))) {
    sendJson(res, 400, { error: "Invalid URL" })
    return
  }
  browserManager.navigate(sessionId, url)
  sendJson(res, 200, { url, title: "", loading: true })
}

async function handleScreenshot(res: ServerResponse, sessionId: string, fullPage: boolean) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  try {
    const image = await view.webContents.capturePage(fullPage ? undefined : undefined)
    const dataUrl = image.toDataURL()
    const size = image.getSize()
    sendJson(res, 200, { dataUrl, width: size.width, height: size.height })
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
        x = coords.x
        y = coords.y
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
  browserManager.sendScroll(view, dx ?? 0, dy ?? 0)
  sendJson(res, 200, { ok: true })
}

async function handleDrag(res: ServerResponse, sessionId: string, body: any) {
  const view = browserManager.getTarget(sessionId)
  if (!view) {
    sendJson(res, 404, { error: "No browser view for session" })
    return
  }
  await browserManager.sendDrag(view, body.fromX, body.fromY, body.toX, body.toY, body.duration ?? 500)
  sendJson(res, 200, { ok: true })
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
