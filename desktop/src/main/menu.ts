import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from "electron"

/** Native app menu bar (File / Edit / View / Help). Menu clicks are forwarded
 *  to the renderer over the "menu-command" channel. */
export function buildMenu(win: BrowserWindow) {
  const isMac = process.platform === "darwin"
  const send = (command: string) => win.webContents.send("menu-command", command)

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" as const },
              { type: "separator" as const },
              { label: "Settings…", accelerator: "Cmd+,", click: () => send("settings") },
              { type: "separator" as const },
              { role: "hide" as const },
              { role: "quit" as const },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CmdOrCtrl+N", click: () => send("new-chat") },
        { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: () => send("open-folder") },
        { type: "separator" },
        ...(!isMac ? [{ label: "Settings…", accelerator: "Ctrl+,", click: () => send("settings") } as MenuItemConstructorOptions, { type: "separator" as const }] : []),
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Chat", accelerator: "CmdOrCtrl+1", click: () => send("tab-chat") },
        { label: "Tasker", accelerator: "CmdOrCtrl+2", click: () => send("tab-cowork") },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        { label: "Aria Chat on GitHub", click: () => shell.openExternal("https://github.com/XiaomiMiMo/MiMo-Code") },
        { label: "Server API Notes", click: () => send("show-api-notes") },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
