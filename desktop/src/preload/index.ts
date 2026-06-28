import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type {
  AgentInfo,
  AuthInfo,
  ChatRef,
  CommandInfo,
  ConfigPatch,
  FileText,
  MessageWithParts,
  MimoApi,
  PathInfo,
  PermissionReply,
  PromptInput,
  ProvidersResponse,
  RegistryKind,
  ServerEvent,
  ServerStatus,
  SessionInfo,
  SkillInfo,
  TaskInfo,
  Todo,
} from "@shared/types"

const sub = <T>(channel: string, cb: (payload: T) => void): (() => void) => {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: MimoApi = {
  getServerStatus: () => ipcRenderer.invoke("get-server-status"),
  onServerStatus: (cb) => sub<ServerStatus>("server-status", cb),
  onServerEvent: (cb) => sub<ServerEvent>("server-event", cb),
  reconnectServer: (url, password) => ipcRenderer.invoke("reconnect-server", { url, password }) as Promise<ServerStatus>,

  listSessions: (directory) => ipcRenderer.invoke("list-sessions", directory) as Promise<SessionInfo[]>,
  createSession: (opts) => ipcRenderer.invoke("create-session", opts) as Promise<SessionInfo>,
  getMessages: (sessionID, directory) => ipcRenderer.invoke("get-messages", sessionID, directory) as Promise<MessageWithParts[]>,
  prompt: (input: PromptInput) => ipcRenderer.invoke("prompt", input) as Promise<void>,
  abort: (sessionID, directory) => ipcRenderer.invoke("abort", sessionID, directory) as Promise<void>,
  summarizeSession: (sessionID, providerID, modelID, directory) =>
    ipcRenderer.invoke("summarize-session", sessionID, providerID, modelID, directory) as Promise<boolean>,
  deleteMessage: (sessionID, messageID, directory) => ipcRenderer.invoke("delete-message", sessionID, messageID, directory) as Promise<void>,
  replyPermission: (requestID, reply: PermissionReply, directory) =>
    ipcRenderer.invoke("reply-permission", requestID, reply, directory) as Promise<void>,
  questionReply: (requestID, answers: string[][], directory) =>
    ipcRenderer.invoke("question-reply", requestID, answers, directory) as Promise<void>,
  questionReject: (requestID, directory) =>
    ipcRenderer.invoke("question-reject", requestID, directory) as Promise<void>,
  getProviders: (directory) => ipcRenderer.invoke("get-providers", directory) as Promise<ProvidersResponse>,
  getAgents: (directory) => ipcRenderer.invoke("get-agents", directory) as Promise<AgentInfo[]>,
  getCommands: (directory) => ipcRenderer.invoke("get-commands", directory) as Promise<CommandInfo[]>,
  getSkills: (directory) => ipcRenderer.invoke("get-skills", directory) as Promise<SkillInfo[]>,
  installSkill: (sourceDir: string) => ipcRenderer.invoke("install-skill", sourceDir) as Promise<SkillInfo>,
  installSkillFile: (filePath: string) => ipcRenderer.invoke("install-skill-file", filePath) as Promise<SkillInfo>,
  uninstallSkill: (name: string) => ipcRenderer.invoke("uninstall-skill", name) as Promise<void>,
  getPath: () => ipcRenderer.invoke("get-path") as Promise<PathInfo | null>,
  getTodos: (sessionID, directory) => ipcRenderer.invoke("get-todos", sessionID, directory) as Promise<Todo[]>,
  getTasks: (sessionID, directory) => ipcRenderer.invoke("get-tasks", sessionID, directory) as Promise<TaskInfo[]>,
  getSessionStatus: (directory) => ipcRenderer.invoke("get-session-status", directory) as Promise<Record<string, import("@shared/types").SessionStatusInfo>>,

  getConfig: (directory) => ipcRenderer.invoke("get-config", directory) as Promise<Record<string, unknown>>,
  updateConfig: (patch: ConfigPatch, directory) => ipcRenderer.invoke("update-config", patch, directory) as Promise<void>,
  updateGlobalConfig: (patch) => ipcRenderer.invoke("update-global-config", patch) as Promise<Record<string, unknown>>,
  setAuth: (providerID, info: AuthInfo) => ipcRenderer.invoke("set-auth", providerID, info) as Promise<void>,
  removeProvider: (providerID) => ipcRenderer.invoke("remove-provider", providerID) as Promise<boolean>,
  setGlobalProvider: (providerID, entry) => ipcRenderer.invoke("set-global-provider", providerID, entry) as Promise<boolean>,
  setCompactionThreshold: (tokens, auto) => ipcRenderer.invoke("set-compaction-threshold", tokens, auto) as Promise<boolean>,
  setCompactRedirectModel: (model: { providerID: string; modelID: string } | null) => ipcRenderer.invoke("set-compact-redirect-model", model) as Promise<boolean>,

  createChatSandbox: () => ipcRenderer.invoke("chat-create-sandbox") as Promise<{ id: string; directory: string }>,
  ensureProjectMarker: (directory) => ipcRenderer.invoke("ensure-project-marker", directory) as Promise<void>,
  getRegistry: (kind: RegistryKind) => ipcRenderer.invoke("registry-get", kind) as Promise<ChatRef[]>,
  saveRegistry: (kind: RegistryKind, items: ChatRef[]) => ipcRenderer.invoke("registry-save", kind, items) as Promise<void>,
  openPath: (path) => ipcRenderer.invoke("open-path", path) as Promise<string>,
  readFileText: (path) => ipcRenderer.invoke("read-file-text", path) as Promise<FileText>,
  listWorkspaceFiles: (directory, sinceMs) => ipcRenderer.invoke("list-workspace-files", directory, sinceMs) as Promise<string[]>,
  getPreviewUrl: (path) => ipcRenderer.invoke("preview-url", path) as Promise<string>,
  setUserName: (name) => ipcRenderer.invoke("set-user-name", name) as Promise<string>,
  setCustomPrompt: (content) => ipcRenderer.invoke("set-custom-prompt", content) as Promise<string>,
  deleteSandbox: (directory) => ipcRenderer.invoke("delete-sandbox", directory) as Promise<void>,

  pickDirectory: () => ipcRenderer.invoke("pick-directory") as Promise<string | null>,
  pickSkillFile: () => ipcRenderer.invoke("pick-skill-file") as Promise<string | null>,
  pickAttachments: () => ipcRenderer.invoke("pick-attachments") as Promise<import("@shared/types").PickedAttachment[]>,
  onMenu: (cb) => sub<string>("menu-command", cb),
  minimizeWindow: () => ipcRenderer.send("window-minimize"),
  maximizeWindow: () => ipcRenderer.send("window-maximize"),
  closeWindow: () => ipcRenderer.send("window-close"),

  getSetting: (key) => ipcRenderer.invoke("get-setting", key),
  setSetting: (key, value) => ipcRenderer.invoke("set-setting", key, value) as Promise<void>,
  gitPush: (opts: { directory: string; remote?: string; branch?: string; force?: boolean }) =>
    ipcRenderer.invoke("git-push", opts) as Promise<string>,
  getAppInfo: () => ipcRenderer.invoke("get-app-info") as Promise<import("@shared/types").AppInfo>,
}

contextBridge.exposeInMainWorld("mimo", api)
