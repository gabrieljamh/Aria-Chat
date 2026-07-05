import type { BrowserWindow } from "electron"
import WebSocket from "ws"
import stripAnsi from "strip-ansi"
import type { BashInteractiveRequest, BashInteractiveReply, PtyInfo } from "@shared/types"
import type { MimoClient } from "./client"

interface PtySession {
  ptyId: string
  askedId: string
  ws: WebSocket
  buffer: string
  exited: boolean
}

/**
 * Manages PTY WebSocket connections in the main process on behalf of the renderer.
 *
 * The renderer cannot set custom HTTP headers on browser WebSocket upgrade
 * requests, so the main process must hold the WS connection (ticket auth
 * requires a REST call with the `x-mimocode-ticket` header) and relay data
 * to the renderer via IPC broadcast channels.
 */
export class PtyManager {
  private sessions = new Map<string, PtySession>()
  private byAsked = new Map<string, string>() // askedId → ptyId

  constructor(
    private client: MimoClient,
    private broadcast: (channel: string, payload: unknown) => void,
  ) {}

  async spawnForBashRequest(req: BashInteractiveRequest): Promise<PtyInfo> {
    // Abort any existing session first
    if (this.sessions.size > 0) {
      for (const [id] of this.sessions) {
        await this.abort(id).catch(() => {})
      }
    }

    // 1. Create PTY on the server
    const info = await this.client.ptyCreate({
      command: "bash",
      args: ["-i"],
      cwd: req.cwd,
      title: `Interactive: ${req.description}`,
      env: req.env,
    })

    // 2. Get a one-time connection ticket
    const token = await this.client.ptyConnectToken(info.id)

    // 3. Open the WebSocket
    const wsUrl = this.client.buildWsUrl(`pty/${encodeURIComponent(info.id)}/connect`, {
      ticket: token.ticket,
      cursor: "0",
    })

    const ws = new WebSocket(wsUrl)
    const session: PtySession = {
      ptyId: info.id,
      askedId: req.id,
      ws,
      buffer: "",
      exited: false,
    }

    this.sessions.set(info.id, session)
    this.byAsked.set(req.id, info.id)

    ws.on("open", () => {
      // Feed the command as initial input
      ws.send(req.command + "\n")
    })

    ws.on("message", (data: WebSocket.RawData, isBinary: boolean) => {
      // Skip binary meta frames (0x00 + cursor JSON)
      if (isBinary) return

      const text = data.toString()
      session.buffer += text
      this.broadcast("pty-output", { id: info.id, data: text })
    })

    ws.on("close", () => {
      // If the PTY hasn't exited yet via SSE, the WS closing might mean
      // the process ended. The pty.exited SSE event is the authoritative
      // trigger for the reply, so we don't reply here.
    })

    ws.on("error", (err) => {
      console.error(`[pty-manager] WS error for ${info.id}:`, err.message)
      if (!session.exited) {
        this.sendReply(session, "(terminal connection error)", 1)
        this.cleanup(session)
      }
    })

    return info
  }

  sendInput(ptyId: string, data: string): void {
    const session = this.sessions.get(ptyId)
    if (session && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(data)
    }
  }

  async resize(ptyId: string, cols: number, rows: number): Promise<void> {
    await this.client.ptyResize(ptyId, cols, rows).catch(() => {})
  }

  /** Called when the server emits pty.exited SSE event */
  handlePtyExited(ptyId: string, exitCode: number): void {
    const session = this.sessions.get(ptyId)
    if (!session || session.exited) return
    session.exited = true

    const output = session.buffer || "(interactive command completed)"
    this.sendReply(session, output, exitCode)
    this.broadcast("pty-exit", { id: ptyId, exitCode })
    this.cleanup(session)
  }

  /** Abort: kill the PTY and reply with an abort message */
  async abort(ptyId: string): Promise<void> {
    const session = this.sessions.get(ptyId)
    if (!session) return
    if (!session.exited) {
      session.exited = true
      this.sendReply(session, session.buffer + "\n(aborted by user)", 1)
      this.broadcast("pty-exit", { id: ptyId, exitCode: 1 })
    }
    this.cleanup(session)
  }

  /** Force reply: for interactive commands that don't exit (vim, top) */
  async forceReply(ptyId: string, exitCode: number): Promise<void> {
    const session = this.sessions.get(ptyId)
    if (!session) return
    if (!session.exited) {
      session.exited = true
      this.sendReply(session, session.buffer || "(interactive command completed)", exitCode)
      this.broadcast("pty-exit", { id: ptyId, exitCode })
    }
    this.cleanup(session)
  }

  getSessionByAsked(askedId: string): PtySession | undefined {
    const ptyId = this.byAsked.get(askedId)
    if (!ptyId) return undefined
    return this.sessions.get(ptyId)
  }

  /** Check if a pty.exited SSE event belongs to a session we're managing */
  hasPty(ptyId: string): boolean {
    return this.sessions.has(ptyId)
  }

  private sendReply(session: PtySession, output: string, exitCode: number): void {
    const clean = stripAnsi(output).trim() || "(no output)"
    const reply: BashInteractiveReply = { output: clean, exitCode }
    this.client.bashInteractiveReply(session.askedId, reply).catch((err) => {
      console.error(`[pty-manager] Failed to send reply for ${session.askedId}:`, err.message)
    })
  }

  private cleanup(session: PtySession): void {
    session.ws.close()
    this.sessions.delete(session.ptyId)
    this.byAsked.delete(session.askedId)
    this.client.ptyDelete(session.ptyId).catch(() => {})
  }
}
