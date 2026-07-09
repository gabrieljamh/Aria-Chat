import { useEffect, useReducer, useRef } from "react"
import type { BashInteractiveRequest, MessageInfo, Part, Permission, QuestionInfo, ServerEvent, SessionStatusInfo, TaskInfo, Todo } from "@shared/types"
// (Permission and QuestionInfo are used both for live events and pending-list re-hydration.)

export interface ConvMessage {
  info: MessageInfo
  parts: Part[]
}

export interface QuestionState {
  id: string
  sessionID: string
  questions: QuestionInfo["questions"]
  tool?: QuestionInfo["tool"]
}

export interface ActorState {
  actorID: string
  status: string
  lastOutcome?: string
  turnCount: number
  lastTurnTime: number
  error?: string
  description?: string
  agent?: string
  background?: boolean
  stuck?: { description: string; stuckDuration: number }
}

export interface State {
  order: string[]
  messages: Record<string, ConvMessage>
  todos: Todo[]
  tasks: TaskInfo[]
  files: string[]
  permissions: Permission[]
  questions: QuestionState[]
  actors: Record<string, ActorState>
  actorVersion: number
  busy: boolean
  // Non-idle run detail from session.status — lets the UI say WHY it's busy
  // (e.g. "Provider is overloaded — retry #3") instead of a bare spinner.
  statusInfo: SessionStatusInfo | null
  loading: boolean
  error: string | null
  bashInteractiveRequest: BashInteractiveRequest | null
  _subagentMsgIds: Set<string>
}

const empty: State = {
  order: [],
  messages: {},
  todos: [],
  tasks: [],
  files: [],
  permissions: [],
  questions: [],
  actors: {},
  actorVersion: 0,
  busy: false,
  statusInfo: null,
  loading: false,
  error: null,
  bashInteractiveRequest: null,
  _subagentMsgIds: new Set(),
}

type Action =
  | { kind: "reset"; messages: ConvMessage[]; todos: Todo[]; tasks: TaskInfo[]; busy?: boolean; files?: string[]; permissions?: Permission[]; questions?: QuestionState[] }
  | { kind: "loading"; loading: boolean }
  | { kind: "files"; files: string[] }
  // Soft re-sync after an SSE reconnect: upsert authoritative message data
  // (tokens, cost, completion) without clearing live-only state.
  | { kind: "sync"; messages: ConvMessage[]; busy?: boolean }
  | { kind: "event"; event: ServerEvent }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; error: string | null }

function upsertMessage(state: State, info: MessageInfo): State {
  const existing = state.messages[info.id]
  const messages = { ...state.messages, [info.id]: { info, parts: existing?.parts ?? [] } }
  const order = state.order.includes(info.id) ? state.order : [...state.order, info.id]
  return { ...state, messages, order }
}

function upsertPart(state: State, part: Part): State {
  const msgId = part.messageID
  let order = state.order
  let messages = state.messages
  if (!messages[msgId]) {
    messages = {
      ...messages,
      [msgId]: { info: { id: msgId, sessionID: part.sessionID, role: "assistant" }, parts: [] },
    }
    order = order.includes(msgId) ? order : [...order, msgId]
  }
  const msg = messages[msgId]
  const idx = msg.parts.findIndex((p) => p.id === part.id)
  const parts = idx === -1 ? [...msg.parts, part] : msg.parts.map((p) => (p.id === part.id ? part : p))
  return { ...state, order, messages: { ...messages, [msgId]: { ...msg, parts } } }
}

function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "loading":
      return { ...state, loading: action.loading }
    case "reset": {
      const messages: Record<string, ConvMessage> = {}
      const order: string[] = []
      for (const m of action.messages) {
        messages[m.info.id] = m
        order.push(m.info.id)
      }
      return {
        ...empty,
        messages,
        order,
        todos: action.todos,
        tasks: action.tasks,
        busy: action.busy ?? false,
        files: action.files ?? [],
        permissions: action.permissions ?? [],
        questions: action.questions ?? [],
      }
    }
    case "files":
      return { ...state, files: action.files }
    case "sync": {
      // SSE events lost during a disconnect gap (or dropped server-side under
      // backpressure) are never replayed; merge the DB-authoritative fetch in
      // so tokens/cost/busy can't stay stale until a manual session switch.
      let next = state
      for (const m of action.messages) {
        if (next._subagentMsgIds.has(m.info.id)) continue
        next = upsertMessage(next, m.info)
        for (const p of m.parts) {
          // Don't let a lagging DB snapshot clobber longer live-streamed text
          // (same guard as the message.part.updated case).
          const existing = next.messages[p.messageID]?.parts.find((x) => x.id === p.id)
          if (
            existing &&
            (existing as any).type === "text" &&
            (existing as any).text !== undefined &&
            (p as any).text !== undefined &&
            (existing as any).text.length >= (p as any).text.length
          ) {
            continue
          }
          next = upsertPart(next, p)
        }
      }
      return action.busy === undefined ? next : { ...next, busy: action.busy }
    }
    case "busy":
      return { ...state, busy: action.busy }
    case "error":
      return { ...state, error: action.error }
    case "event": {
      const e = action.event
      const t = e.type
      switch (t) {
        case "message.updated": {
          const info = e.properties.info
          const agentID = (info as any).agentID
          if (typeof agentID === "string" && agentID !== "main") {
            return { ...state, _subagentMsgIds: new Set(state._subagentMsgIds).add(info.id) }
          }
          const next = upsertMessage(state, info)
          const completed = info.role === "assistant" && Boolean((info.time as any)?.completed)
          return completed ? { ...next, busy: false } : next
        }
        case "message.removed": {
          const { [e.properties.messageID]: _, ...messages } = state.messages
          return { ...state, messages, order: state.order.filter((id) => id !== e.properties.messageID) }
        }
        case "message.part.updated": {
          const part = e.properties.part
          const msgId = part.messageID
          if (state._subagentMsgIds.has(msgId)) return state
          if (!state.messages[msgId]) return upsertPart(state, part)
          const msg = state.messages[msgId]
          const existing = msg.parts.find((p) => p.id === part.id)
          if (
            existing &&
            (existing as any).text !== undefined &&
            (part as any).text !== undefined &&
            (existing as any).type === "text" &&
            (existing as any).text.length >= (part as any).text.length
          ) {
            return state
          }
          return upsertPart(state, part)
        }
        case "message.part.delta": {
          const { messageID, partID, field, delta } = e.properties
          if (state._subagentMsgIds.has(messageID)) return state
          const msg = state.messages[messageID]
          if (!msg) {
            const synthetic: Part = {
              id: partID,
              sessionID: e.properties.sessionID,
              messageID,
              type: "text",
              text: field === "text" ? delta : "",
            } as Part
            return upsertPart(state, synthetic)
          }
          const existing = msg.parts.find((p) => p.id === partID)
          if (!existing) {
            const synthetic: Part = {
              id: partID,
              sessionID: e.properties.sessionID,
              messageID,
              type: "text",
              text: field === "text" ? delta : "",
            } as Part
            const next = { ...state, messages: { ...state.messages, [messageID]: { ...msg, parts: [...msg.parts, synthetic] } } }
            return next
          }
          const prev = (existing as any)[field] ?? ""
          const updated = { ...existing, [field!]: prev + delta } as Part
          const parts = msg.parts.map((p) => (p.id === partID ? updated : p))
          return { ...state, messages: { ...state.messages, [messageID]: { ...msg, parts } } }
        }
        case "message.part.removed": {
          const msgId = e.properties.messageID
          if (state._subagentMsgIds.has(msgId)) return state
          const msg = state.messages[e.properties.messageID]
          if (!msg) return state
          const parts = msg.parts.filter((p) => p.id !== e.properties.partID)
          return { ...state, messages: { ...state.messages, [msg.info.id]: { ...msg, parts } } }
        }
        case "permission.asked": {
          const perm = e.properties
          if (state.permissions.some((p) => p.id === perm.id)) return state
          return { ...state, permissions: [...state.permissions, perm] }
        }
        case "permission.replied":
          // Server sends `requestID` (= the permission id), not `permissionID`.
          return {
            ...state,
            permissions: state.permissions.filter((p) => p.id !== e.properties.requestID),
          }
        case "question.asked": {
          const q = e.properties
          if (state.questions.some((x) => x.id === q.id)) return state
          return { ...state, questions: [...state.questions, { id: q.id, sessionID: q.sessionID, questions: q.questions, tool: q.tool }] }
        }
        case "question.replied":
        case "question.rejected":
          return {
            ...state,
            questions: state.questions.filter((x) => x.id !== e.properties.requestID),
          }
        case "todo.updated":
          return { ...state, todos: e.properties.todos }
        case "task.created": {
          const { task } = e.properties
          const idx = state.tasks.findIndex((t) => t.id === task.id)
          if (idx >= 0) {
            const next = [...state.tasks]
            next[idx] = task
            return { ...state, tasks: next }
          }
          return { ...state, tasks: [...state.tasks, task] }
        }
        case "task.updated": {
          const { task } = e.properties
          const idx = state.tasks.findIndex((t) => t.id === task.id)
          if (idx >= 0) {
            const next = [...state.tasks]
            next[idx] = task
            return { ...state, tasks: next }
          }
          return { ...state, tasks: [...state.tasks, task] }
        }
        case "file.edited": {
          const f = e.properties.file
          const files = [...state.files.filter((x) => x !== f), f]
          return { ...state, files }
        }
        case "session.idle":
          return { ...state, busy: false, statusInfo: null }
        case "session.status":
          // Authoritative run state from the server: busy/retry => working,
          // idle => done. This is what keeps the abort button in sync.
          return {
            ...state,
            busy: e.properties.status.type !== "idle",
            statusInfo: e.properties.status.type === "idle" ? null : e.properties.status,
          }
        case "session.error": {
          const err = e.properties.error
          // AbortedError = user-initiated cancel, not a real error.
          if (err && typeof err === "object" && (err as any).name === "MessageAbortedError") {
            return { ...state, busy: false, statusInfo: null }
          }
          return { ...state, busy: false, statusInfo: null, error: stringifyError(err) }
        }
        case "actor.registered": {
          const p = e.properties as any
          const actor: ActorState = {
            actorID: p.actorID,
            status: "running",
            turnCount: 0,
            lastTurnTime: Date.now(),
            description: p.description,
            agent: p.agent,
            background: p.background,
          }
          return {
            ...state,
            actors: { ...state.actors, [p.actorID]: actor },
            actorVersion: state.actorVersion + 1,
          }
        }
        case "actor.status": {
          const p = e.properties as any
          const existing = state.actors[p.actorID]
          if (!existing) return state
          const actor: ActorState = {
            ...existing,
            status: p.status,
            lastOutcome: p.lastOutcome,
            turnCount: p.turnCount,
            lastTurnTime: p.lastTurnTime,
            error: p.error,
            stuck: undefined,
          }
          return {
            ...state,
            actors: { ...state.actors, [p.actorID]: actor },
            actorVersion: state.actorVersion + 1,
          }
        }
        case "actor.stuck": {
          const p = e.properties as any
          const existing = state.actors[p.actorID]
          if (!existing) return state
          const actor: ActorState = {
            ...existing,
            stuck: { description: p.description, stuckDuration: p.stuckDuration },
          }
          return {
            ...state,
            actors: { ...state.actors, [p.actorID]: actor },
            actorVersion: state.actorVersion + 1,
          }
        }
        case "bash.interactive.asked": {
          const p = e.properties as any
          const req: BashInteractiveRequest = {
            id: p.id,
            command: p.command,
            cwd: p.cwd,
            env: p.env,
            description: p.description,
          }
          return { ...state, bashInteractiveRequest: req }
        }
        case "bash.interactive.replied": {
          return { ...state, bashInteractiveRequest: null }
        }
        default:
          return state
      }
    }
    default:
      return state
  }
}

// File tools whose calls represent a created/edited file (mirrors what
// file.edited reports live). Used to rebuild the workspace file list from
// history so it survives an app restart, since file.edited events are not
// persisted.
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "apply_patch", "patch"])

/** Join a possibly-relative tool path onto the session directory (renderer has no node path). */
function resolveFilePath(fp: string, directory?: string | null): string {
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(fp) || fp.startsWith("/") || fp.startsWith("\\\\")
  if (isAbsolute || !directory) return fp
  const sep = directory.includes("\\") ? "\\" : "/"
  return directory.replace(/[\\/]+$/, "") + sep + fp.replace(/^[\\/]+/, "")
}

function extractFiles(messages: ConvMessage[], directory?: string | null): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== "tool") continue
      const tp = p as Extract<Part, { type: "tool" }>
      if (!FILE_TOOLS.has(tp.tool)) continue
      // Only successful writes — skip errored / pending calls (e.g. a failed
      // write to a bad relative path) so they don't show as broken file cards.
      if (tp.state?.status !== "completed") continue
      const raw = (tp.state?.input as { filePath?: unknown } | undefined)?.filePath
      if (typeof raw !== "string" || !raw) continue
      const fp = resolveFilePath(raw, directory)
      if (!seen.has(fp)) {
        seen.add(fp)
        out.push(fp)
      }
    }
  }
  return out
}

function stringifyError(error: unknown): string {
  if (!error) return "Unknown error"
  if (typeof error === "string") return error
  if (typeof error === "object" && error && "message" in error) return String((error as any).message)
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function useConversation(
  sessionID: string | null,
  directory?: string | null,
  since?: number,
  onAgentSync?: (agent: string) => void,
) {
  const [state, dispatch] = useReducer(reducer, empty)
  const sessionRef = useRef(sessionID)
  sessionRef.current = sessionID
  const directoryRef = useRef(directory)
  directoryRef.current = directory
  const sinceRef = useRef(since)
  sinceRef.current = since
  const onAgentSyncRef = useRef(onAgentSync)
  onAgentSyncRef.current = onAgentSync
  const populatedRef = useRef(false)
  const populatedForRef = useRef<string | null>(null)

  const setCurrentSession = (sid: string) => {
    sessionRef.current = sid
  }

  // Soft re-sync after an SSE reconnect. The 1s auto-reconnect in the main
  // process restores the stream, but events published during the gap (or
  // dropped server-side) are gone — including the final message.updated that
  // carries tokens/cost and session.idle. Re-pull authoritative state so the
  // stats panel and busy flag heal without a manual session switch.
  const lastResyncRef = useRef(0)
  const resyncRef = useRef<() => void>(() => {})
  resyncRef.current = () => {
    const sid = sessionRef.current
    // Initial load (or a load in flight) already fetches everything.
    if (!sid || populatedForRef.current !== sid) return
    const now = Date.now()
    if (now - lastResyncRef.current < 1_000) return
    lastResyncRef.current = now
    void Promise.all([
      window.mimo.getMessages(sid, directoryRef.current ?? undefined).catch(() => null),
      window.mimo.getSessionStatus(directoryRef.current ?? undefined).catch(() => null),
    ]).then(([messages, statuses]) => {
      if (sessionRef.current !== sid || !messages) return
      const busy = statuses ? (statuses[sid]?.type ? statuses[sid].type !== "idle" : false) : undefined
      dispatch({ kind: "sync", messages: messages as ConvMessage[], busy })
    })
  }

  // Re-derive the workspace file list from disk (files modified since the
  // conversation started, minus noise). Catches bash-made artifacts (zips, …)
  // that never emit a file.edited event, and is naturally persistent.
  const rescanRef = useRef<() => void>(() => {})
  rescanRef.current = () => {
    const sid = sessionRef.current
    const dir = directoryRef.current
    if (!sid || !dir) return
    window.mimo
      .listWorkspaceFiles(dir, sinceRef.current ?? 0)
      .then((list) => {
        if (sessionRef.current === sid) dispatch({ kind: "files", files: list })
      })
      .catch(() => {})
  }

  useEffect(() => {
    if (!sessionID) {
      populatedRef.current = false
      populatedForRef.current = null
      dispatch({ kind: "reset", messages: [], todos: [], tasks: [] })
      return
    }
    populatedRef.current = false
    populatedForRef.current = null
    dispatch({ kind: "reset", messages: [], todos: [], tasks: [] })
    dispatch({ kind: "loading", loading: true })
    let cancelled = false
    const sid = sessionID
    ;(async () => {
      const [messages, todos, tasks, statuses, diskFiles, pendingPerms, pendingQuestions] = await Promise.all([
        window.mimo.getMessages(sid, directory ?? undefined).catch((err) => {
          return []
        }),
        window.mimo.getTodos(sid, directory ?? undefined).catch((err) => {
          return []
        }),
        window.mimo.getTasks(sid, directory ?? undefined).catch((err) => {
          return []
        }),
        window.mimo.getSessionStatus(directory ?? undefined).catch(() => ({}) as Record<string, SessionStatusInfo>),
        directory ? window.mimo.listWorkspaceFiles(directory, since ?? 0).catch(() => [] as string[]) : Promise.resolve([] as string[]),
        // Pending question/permission requests survive on the server while the
        // renderer's event-fed state is wiped on session switch — re-fetch them
        // so the cards (incl. plan-mode entry/exit approvals) come back instead
        // of forcing an abort + retry.
        window.mimo.listPermissions(directory ?? undefined).catch(() => [] as Permission[]),
        window.mimo.listQuestions(directory ?? undefined).catch(() => [] as QuestionInfo[]),
      ])
      // Seed the abort button's busy flag from the session's real run state, so a
      // session that is already mid-turn (or a brand-new chat whose turn just
      // started) shows the stop button instead of a stale send button.
      const seededBusy = statuses[sid]?.type ? statuses[sid].type !== "idle" : false
      // Workspace files derived from disk (covers bash-created artifacts and
      // persists across restarts); fall back to the history-based extraction
      // when the directory can't be scanned.
      const seededFiles = diskFiles.length ? diskFiles : extractFiles(messages as ConvMessage[], directory)
      // Only this session's pending requests belong in this conversation view.
      const seededPerms = pendingPerms.filter((p) => p.sessionID === sid)
      const seededQuestions: QuestionState[] = pendingQuestions
        .filter((q) => q.sessionID === sid)
        .map((q) => ({ id: q.id, sessionID: q.sessionID, questions: q.questions, tool: q.tool }))
      if (cancelled) return
      if (sessionRef.current !== sid) {
        return
      }
      if (populatedForRef.current === sid) {
        dispatch({ kind: "loading", loading: false })
        return
      }
      populatedForRef.current = sid
      dispatch({ kind: "reset", messages, todos, tasks, busy: seededBusy, files: seededFiles, permissions: seededPerms, questions: seededQuestions })
      dispatch({ kind: "loading", loading: false })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionID])

  useEffect(() => {
    const unsub = window.mimo.onServerEvent((event) => {
      const sid = sessionRef.current
      if (!sid) return
      const evtSession = eventSessionId(event)
      if (evtSession && evtSession !== sid) return
      const t = event.type
      // The server sends server.connected as the first SSE frame of every
      // (re)connection — use it to heal any state lost during the gap.
      if (t === "server.connected") {
        resyncRef.current()
        return
      }
      // Sync agent mode dropdown when server changes agent (slash command / tool)
      if (t === "message.updated") {
        const info = (event as any).properties?.info
        if (info?.role === "user" && typeof info.agent === "string" && info.agent) {
          onAgentSyncRef.current?.(info.agent)
        }
      }
      if (
        t === "message.updated" ||
        t === "message.part.updated" ||
        t === "message.part.delta" ||
        t === "todo.updated" ||
        t === "task.created" ||
        t === "task.updated" ||
        t === "file.edited" ||
        t === "permission.asked" ||
        t === "question.asked" ||
        t === "question.replied" ||
        t === "question.rejected" ||
        t === "actor.registered" ||
        t === "actor.status" ||
        t === "actor.stuck"
      ) {
        populatedRef.current = true
      }
      dispatch({ kind: "event", event })
      // A finished turn is the moment files have settled — re-derive from disk
      // so bash-created outputs (zips, PDFs, …) show up.
      if (t === "session.idle") rescanRef.current()
    })
    return unsub
  }, [])

  return {
    state,
    setBusy: (busy: boolean) => dispatch({ kind: "busy", busy }),
    setError: (error: string | null) => dispatch({ kind: "error", error }),
    setCurrentSession,
  }
}

function eventSessionId(event: ServerEvent): string | undefined {
  const p = (event as any).properties ?? {}
  if (typeof p.sessionID === "string") return p.sessionID
  if (p.info && typeof p.info.sessionID === "string") return p.info.sessionID
  if (p.part && typeof p.part.sessionID === "string") return p.part.sessionID
  if (p.permission && typeof p.permission.sessionID === "string") return p.permission.sessionID
  if (p.questions && typeof p.sessionID === "string") return p.sessionID
  return undefined
}
