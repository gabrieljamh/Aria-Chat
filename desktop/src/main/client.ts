import { EventEmitter } from "node:events"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type {
  AgentInfo,
  AuthInfo,
  CommandInput,
  ConfigPatch,
  McpConfig,
  McpStatus,
  MessageWithParts,
  PathInfo,
  PermissionReply,
  PromptInput,
  ProvidersResponse,
  ServerEvent,
  SessionInfo,
  SessionStatusInfo,
  TaskInfo,
  Todo,
} from "@shared/types"

/**
 * HTTP + SSE client for the MiMo Code server. Lives entirely in the Electron
 * main process; the renderer only ever sees parsed events over IPC.
 *
 * Endpoints are documented in ../../API_NOTES.md.
 */
export class MimoClient extends EventEmitter {
  private baseUrl: string
  private authHeader: string | null = null
  private abortSSE: AbortController | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private stopped = false

  constructor(baseUrl: string, credentials?: { username: string; password: string } | null) {
    super()
    this.baseUrl = baseUrl.replace(/\/$/, "")
    if (credentials) {
      const basic = Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")
      this.authHeader = `Basic ${basic}`
    }
  }

  private url(path: string, query?: Record<string, string | undefined>): string {
    const u = new URL(path, this.baseUrl + "/")
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, v)
      }
    }
    return u.toString()
  }

  private async json<T>(path: string, init?: RequestInit, query?: Record<string, string | undefined>): Promise<T> {
    const res = await fetch(this.url(path, query), {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(this.authHeader ? { authorization: this.authHeader } : {}),
        ...(init?.headers ?? {}),
      },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status} ${res.statusText} ${body}`)
    }
    if (res.status === 204) return undefined as T
    const text = await res.text()
    return (text ? JSON.parse(text) : undefined) as T
  }

  /* --------------------------------- REST -------------------------------- */

  listSessions(directory?: string): Promise<SessionInfo[]> {
    return this.json<SessionInfo[]>("session", undefined, { directory })
  }

  createSession(opts: { directory?: string; title?: string } = {}): Promise<SessionInfo> {
    return this.json<SessionInfo>(
      "session",
      { method: "POST", body: JSON.stringify({ title: opts.title }) },
      { directory: opts.directory },
    )
  }

  getMessages(sessionID: string, directory?: string): Promise<MessageWithParts[]> {
    return this.json<MessageWithParts[]>(`session/${encodeURIComponent(sessionID)}/message`, undefined, { directory })
  }

  async prompt(input: PromptInput): Promise<void> {
    const parts: Record<string, unknown>[] = [{ type: "text", text: input.text }]
    for (const f of input.files ?? []) {
      parts.push({ type: "file", mime: f.mime, filename: f.filename, url: f.url })
    }
    const body: Record<string, unknown> = { parts }
    if (input.model) body.model = input.model
    if (input.agent) body.agent = input.agent
    try {
      await this.json(
        `session/${encodeURIComponent(input.sessionID)}/message`,
        { method: "POST", body: JSON.stringify(body) },
        { directory: input.directory },
      )
    } catch (err) {
      // The POST /message handler runs the WHOLE agent turn before it responds,
      // so for a long turn the response can exceed Node/undici's default 300s
      // headers timeout (UND_ERR_HEADERS_TIMEOUT) or the socket may drop. That
      // is not a real failure: the turn keeps running server-side and the UI is
      // driven entirely by the SSE stream (tokens, tool calls, session.idle).
      // The POST body is redundant with SSE, so we swallow an in-flight drop and
      // let SSE own the turn lifecycle. Genuine send-time errors (server
      // unreachable, HTTP 4xx/5xx, bad request) are NOT in-flight drops and
      // still propagate.
      if (isInFlightDrop(err)) {
        console.warn("[mimo-client] prompt response not awaited; turn continues via SSE:", errCode(err))
        return
      }
      throw err
    }
  }

  async sendCommand(input: CommandInput): Promise<void> {
    const body: Record<string, unknown> = {
      command: input.command,
      arguments: input.arguments,
    }
    if (input.model) body.model = input.model
    if (input.agent) body.agent = input.agent
    try {
      await this.json(
        `session/${encodeURIComponent(input.sessionID)}/command`,
        { method: "POST", body: JSON.stringify(body) },
        { directory: input.directory },
      )
    } catch (err) {
      if (isInFlightDrop(err)) {
        console.warn("[mimo-client] command response not awaited; turn continues via SSE:", errCode(err))
        return
      }
      throw err
    }
  }

  async summarizeSession(
    sessionID: string,
    model: { providerID: string; modelID: string },
    directory?: string,
  ): Promise<boolean> {
    return this.json<boolean>(
      `session/${encodeURIComponent(sessionID)}/summarize`,
      { method: "POST", body: JSON.stringify(model) },
      { directory },
    )
  }

  async abort(sessionID: string, directory?: string): Promise<void> {
    await this.json(`session/${encodeURIComponent(sessionID)}/abort`, { method: "POST", body: "{}" }, { directory })
  }

  async deleteMessage(sessionID: string, messageID: string, directory?: string): Promise<void> {
    await this.json(`session/${encodeURIComponent(sessionID)}/message/${encodeURIComponent(messageID)}`, { method: "DELETE" }, { directory })
  }

  async replyPermission(requestID: string, reply: PermissionReply, directory?: string): Promise<void> {
    await this.json(
      `permission/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", body: JSON.stringify({ reply }) },
      { directory },
    )
  }

  getProviders(directory?: string): Promise<ProvidersResponse> {
    return this.json<ProvidersResponse>("provider", undefined, { directory })
  }

  getAgents(directory?: string): Promise<AgentInfo[]> {
    return this.json<AgentInfo[]>("agent", undefined, { directory })
  }

  async getCommands(directory?: string): Promise<{ name: string; description?: string; hints?: string[] }[]> {
    return this.json<{ name: string; description?: string; hints?: string[] }[]>("command", undefined, { directory })
  }

  async getSkills(directory?: string): Promise<{ name: string; description: string; location: string; content: string; hidden?: boolean }[]> {
    return this.json<{ name: string; description: string; location: string; content: string; hidden?: boolean }[]>("skill", undefined, { directory })
  }

  getPath(): Promise<PathInfo> {
    return this.json<PathInfo>("path")
  }

  getTodos(sessionID: string, directory?: string): Promise<Todo[]> {
    return this.json<Todo[]>(`session/${encodeURIComponent(sessionID)}/todo`, undefined, { directory })
  }

  getTasks(sessionID: string, directory?: string): Promise<TaskInfo[]> {
    return this.json<TaskInfo[]>(`session/${encodeURIComponent(sessionID)}/task`, undefined, { directory })
  }

  getSessionStatus(directory?: string): Promise<Record<string, SessionStatusInfo>> {
    return this.json<Record<string, SessionStatusInfo>>("session/status", undefined, { directory })
  }

  getConfig(directory?: string): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>("config", undefined, { directory })
  }

  async updateConfig(patch: ConfigPatch, directory?: string): Promise<void> {
    // NOTE: we deliberately do NOT use `PATCH /config` here. That endpoint
    // writes `<dir>/config.json`, but MiMo's project config loader only reads
    // `mimocode.json` / `mimocode.jsonc` (walking from the working directory up
    // to the worktree) — `config.json` is honored only for the global config
    // dir. So a PATCH would write a file the loader never reads.
    //
    // Instead we merge the patch into `<dir>/mimocode.json` (a file the loader
    // does read for this directory) and then dispose the instance so it
    // reloads the project config on the next request. No server restart needed.
    let dir = directory
    if (!dir) {
      const p = await this.json<{ directory: string }>("path").catch(() => null)
      dir = p?.directory
    }
    if (!dir) throw new Error("Could not resolve a working directory to write config into.")

    const file = join(dir, "mimocode.json")
    let existing: Record<string, unknown> = {}
    try {
      if (existsSync(file)) existing = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      existing = {}
    }
    const merged = deepMerge(existing, patch as Record<string, unknown>)
    writeFileSync(file, JSON.stringify(merged, null, 2))

    // Force this directory's instance to drop its cached config + provider
    // registry; the next request re-boots and reads the new mimocode.json.
    await this.disposeInstance(dir).catch(() => {})
  }

  async setAuth(providerID: string, info: AuthInfo): Promise<void> {
    await this.json(`auth/${encodeURIComponent(providerID)}`, { method: "PUT", body: JSON.stringify(info) })
  }

  async updateGlobalConfig(patch: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.json<Record<string, unknown>>("global/config", { method: "PATCH", body: JSON.stringify(patch) })
  }

  async removeAuth(providerID: string): Promise<void> {
    await this.json(`auth/${encodeURIComponent(providerID)}`, { method: "DELETE" }).catch(() => {})
  }

  async disposeInstance(directory?: string): Promise<void> {
    await this.json("instance/dispose", { method: "POST", body: "{}" }, { directory }).catch(() => {})
  }

  /* --------------------------------- MCP --------------------------------- */

  getMcpStatus(directory?: string): Promise<Record<string, McpStatus>> {
    return this.json<Record<string, McpStatus>>("mcp", undefined, { directory })
  }

  async addMcp(name: string, config: McpConfig, directory?: string): Promise<Record<string, McpStatus>> {
    return this.json<Record<string, McpStatus>>("mcp", { method: "POST", body: JSON.stringify({ name, config }) }, { directory })
  }

  async connectMcp(name: string, directory?: string): Promise<boolean> {
    return this.json<boolean>(`mcp/${encodeURIComponent(name)}/connect`, { method: "POST", body: "{}" }, { directory })
  }

  async disconnectMcp(name: string, directory?: string): Promise<boolean> {
    return this.json<boolean>(`mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST", body: "{}" }, { directory })
  }

  async authenticateMcp(name: string, directory?: string): Promise<McpStatus> {
    return this.json<McpStatus>(`mcp/${encodeURIComponent(name)}/auth/authenticate`, { method: "POST", body: "{}" }, { directory })
  }

  async removeMcpAuth(name: string, directory?: string): Promise<boolean> {
    await this.json(`mcp/${encodeURIComponent(name)}/auth`, { method: "DELETE" }, { directory })
    return true
  }

  async questionReply(requestID: string, answers: string[][], directory?: string): Promise<void> {
    await this.json(
      `question/${encodeURIComponent(requestID)}/reply`,
      { method: "POST", body: JSON.stringify({ answers }) },
      { directory },
    )
  }

  async questionReject(requestID: string, directory?: string): Promise<void> {
    await this.json(
      `question/${encodeURIComponent(requestID)}/reject`,
      { method: "POST", body: "{}" },
      { directory },
    )
  }

  /* ---------------------------------- SSE -------------------------------- */

  startEventStream() {
    this.stopped = false
    void this.connectSSE()
  }

  private async connectSSE() {
    if (this.stopped) return
    this.abortSSE?.abort()
    const controller = new AbortController()
    this.abortSSE = controller

    try {
      const res = await fetch(this.url("event"), {
        headers: {
          Accept: "text/event-stream",
          ...(this.authHeader ? { authorization: this.authHeader } : {}),
        },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        console.error("[mimo-client] SSE failed:", res.status)
        throw new Error(`event stream returned ${res.status}`)
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      this.emit("sse-state", "connected")

      while (!this.stopped) {
        const { value, done } = await reader.read()
        if (done) break
        const decoded = decoder.decode(value, { stream: true })
        buffer += decoded

        // SSE frames are separated by a blank line. Each frame may have
        // multiple `data:` lines that concatenate into one payload.
        let sep: number
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep)
          buffer = buffer.slice(sep + 2)
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trimStart())
            .join("\n")
          if (!data) continue
          try {
            const event = JSON.parse(data) as ServerEvent
            if (event.type !== "server.heartbeat") this.emit("event", event)
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch (err) {
      if (this.stopped) return
      this.emit("sse-state", "disconnected")
    }

    // Auto-reconnect with a small backoff unless stopped.
    if (!this.stopped) {
      this.reconnectTimer = setTimeout(() => this.connectSSE(), 1_000)
    }
  }

  dispose() {
    this.stopped = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.abortSSE?.abort()
  }
}

/** Network error code from a failed fetch (looks at undici's `cause`). */
function errCode(err: unknown): string {
  const cause = (err as { cause?: { code?: string }; code?: string } | undefined)
  return cause?.cause?.code ?? cause?.code ?? (err instanceof Error ? err.message : String(err))
}

/**
 * True when a fetch failed AFTER the request was accepted and in flight (long
 * response timed out, or the established socket dropped). These are expected for
 * the long-lived POST /message and must not surface as user-facing errors,
 * because SSE delivers the turn's result independently. Send-time failures like
 * ECONNREFUSED / ENOTFOUND (server unreachable) are deliberately excluded so
 * they still propagate.
 */
function isInFlightDrop(err: unknown): boolean {
  const code = errCode(err)
  return (
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET"
  )
}

/** Recursive merge of plain objects (arrays/primitives are replaced). */
function deepMerge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    const cur = out[k]
    if (isPlainObject(cur) && isPlainObject(v)) {
      out[k] = deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>)
    } else {
      out[k] = v
    }
  }
  return out
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
