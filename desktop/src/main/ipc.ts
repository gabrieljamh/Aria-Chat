import { Notification, app, BrowserWindow, dialog, ipcMain, shell } from "electron"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { MimoClient } from "./client"
import {
  createChatSandbox,
  deleteSandbox,
  ensureProjectMarker,
  getRegistry,
  readFileText,
  listWorkspaceFiles,
  removeProviderFromConfigs,
  saveRegistry,
  sweepOrphanSandboxes,
  type ChatRef,
  type RegistryKind,
} from "./workspaces"
import { ServerManager } from "./server"
import { getStore } from "./store"
import { allowPreviewRoot } from "./preview"
import type { AuthInfo, CommandInput, ConfigPatch, McpConfig, PermissionReply, PromptInput, ServerStatus, SkillInfo } from "@shared/types"

// Sanitize config: remove undefined values from cost/limit objects that cause validation errors
function sanitizeConfig(obj: any): any {
  if (obj === null || typeof obj !== "object") return obj
  if (Array.isArray(obj)) return obj.map(sanitizeConfig)

  // If this is a model config with cost/limit, remove undefined fields (server has fallbacks)
  if (obj.cost && typeof obj.cost === "object") {
    for (const k of Object.keys(obj.cost)) {
      if (obj.cost[k] === undefined) delete obj.cost[k]
    }
  }
  if (obj.limit && typeof obj.limit === "object") {
    for (const k of Object.keys(obj.limit)) {
      if (obj.limit[k] === undefined) delete obj.limit[k]
    }
  }

  const out: Record<string, any> = {}
  for (const [k, v] of Object.entries(obj)) {
    const sv = sanitizeConfig(v)
    if (sv !== undefined) out[k] = sv
  }
  return out
}

// The GLOBAL server config file path (matches opencode's resolveMimocodeHome XDG config)
async function globalConfigFile(): Promise<string> {
  // On Windows, xdgConfig resolves to %USERPROFILE%\.config (e.g., C:\Users\PC Gamer\.config)
  // The server reads from ~/.config/mimocode/mimocode.json
  const home = process.env.HOME || process.env.USERPROFILE || require("os").homedir()
  return path.join(home, ".config", "mimocode", "mimocode.json")
}

// Sanitize global config file: read, remove undefined, write back
export async function sanitizeGlobalConfig(): Promise<void> {
  const file = await globalConfigFile()
  let cfg: Record<string, any> = {}
  try {
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    cfg = {}
  }
  cfg = sanitizeConfig(cfg)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
}

/**
 * Wires the renderer (over IPC) to the ServerManager + MimoClient. All HTTP/SSE
 * traffic stays in the main process; the renderer only sends commands and
 * receives parsed events.
 */
export function registerIpc(getWindow: () => BrowserWindow | null) {
  const server = new ServerManager()
  let client: MimoClient | null = null

  const broadcast = (channel: string, payload: unknown) => {
    const win = getWindow()
    if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
  }

  server.on("status", (status: ServerStatus) => broadcast("server-status", status))

  const ensureClient = (): MimoClient => {
    if (!client) throw new Error("Server is not ready yet.")
    return client
  }

  // Read/modify/write the global mimocode.json atomically-ish (single process).
  const mutateGlobalConfig = async (mutate: (cfg: Record<string, any>) => void) => {
    const file = await globalConfigFile()
    let cfg: Record<string, any> = {}
    try {
      if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"))
    } catch {
      cfg = {}
    }
    cfg = sanitizeConfig(cfg)
    mutate(cfg)
    cfg = sanitizeConfig(cfg)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
  }

  // Drop every cached instance so the next request to each directory reboots and
  // re-reads the (just-changed) global config. Used after add/remove provider.
  const disposeAllInstances = async () => {
    const dirs = new Set<string>()
    // "cowork" is the internal key for Tasker mode
    for (const kind of ["chats", "cowork"] as RegistryKind[]) {
      for (const ref of getRegistry(kind)) dirs.add(ref.directory)
    }
    await Promise.allSettled([...dirs].map((d) => client?.disposeInstance(d) ?? Promise.resolve()))
    await client?.disposeInstance().catch(() => {})
  }

  // (Re)build the SSE/REST client against whatever URL the server is now on.
  // Used on first boot, after an automatic restart, and after a manual reconnect.
  const wireClient = () => {
    client?.dispose()
    const url = server.getUrl()
    if (!url) return
    client = new MimoClient(url, server.getCredentials())
    client.on("event", (event) => broadcast("server-event", event))
    client.on("sse-state", (state) => broadcast("sse-state", state))
    client.startEventStream()
  }

  // The server respawned itself after a crash: point the client at the new URL.
  server.on("respawn", () => wireClient())

  let bootPromise: Promise<unknown>
  const connect = (opts: { attachUrl?: string | null; attachPassword?: string | null } = {}) => {
    bootPromise = (async () => {
      const attachUrl = opts.attachUrl ?? ((getStore().get("serverUrl") as string | undefined) ?? null)
      const attachPassword = opts.attachPassword ?? ((getStore().get("serverPassword") as string | undefined) ?? null)
      await server.start({ attachUrl, attachPassword })
      wireClient()
    })().catch((err) => {
      server.emit("status", { state: "error", message: String(err?.message ?? err) } satisfies ServerStatus)
    })
    return bootPromise
  }

  // Kick off boot immediately; renderer can also query status.
  connect()

  // Clean up orphaned generation sandboxes from previous sessions (deferred so
  // it never blocks startup). Runs once, before any new generation can occur.
  setTimeout(() => sweepOrphanSandboxes(), 3000)

  /* ----------------------------- lifecycle ----------------------------- */
  ipcMain.handle("get-server-status", () => server.getStatus())
  ipcMain.handle("reconnect-server", async (_e, opts: { url?: string | null; password?: string | null } = {}) => {
    // Persist the chosen target so the next launch uses it too. An empty/blank
    // URL clears the override and reverts to auto-spawning the bundled server.
    const url = opts.url?.trim() || null
    const password = opts.password?.trim() || null
    getStore().set("serverUrl", url)
    getStore().set("serverPassword", password)
    server.stop()
    await connect({ attachUrl: url, attachPassword: password })
    return server.getStatus()
  })

  /* -------------------------------- REST ------------------------------- */
  ipcMain.handle("list-sessions", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().listSessions(directory)
  })
  ipcMain.handle("create-session", async (_e, opts: { directory?: string; title?: string }) => {
    await bootPromise
    return ensureClient().createSession(opts ?? {})
  })
  ipcMain.handle("get-messages", async (_e, sessionID: string, directory?: string) => {
    await bootPromise
    return ensureClient().getMessages(sessionID, directory)
  })
  ipcMain.handle("get-subagent-messages", async (_e, sessionID: string, agentID: string, directory?: string) => {
    await bootPromise
    return ensureClient().getSubagentMessages(sessionID, agentID, directory)
  })
  ipcMain.handle("prompt", async (_e, input: PromptInput) => {
    await bootPromise
    return ensureClient().prompt(input)
  })
  ipcMain.handle("send-command", async (_e, input: CommandInput) => {
    await bootPromise
    return ensureClient().sendCommand(input)
  })
  ipcMain.handle("abort", async (_e, sessionID: string, directory?: string) => {
    await bootPromise
    return ensureClient().abort(sessionID, directory)
  })
  ipcMain.handle("summarize-session", async (_e, sessionID: string, providerID: string, modelID: string, directory?: string) => {
    await bootPromise
    return ensureClient().summarizeSession(sessionID, { providerID, modelID }, directory)
  })
  ipcMain.handle("delete-message", async (_e, sessionID: string, messageID: string, directory?: string) => {
    await bootPromise
    return ensureClient().deleteMessage(sessionID, messageID, directory)
  })
  ipcMain.handle("reply-permission", async (_e, requestID: string, reply: PermissionReply, directory?: string) => {
    await bootPromise
    return ensureClient().replyPermission(requestID, reply, directory)
  })
  ipcMain.handle("question-reply", async (_e, requestID: string, answers: string[][], directory?: string) => {
    await bootPromise
    return ensureClient().questionReply(requestID, answers, directory)
  })
  ipcMain.handle("question-reject", async (_e, requestID: string, directory?: string) => {
    await bootPromise
    return ensureClient().questionReject(requestID, directory)
  })
  ipcMain.handle("get-providers", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getProviders(directory)
  })
  ipcMain.handle("get-agents", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getAgents(directory)
  })
  ipcMain.handle("get-commands", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getCommands(directory)
  })
  ipcMain.handle("get-skills", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getSkills(directory)
  })
  ipcMain.handle("get-path", async () => {
    await bootPromise
    try {
      return await ensureClient().getPath()
    } catch {
      return null
    }
  })
ipcMain.handle("get-todos", async (_e, sessionID: string, directory?: string) => {
    await bootPromise
    return ensureClient().getTodos(sessionID, directory)
  })
  ipcMain.handle("get-tasks", async (_e, sessionID: string, directory?: string) => {
    await bootPromise
    return ensureClient().getTasks(sessionID, directory)
  })
  ipcMain.handle("get-session-status", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getSessionStatus(directory)
  })

  /* --------------------------- config / auth --------------------------- */
  ipcMain.handle("get-config", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getConfig(directory)
  })
  ipcMain.handle("update-config", async (_e, patch: ConfigPatch, directory?: string) => {
    await bootPromise
    return ensureClient().updateConfig(patch, directory)
  })
  ipcMain.handle("set-auth", async (_e, providerID: string, info: AuthInfo) => {
    await bootPromise
    return ensureClient().setAuth(providerID, info)
  })
  ipcMain.handle("update-global-config", async (_e, patch: Record<string, unknown>) => {
    await bootPromise
    return ensureClient().updateGlobalConfig(patch)
  })
  ipcMain.handle("set-global-provider", async (_e, providerID: string, entry: unknown) => {
    await bootPromise
    await mutateGlobalConfig((cfg) => {
      if (!cfg.provider || typeof cfg.provider !== "object") cfg.provider = {}
      ;(cfg.provider as Record<string, unknown>)[providerID] = entry
    })
    removeProviderFromConfigs(providerID)
    await disposeAllInstances()
    return true
  })
  ipcMain.handle("remove-provider", async (_e, providerID: string) => {
    await bootPromise
    // 1) server-side credentials (auth.json)
    await client?.removeAuth(providerID).catch(() => {})
    // 2) desktop store: custom models, any redirect refs, and the cached baseConfig
    const store = getStore()
    const customModels = (store.get("customModels") as { providerID?: string }[] | undefined) ?? []
    store.set("customModels", customModels.filter((c) => c.providerID !== providerID))
    for (const key of ["lastModel", "visionModel", "audioModel", "videoModel", "homeModel"]) {
      const m = store.get(key) as { providerID?: string } | undefined
      if (m && m.providerID === providerID) store.set(key, null)
    }
    const baseCfg = store.get("baseConfig") as Record<string, unknown> | null
    if (baseCfg?.provider && typeof baseCfg.provider === "object") {
      const prov = baseCfg.provider as Record<string, unknown>
      if (prov[providerID]) {
        delete prov[providerID]
        store.set("baseConfig", baseCfg)
      }
    }
    // 3) global config file — remove the provider entry directly & dispose
    try {
      const file = await globalConfigFile()
      if (fs.existsSync(file)) {
        const cfg = JSON.parse(fs.readFileSync(file, "utf8"))
        if (cfg?.provider && cfg.provider[providerID]) {
          delete cfg.provider[providerID]
          fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
        }
      }
    } catch {
      /* best-effort */
    }
    removeProviderFromConfigs(providerID)
    await disposeAllInstances()
    return true
  })
  ipcMain.handle("set-compaction-threshold", async (_e, tokens: number | null, auto?: boolean) => {
    await bootPromise
    await mutateGlobalConfig((cfg) => {
      if (!cfg.compaction || typeof cfg.compaction !== "object") cfg.compaction = {}
      if (tokens && tokens > 0) cfg.compaction.threshold = Math.round(tokens)
      else delete cfg.compaction.threshold
      if (typeof auto === "boolean") cfg.compaction.auto = auto
    })
    await disposeAllInstances()
    return true
  })

  ipcMain.handle("set-compact-redirect-model", async (_e, model: { providerID: string; modelID: string } | null) => {
    await bootPromise
    await mutateGlobalConfig((cfg) => {
      if (!cfg.agent || typeof cfg.agent !== "object") cfg.agent = {} as any
      if (model) {
        ;(cfg.agent as any).compaction = { model: `${model.providerID}/${model.modelID}` }
      } else {
        delete (cfg.agent as any).compaction
      }
    })
    await disposeAllInstances()
    return true
  })

  /* -------------------------------- window -------------------------------- */
  ipcMain.on("window-minimize", () => {
    const win = getWindow()
    if (win) win.minimize()
  })
  ipcMain.on("window-maximize", () => {
    const win = getWindow()
    if (win) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  })
  ipcMain.on("window-close", () => {
    const win = getWindow()
    if (win) win.close()
  })

  /* ------------------------------- native ------------------------------ */
  ipcMain.handle("pick-directory", async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openDirectory", "createDirectory"],
      title: "Choose a working folder",
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle("pick-skill-file", async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openFile"],
      title: "Choose a skill file",
      filters: [
        { name: "Skill packages", extensions: ["skill", "zip"] },
        { name: "All files", extensions: ["*"] },
      ],
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })

  ipcMain.handle("pick-attachments", async () => {
    const win = getWindow()
    const result = await dialog.showOpenDialog(win ?? undefined!, {
      properties: ["openFile", "multiSelections"],
      title: "Attach files",
    })
    if (result.canceled || result.filePaths.length === 0) return []
    const MAX = 25 * 1024 * 1024 // 25 MB per file
    return result.filePaths.map((fp) => {
      const filename = path.basename(fp)
      try {
        const stat = fs.statSync(fp)
        if (stat.size > MAX) {
          return { filename, mime: "", url: "", size: stat.size, error: "File is larger than 25 MB." }
        }
        const mime = attachmentMime(fp)
        const url = `data:${mime};base64,${fs.readFileSync(fp).toString("base64")}`
        return { filename, mime, url, size: stat.size }
      } catch (e: any) {
        return { filename, mime: "", url: "", size: 0, error: String(e?.message ?? e) }
      }
    })
  })

  /* ---------------------------- MCP connectors --------------------------- */
  ipcMain.handle("mcp-status", async (_e, directory?: string) => {
    await bootPromise
    return ensureClient().getMcpStatus(directory)
  })
  ipcMain.handle("mcp-add", async (_e, name: string, config: McpConfig, directory?: string) => {
    await bootPromise
    return ensureClient().addMcp(name, config, directory)
  })
  ipcMain.handle("mcp-connect", async (_e, name: string, directory?: string) => {
    await bootPromise
    return ensureClient().connectMcp(name, directory)
  })
  ipcMain.handle("mcp-disconnect", async (_e, name: string, directory?: string) => {
    await bootPromise
    return ensureClient().disconnectMcp(name, directory)
  })
  ipcMain.handle("mcp-authenticate", async (_e, name: string, directory?: string) => {
    await bootPromise
    return ensureClient().authenticateMcp(name, directory)
  })
  ipcMain.handle("mcp-remove-auth", async (_e, name: string, directory?: string) => {
    await bootPromise
    return ensureClient().removeMcpAuth(name, directory)
  })

  /* --------------------- skills management --------------------------- */
  function parseSkillFrontmatter(content: string): { name?: string; description?: string } {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
    if (!match) return {}
    const lines = match[1].split(/\r?\n/)
    const data: Record<string, string> = {}
    for (const line of lines) {
      const idx = line.indexOf(":")
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const value = line.slice(idx + 1).trim()
      if (key && value) data[key] = value
    }
    return { name: data.name, description: data.description }
  }

  ipcMain.handle("install-skill", async (_e, sourceDir: string) => {
    const skillMdPath = path.join(sourceDir, "SKILL.md")
    if (!fs.existsSync(skillMdPath)) {
      throw new Error("Selected folder does not contain a SKILL.md file.")
    }
    const content = fs.readFileSync(skillMdPath, "utf8")
    const frontmatter = parseSkillFrontmatter(content)
    const name = frontmatter.name || path.basename(sourceDir)
    const destDir = path.join(os.homedir(), ".agents", "skills", name)
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true })
    }
    copyDirRecursive(sourceDir, destDir)
    await ensureClient().disposeInstance().catch(() => {})
    return { name, description: frontmatter.description || "", location: skillMdPath, content } as SkillInfo
  })

  ipcMain.handle("install-skill-file", async (_e, filePath: string) => {
    if (!fs.existsSync(filePath)) {
      throw new Error("File not found.")
    }
    const { tmpdir } = await import("node:os")
    const { execFileSync } = await import("node:child_process")
    const tmpDir = path.join(tmpdir(), `skill-install-${Date.now()}`)
    const absPath = path.resolve(filePath)
    const ext = path.extname(absPath).toLowerCase()
    const zipPath = ext === ".zip" ? absPath : absPath + ".zip"
    fs.mkdirSync(tmpDir, { recursive: true })
    try {
      if (zipPath !== absPath) {
        fs.copyFileSync(absPath, zipPath)
      }
      execFileSync("powershell", [
        "-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${tmpDir}' -Force`,
      ], { timeout: 15000 })
      const skillMdPath = findSkillMd(tmpDir)
      if (!skillMdPath) {
        throw new Error("Archive does not contain a SKILL.md file.")
      }
      const skillDir = path.dirname(skillMdPath)
      const content = fs.readFileSync(skillMdPath, "utf8")
      const frontmatter = parseSkillFrontmatter(content)
      const name = frontmatter.name || path.basename(skillDir)
      const destDir = path.join(os.homedir(), ".agents", "skills", name)
      if (fs.existsSync(destDir)) {
        fs.rmSync(destDir, { recursive: true, force: true })
      }
      fs.mkdirSync(destDir, { recursive: true })
      copyDirRecursive(skillDir, destDir)
      await ensureClient().disposeInstance().catch(() => {})
      return { name, description: frontmatter.description || "", location: path.join(destDir, "SKILL.md"), content } as SkillInfo
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
      if (zipPath !== absPath && fs.existsSync(zipPath)) {
        fs.rmSync(zipPath, { force: true })
      }
    }
  })

  ipcMain.handle("uninstall-skill", async (_e, name: string) => {
    const destDir = path.join(os.homedir(), ".agents", "skills", name)
    if (fs.existsSync(destDir)) {
      fs.rmSync(destDir, { recursive: true, force: true })
    }
    await ensureClient().disposeInstance().catch(() => {})
  })

  /* ----- workspaces / registries ----------------------- */
  ipcMain.handle("chat-create-sandbox", () => createChatSandbox())
  ipcMain.handle("ensure-project-marker", (_e, directory: string) => ensureProjectMarker(directory))
  ipcMain.handle("registry-get", (_e, kind: RegistryKind) => getRegistry(kind))
  ipcMain.handle("registry-save", (_e, kind: RegistryKind, items: ChatRef[]) => saveRegistry(kind, items))
  ipcMain.handle("open-path", async (_e, p: string) => shell.openPath(p))
  ipcMain.handle("show-item-in-folder", async (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle("notify", async (_e, title: string, body: string) => {
    const supported = Notification.isSupported()
    console.log("[notify] isSupported:", supported, "platform:", process.platform)
    if (!supported) return
    try {
      const ico = app.isPackaged
        ? path.join(__dirname, "../shared/img/aria-icon.png")
        : path.join(__dirname, "../../src/shared/img/aria-icon.png")
      const n = new Notification({ title, body, icon: ico })
      n.on("click", () => console.log("[notify] click"))
      n.on("close", () => console.log("[notify] close"))
      n.on("failed", (_ev, err) => console.log("[notify] failed:", err))
      n.show()
      console.log("[notify] show() called for:", title)
    } catch (err) {
      console.log("[notify] error:", err)
    }
  })
  ipcMain.handle("read-file-text", (_e, p: string) => readFileText(p))
  ipcMain.handle("list-workspace-files", (_e, directory: string, sinceMs?: number) => listWorkspaceFiles(directory, sinceMs ?? 0))
  ipcMain.handle("preview-url", (_e, p: string) => allowPreviewRoot(p))
  const globalAgentsFile = async (): Promise<string> => {
    const info = await ensureClient().getPath().catch(() => null)
    if (!info?.config) throw new Error("Could not resolve the server's global config directory.")
    return path.join(info.config, "AGENTS.md")
  }
  ipcMain.handle("set-user-name", async (_e, name: string) => {
    await bootPromise
    const file = await globalAgentsFile()
    const n = String(name ?? "").trim()
    writeAgentsBlock(file, "user", n ? `# User\n\nThe user's name is ${n}. Address them as ${n} when it feels natural.` : "")
    return file
  })
  ipcMain.handle("set-custom-prompt", async (_e, content: string) => {
    await bootPromise
    const file = await globalAgentsFile()
    const c = String(content ?? "").trim()
    writeAgentsBlock(file, "behavior", c ? `# Custom instructions\n\n${c}` : "")
    return file
  })
  ipcMain.handle("delete-sandbox", async (_e, directory: string) => {
    // Release the server instance holding this directory so it stops writing
    // into it, then remove the folder (with retries). Best-effort throughout.
    await bootPromise
    await client?.disposeInstance(directory).catch(() => {})
    deleteSandbox(directory)
  })

  /* ------------------------------ settings ----------------------------- */
  ipcMain.handle("get-setting", (_e, key: string) => getStore().get(key))
  ipcMain.handle("set-setting", (_e, key: string, value: unknown) => getStore().set(key, value))

  /* ------------------------------- git -------------------------------- */
  ipcMain.handle("git-push", async (_e, opts: { directory: string; remote?: string; branch?: string; force?: boolean }) => {
    const { directory, remote = "origin", branch, force = false } = opts
    const store = getStore()
    const githubUsername = store.get("githubUsername") as string | undefined
    const githubToken = store.get("githubToken") as string | undefined

    if (!githubUsername || !githubToken) {
      throw new Error("GitHub username and token not configured. Set them in Settings > General.")
    }

    const { promisify } = await import("node:util")
    const execFile = promisify(require("node:child_process").execFile)

    // Get the remote URL and inject credentials for HTTPS auth
    const { stdout: remoteUrl } = await execFile("git", ["remote", "get-url", remote], { cwd: directory })
    const cleanUrl = remoteUrl.trim()
    
    let authUrl = cleanUrl
    if (cleanUrl.startsWith("https://")) {
      // Inject credentials: https://username:token@github.com/...
      const urlPart = cleanUrl.slice("https://".length)
      authUrl = `https://${encodeURIComponent(githubUsername)}:${encodeURIComponent(githubToken)}@${urlPart}`
    } else if (cleanUrl.startsWith("http://")) {
      const urlPart = cleanUrl.slice("http://".length)
      authUrl = `http://${encodeURIComponent(githubUsername)}:${encodeURIComponent(githubToken)}@${urlPart}`
    }

    // Push using the authenticated URL
    const args = ["push", authUrl]
    if (branch) args.push(branch)
    if (force) args.push("--force")

    const { stdout, stderr } = await execFile("git", args, { cwd: directory })
    if (stderr && !stdout) throw new Error(stderr)
    return stdout
  })

  ipcMain.handle("get-app-info", () => ({
    appName: "Aria Chat",
    appVersion: app.getVersion(),
    electronVersion: process.versions.electron,
    chromeVersion: process.versions.chrome,
    nodeVersion: process.versions.node,
    platform: process.platform,
    arch: process.arch,
  }))

  return {
    dispose() {
      client?.dispose()
      server.stop()
    },
  }
}

// Writes/updates a named managed block in the server's global AGENTS.md so it
// applies to every session. Idempotent: replaces any prior block with the same
// id, or removes it when content is empty, leaving the rest of the file intact.
function writeAgentsBlock(file: string, blockId: string, content: string) {
  const START = `<!-- mimo-desktop:${blockId} -->`
  const END = `<!-- /mimo-desktop:${blockId} -->`
  const inner = content.trim()
  let existing = ""
  try {
    existing = fs.readFileSync(file, "utf8")
  } catch {
    existing = ""
  }
  const esc = (str: string) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const re = new RegExp(`\\n*${esc(START)}[\\s\\S]*?${esc(END)}\\n*`, "g")
  let body = existing.replace(re, "\n").trim()
  if (inner) {
    const block = `${START}\n${inner}\n${END}`
    body = body ? `${body}\n\n${block}` : block
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body ? body + "\n" : "")
}

// Best-effort MIME from extension for attachments. Unknown text-like files are
// treated as text/plain (the server inlines those); everything else is binary.
const ATTACH_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
  ".ico": "image/x-icon", ".pdf": "application/pdf", ".json": "application/json",
  ".csv": "text/csv", ".html": "text/html", ".htm": "text/html", ".xml": "text/xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo", ".m4v": "video/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
  ".md": "text/plain", ".markdown": "text/plain", ".txt": "text/plain", ".log": "text/plain",
  ".yml": "text/plain", ".yaml": "text/plain", ".toml": "text/plain", ".ini": "text/plain",
  ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/plain", ".jsx": "text/plain",
  ".mjs": "text/plain", ".cjs": "text/plain", ".py": "text/plain", ".go": "text/plain",
  ".rs": "text/plain", ".java": "text/plain", ".c": "text/plain", ".h": "text/plain",
  ".cpp": "text/plain", ".cs": "text/plain", ".rb": "text/plain", ".php": "text/plain",
  ".sh": "text/plain", ".css": "text/plain", ".scss": "text/plain", ".sql": "text/plain",
}
function attachmentMime(filePath: string): string {
  return ATTACH_MIME[path.extname(filePath).toLowerCase()] ?? "application/octet-stream"
}

function copyDirRecursive(src: string, dest: string) {
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true })
  }
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

function findSkillMd(dir: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.isFile() && entry.name === "SKILL.md") return path.join(dir, "SKILL.md")
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const found = findSkillMd(path.join(dir, entry.name))
      if (found) return found
    }
  }
  return null
}

function escapeXml(s: string): string {
  let r = s.replace(/&/g, '\x26amp;')
  r = r.replace(/</g, '\x26lt;')
  r = r.replace(/>/g, '\x26gt;')
  r = r.replace(/"/g, '\x26quot;')
  return r
}
