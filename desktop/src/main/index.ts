import { app, BrowserWindow, Menu, nativeImage, session, shell, Tray } from "electron"
import { join } from "node:path"
import { registerIpc } from "./ipc"
import { registerPreviewScheme, registerPreviewProtocol } from "./preview"
import { getStore } from "./store"
import { checkReleaseUpdate, spawnDevUpdater } from "./update"
import { migrateProjectsList } from "./workspaces"
import { browserManager } from "./browser-manager"
import { startBrowserServer } from "./browser-server"

// Must be registered before the app is ready.
registerPreviewScheme()

let mainWindow: BrowserWindow | null = null
let ipc: { dispose(): void } | null = null
let browserServer: { url: string; port: number; secret: string } | null = null
let browserServerPromise: Promise<void> = Promise.resolve()
let tray: Tray | null = null
// Closing the window hides to tray so the server, running turns and Scheduler
// tasks keep going; only an explicit Quit (tray menu / before-quit) exits.
let quitting = false
let trayBalloonShown = false

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Exit immediately. app.quit() schedules termination through the event loop,
  // which on Windows can let the not-yet-ready process boot far enough to flash
  // a window / splash before it dies — looks like a "restart" to the user and
  // briefly binds the browser-server port. app.exit(0) terminates synchronously.
  app.exit(0)
} else {
  app.on("second-instance", (_e, argv) => {
    // The trayed window may be hidden but is never destroyed on close, so
    // mainWindow is still valid. Restore + focus it. If somehow null (e.g.
    // macOS with no windows), recreate it.
    if (!mainWindow) {
      createWindow()
      return
    }
    if (!mainWindow.isVisible()) mainWindow.show()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    // Surface any URLs passed as command-line args (e.g. opening a mimo:// link).
    void argv
  })
}

function showMainWindow() {
  if (!mainWindow) {
    createWindow()
    return
  }
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
}

function createTray() {
  if (tray) return
  tray = new Tray(resolveIcon())
  tray.setToolTip("Aria — running in background")
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Aria", click: showMainWindow },
      { type: "separator" },
      {
        label: "Quit Aria",
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  // Single click restores the window (Windows convention).
  tray.on("click", showMainWindow)
}

function resolveIcon() {
  const ico = app.isPackaged
    ? join(__dirname, "../shared/img/aria-icon.ico")
    : join(__dirname, "../../src/shared/img/aria-icon.ico")
  const png = app.isPackaged
    ? join(__dirname, "../shared/img/aria-icon.png")
    : join(__dirname, "../../src/shared/img/aria-icon.png")
  return nativeImage.createFromPath(ico).isEmpty()
    ? nativeImage.createFromPath(png)
    : nativeImage.createFromPath(ico)
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    show: false,
    frame: false,
    icon: resolveIcon(),
    backgroundColor: "#1e2327",
    // No titleBarStyle: "hiddenInset" here — it re-enables the native macOS
    // traffic lights, duplicating the custom window buttons in App.tsx.
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Login launches with tray-start enabled boot straight to the tray without
  // flashing the window: Windows/Linux carry a --start-in-tray CLI flag (login
  // item args / autostart Exec), macOS reports openAsHidden via login items.
  const startHidden =
    process.argv.includes("--start-in-tray") ||
    (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAsHidden)
  win.on("ready-to-show", () => {
    if (!startHidden) win.show()
  })

  // Close = hide to tray. The app (server, in-flight turns, Scheduler tasks)
  // keeps running in the background; quit only via the tray menu.
  win.on("close", (e) => {
    if (quitting) return
    e.preventDefault()
    win.hide()
    if (process.platform === "win32" && tray && !trayBalloonShown) {
      trayBalloonShown = true
      tray.displayBalloon({
        title: "Aria is still running",
        content: "Tasks and the scheduler keep working in the background. Use the tray icon to reopen or quit.",
        icon: resolveIcon(),
      })
    }
  })

  // NOTE: do NOT set browserManager bounds here. The Web Agent renderer owns
  // the view's placement (webagent:set-bounds tracks the 4:3 frame). A resize
  // handler that forced full-window bounds left a blank BrowserView covering
  // the UI — an invisible box that swallowed all mouse input.

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: "deny" }
  })

  // electron-vite injects ELECTRON_RENDERER_URL in dev; load the built file otherwise.
  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"))
  }

  mainWindow = win
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    const aumid = app.isPackaged ? "com.mimocode.desktop" : "electron.app.mimocode-desktop"
    app.setAppUserModelId(aumid)
  }
  // Grant permission requests (microphone for voice recording, etc.) to the app
  // itself, but never to the sandboxed mimo-file:// preview iframe.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    const fromPreview = (details?.requestingUrl ?? "").startsWith("mimo-file://")
    callback(!fromPreview)
  })
  registerPreviewProtocol()
  migrateProjectsList()
  browserServerPromise = startBrowserServer()
    .then((bs) => {
      browserServer = bs
    })
    .catch((e) => console.error("[browser-server] failed to start:", e))
  await browserServerPromise
  ipc = registerIpc(() => mainWindow)
  createWindow()
  createTray()
  browserManager.setWindow(mainWindow!)

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else showMainWindow()
  })

  // Startup update check (default OFF; Settings → General). Packaged builds
  // compare against the latest GitHub release; dev checkouts hand off to the
  // Python updater (git pull + relaunch of `npm run dev`).
  if (getStore().get("updateCheck") === true) {
    if (app.isPackaged) void checkReleaseUpdate(mainWindow, false)
    else spawnDevUpdater(false)
  }
})

app.on("window-all-closed", () => {
  // Keep running in the tray. Windows only close for real during an explicit
  // quit (tray menu / before-quit), at which point app.quit() is already
  // underway — quitting here again is a harmless no-op guard.
  if (quitting && process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  quitting = true
  tray?.destroy()
  tray = null
  ipc?.dispose()
  browserManager.destroyAll()
})

export async function getBrowserServerUrl(): Promise<string | null> {
  await browserServerPromise
  return browserServer?.url ?? null
}
