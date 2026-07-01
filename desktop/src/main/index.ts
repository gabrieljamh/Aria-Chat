import { app, BrowserWindow, nativeImage, session, shell } from "electron"
import { join } from "node:path"
import { registerIpc } from "./ipc"
import { registerPreviewScheme, registerPreviewProtocol } from "./preview"

// Must be registered before the app is ready.
registerPreviewScheme()

let mainWindow: BrowserWindow | null = null
let ipc: { dispose(): void } | null = null

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
}

function resolveIcon() {
  const rel = app.isPackaged
    ? join(__dirname, "../shared/img/aria-icon.png")
    : join(__dirname, "../../src/shared/img/aria-icon.png")
  return nativeImage.createFromPath(rel)
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
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : undefined,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  win.on("ready-to-show", () => win.show())

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

app.whenReady().then(() => {
  // Grant permission requests (microphone for voice recording, etc.) to the app
  // itself, but never to the sandboxed mimo-file:// preview iframe.
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback, details) => {
    const fromPreview = (details?.requestingUrl ?? "").startsWith("mimo-file://")
    callback(!fromPreview)
  })
  registerPreviewProtocol()
  ipc = registerIpc(() => mainWindow)
  createWindow()

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("before-quit", () => {
  ipc?.dispose()
})
