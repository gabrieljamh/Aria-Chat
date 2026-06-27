// Shared types for the Aria Chat Desktop IPC contract.
// These mirror the relevant subset of the Aria server schema
// (see ../../API_NOTES.md). They are intentionally permissive where the
// server payload is open-ended (metadata bags, unknown part types).

/* ----------------------------- Server events ---------------------------- */

export interface TextPart {
  id: string
  sessionID: string
  messageID: string
  type: "text"
  text: string
  synthetic?: boolean
  time?: { start: number; end?: number }
}

export interface ReasoningPart {
  id: string
  sessionID: string
  messageID: string
  type: "reasoning"
  text: string
  time?: { start: number; end?: number }
}

export type ToolStatus = "pending" | "running" | "completed" | "error"

export interface ToolPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: string
  state: {
    status: ToolStatus
    title?: string
    input?: Record<string, unknown>
    output?: string
    error?: string
    metadata?: Record<string, unknown>
    time?: { start: number; end?: number }
  }
}

export interface FilePart {
  id: string
  sessionID: string
  messageID: string
  type: "file"
  mime: string
  filename?: string
  url: string
}

export interface GenericPart {
  id: string
  sessionID: string
  messageID: string
  type: string
  [key: string]: unknown
}

export type Part = TextPart | ReasoningPart | ToolPart | FilePart | GenericPart

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  time?: { created: number; completed?: number }
  [key: string]: unknown
}

export interface QuestionOptionDef {
  label: string
  description: string
}

export interface QuestionInfo {
  id: string
  sessionID: string
  questions: {
    question: string
    header: string
    options: QuestionOptionDef[]
    multiple?: boolean
    custom?: boolean
    key?: string
    params?: Record<string, string>
  }[]
  tool?: {
    messageID: string
    callID: string
  }
}

export interface Permission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  tool?: {
    messageID: string
    callID: string
  }
}

export interface Todo {
  id: string
  content: string
  status: string // pending | in_progress | completed | cancelled
  priority: string // high | medium | low
}

export interface SessionStatusInfo {
  type: "idle" | "busy" | "retry"
  message?: string
  attempt?: number
  next?: number
}

export type ServerEvent =
  | { type: "server.connected"; properties: Record<string, never> }
  | { type: "server.heartbeat"; properties: Record<string, never> }
  | { type: "message.updated"; properties: { info: MessageInfo } }
  | { type: "message.removed"; properties: { sessionID: string; messageID: string } }
  | { type: "message.part.updated"; properties: { part: Part; delta?: string } }
  | { type: "message.part.removed"; properties: { sessionID: string; messageID: string; partID: string } }
  | { type: "permission.asked"; properties: Permission }
  | { type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: PermissionReply } }
  | { type: "question.asked"; properties: QuestionInfo }
  | { type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } }
  | { type: "question.rejected"; properties: { sessionID: string; requestID: string } }
  | { type: "todo.updated"; properties: { sessionID: string; todos: Todo[] } }
  | { type: "file.edited"; properties: { file: string } }
  | { type: "session.idle"; properties: { sessionID: string } }
  | { type: "session.status"; properties: { sessionID: string; status: SessionStatusInfo } }
  | { type: "session.updated"; properties: { info: SessionInfo } }
  | { type: "session.error"; properties: { sessionID?: string; error?: unknown } }

// Transport-level event: any of the known events above, or some other event
// type the server emits that this UI does not specifically handle. The known
// union (ServerEvent) preserves discriminated-union narrowing in reducers;
// unknown types fall through to a runtime default case.
export type AnyServerEvent = ServerEvent | { type: string; properties: Record<string, unknown> }

/* --------------------------- REST resource types ------------------------- */

export interface SessionInfo {
  id: string
  title?: string
  time?: { created: number; updated: number }
  [key: string]: unknown
}

export interface ModelRef {
  providerID: string
  modelID: string
}

export interface ProviderModel {
  id: string
  name: string
  status?: string
  // Context window + max output (tokens). Used to compute "% of context used".
  limit?: { context?: number; output?: number }
}

// Token accounting carried on an assistant message (subset of the server schema).
export interface MessageTokens {
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
}

export interface ProviderInfo {
  id: string
  name: string
  models: Record<string, ProviderModel>
}

export interface ProvidersResponse {
  all: ProviderInfo[]
  default: Record<string, string> // providerID -> modelID
  connected: string[]
}

export interface AgentInfo {
  name: string
  description?: string
  mode: "primary" | "subagent" | "all"
  builtIn: boolean
  permission?: {
    edit?: "ask" | "allow" | "deny"
    bash?: Record<string, "ask" | "allow" | "deny">
    webfetch?: "ask" | "allow" | "deny"
  }
  model?: ModelRef
}

export interface SkillInfo {
  name: string
  description: string
  location: string
  content: string
  hidden?: boolean
}

export interface CommandInfo {
  name: string
  description?: string
  agent?: string
  model?: string
  hints?: string[]
}

export interface PathInfo {
  home: string
  state: string
  config: string
  worktree: string
  directory: string
}

/* ------------------------------ Custom models ---------------------------- */

// A user-defined model/provider entry, persisted locally and merged into the
// model selector alongside the server's connected providers.
export interface CustomModel {
  providerID: string
  modelID: string
  label: string
}

/* ------------------------- Chat / Tasker registry ------------------------ */
// The internal key "cowork" is used for the Tasker mode (formerly Cowork).
export type RegistryKind = "chats" | "cowork"

// A persisted chat (Chat mode) or task (Tasker mode, internal key "cowork").
// Chat-mode chats run in an isolated sandbox under AppData;
// Tasker tasks run in a user-picked project.
export interface ChatRef {
  id: string
  sessionID: string
  title: string
  directory: string
  mode: RegistryKind
  createdAt: number
  updatedAt: number
}

export interface FileText {
  content: string
  truncated: boolean
  error?: string
}

// A file attached to a prompt; `url` is a data URI carrying the content.
export interface FileAttachment {
  filename: string
  mime: string
  url: string
}

// What the native picker returns (includes size + any per-file error).
export interface PickedAttachment extends FileAttachment {
  size: number
  error?: string
}

/* --------------------------- Provider config ---------------------------- */

// A provider entry written into the MiMo Code server config via PATCH /config.
// `options.baseURL` + `options.apiKey` configure an OpenAI-compatible (or any
// AI-SDK) endpoint; `npm` selects the AI SDK package; `models` lists model ids.
export interface ProviderConfigInput {
  name?: string
  npm?: string
  options?: { apiKey?: string; baseURL?: string; [key: string]: unknown }
  models?: Record<string, { name?: string } & Record<string, unknown>>
}

export interface ConfigPatch {
  provider?: Record<string, ProviderConfigInput>
  [key: string]: unknown
}

// Credentials stored via PUT /auth/{providerID}.
export type AuthInfo =
  | { type: "api"; key: string }
  | { type: "wellknown"; key: string; token: string }
  | { type: "oauth"; refresh: string; access: string; expires: number }

/* ------------------------------- IPC types ------------------------------- */

export type PermissionReply = "once" | "always" | "reject"

export interface PromptInput {
  sessionID: string
  text: string
  model?: ModelRef
  agent?: string
  directory?: string
  files?: FileAttachment[]
}

export type ServerStatus =
  | { state: "starting" }
  | { state: "ready"; url: string }
  | { state: "error"; message: string }
  | { state: "stopped" }

export interface MessageWithParts {
  info: MessageInfo
  parts: Part[]
}

// The API the preload script exposes on window.mimo
export interface AppInfo {
  appName: string
  appVersion: string
  electronVersion: string
  chromeVersion: string
  nodeVersion: string
  platform: string
  arch: string
}

export interface MimoApi {
  // server lifecycle
  getServerStatus(): Promise<ServerStatus>
  onServerStatus(cb: (status: ServerStatus) => void): () => void
  onServerEvent(cb: (event: ServerEvent) => void): () => void
  // Re-point at a server: pass a URL (+ optional password) to attach to a custom
  // server, or null/empty to clear the override and auto-spawn the bundled one.
  reconnectServer(url?: string | null, password?: string | null): Promise<ServerStatus>

  // REST
  listSessions(directory?: string): Promise<SessionInfo[]>
  createSession(opts?: { directory?: string; title?: string }): Promise<SessionInfo>
  getMessages(sessionID: string, directory?: string): Promise<MessageWithParts[]>
  prompt(input: PromptInput): Promise<void>
  abort(sessionID: string, directory?: string): Promise<void>
  summarizeSession(sessionID: string, providerID: string, modelID: string, directory?: string): Promise<boolean>
  deleteMessage(sessionID: string, messageID: string, directory?: string): Promise<void>
  replyPermission(requestID: string, reply: PermissionReply, directory?: string): Promise<void>
  getProviders(directory?: string): Promise<ProvidersResponse>
  getAgents(directory?: string): Promise<AgentInfo[]>
  getCommands(directory?: string): Promise<CommandInfo[]>
  getSkills(directory?: string): Promise<SkillInfo[]>
  installSkill(sourceDir: string): Promise<SkillInfo>
  installSkillFile(filePath: string): Promise<SkillInfo>
  uninstallSkill(name: string): Promise<void>
  getPath(): Promise<PathInfo | null>
  getTodos(sessionID: string, directory?: string): Promise<Todo[]>
  // Authoritative per-session run state (idle/busy/retry). Used to seed the
  // abort button's busy flag on load so a stale history reset can't hide it.
  getSessionStatus(directory?: string): Promise<Record<string, SessionStatusInfo>>

  // config / auth (configure providers, API keys, base URLs)
  getConfig(directory?: string): Promise<Record<string, unknown>>
  updateConfig(patch: ConfigPatch, directory?: string): Promise<void>
  updateGlobalConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>>
  setAuth(providerID: string, info: AuthInfo): Promise<void>
  // Fully removes a provider: server auth, desktop config copies, custom models.
  removeProvider(providerID: string): Promise<boolean>
  // Writes a provider into the GLOBAL server config so it resolves in every
  // directory/instance (fixes "Model not found"). The key goes to auth via setAuth.
  setGlobalProvider(providerID: string, entry: unknown): Promise<boolean>
  // Sets (or clears, when null) the global auto-compaction token threshold. The
  // server force-compacts the context once it reaches this many tokens.
  setCompactionThreshold(tokens: number | null, auto?: boolean): Promise<boolean>
  // Writes or clears the agent.compaction.model in the global server config so
  // auto-compaction on the server uses the dedicated model.
  setCompactRedirectModel(model: { providerID: string; modelID: string } | null): Promise<boolean>

  // workspaces / registries / files
  createChatSandbox(): Promise<{ id: string; directory: string }>
  ensureProjectMarker(directory: string): Promise<void>
  getRegistry(kind: RegistryKind): Promise<ChatRef[]>
  saveRegistry(kind: RegistryKind, items: ChatRef[]): Promise<void>
  openPath(path: string): Promise<string>
  readFileText(path: string): Promise<FileText>
  // Files under a working dir modified since a timestamp (workspace outputs,
  // including bash-created artifacts). Re-derived from disk, so it persists.
  listWorkspaceFiles(directory: string, sinceMs?: number): Promise<string[]>
  // Returns a mimo-file:// URL that serves the file (and its sibling assets) so
  // multi-file web apps preview correctly in the file viewer.
  getPreviewUrl(path: string): Promise<string>
  // Embeds the user's preferred name into the server's global AGENTS.md so every
  // conversation addresses them by it. Returns the file path written.
  setUserName(name: string): Promise<string>
  // Embeds free-form custom instructions into the global AGENTS.md (behavior
  // block) so they apply to every conversation. Returns the file path written.
  setCustomPrompt(content: string): Promise<string>
  deleteSandbox(directory: string): Promise<void>

  // native
  pickDirectory(): Promise<string | null>
  pickSkillFile(): Promise<string | null>
  // Native multi-file picker; reads each file into a data URI for attaching.
  pickAttachments(): Promise<PickedAttachment[]>
  onMenu(cb: (command: string) => void): () => void
  minimizeWindow(): void
  maximizeWindow(): void
  closeWindow(): void

  // settings store
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: unknown): Promise<void>

  // app info
  getAppInfo(): Promise<AppInfo>

  // questions
  questionReply(requestID: string, answers: string[][], directory?: string): Promise<void>
  questionReject(requestID: string, directory?: string): Promise<void>
}

declare global {
  interface Window {
    mimo: MimoApi
  }
}
