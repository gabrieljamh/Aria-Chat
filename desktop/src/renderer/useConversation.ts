import { useCallback, useEffect, useMemo, useReducer, useRef } from "react"
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

type SlotAction =
  | { kind: "reset"; messages: ConvMessage[]; todos: Todo[]; tasks: TaskInfo[]; busy?: boolean; files?: string[]; permissions?: Permission[]; questions?: QuestionState[] }
  | { kind: "loading"; loading: boolean }
  | { kind: "files"; files: string[] }
  // Soft re-sync after an SSE reconnect: upsert authoritative message data
  // (tokens, cost, completion) without clearing live-only state.
  | { kind: "sync"; messages: ConvMessage[]; busy?: boolean }
  | { kind: "event"; event: ServerEvent }
  | { kind: "busy"; busy: boolean }
  | { kind: "error"; error: string | null }

// Per-session state registry: one State slot per sessionID, plus the active
// session pointer. The single useConversation hook tracks every session the
// renderer has seen — the active session's slot is returned as the visible
// `state`, while other slots keep streaming in the background. Lets the user
// start a cowork run, switch to WebAgent, send a new prompt, and have BOTH
// sessions' busy flags + messages tracked simultaneously.
interface Registry {
  sessions: Map<string, State>
  active: string | null
}

// Registry-level actions. Slot actions are wrapped with `sid` to identify the
// target session; the reducer pulls the slot out of the map, runs the existing
// inner switch (`slotReducer`) on it, and writes it back. `activate`/`evict`
// change the active pointer / drop a session slot.
type Action =
  | { kind: "session.activate"; sid: string | null }
  | { kind: "session.evict"; sid: string }
  | { kind: "session.reset"; sid: string; messages: ConvMessage[]; todos: Todo[]; tasks: TaskInfo[]; busy?: boolean; files?: string[]; permissions?: Permission[]; questions?: QuestionState[] }
  | { kind: "session.loading"; sid: string; loading: boolean }
  | { kind: "session.files"; sid: string; files: string[] }
  | { kind: "session.sync"; sid: string; messages: ConvMessage[]; busy?: boolean }
  | { kind: "session.event"; sid: string; event: ServerEvent }
  | { kind: "session.busy"; sid: string; busy: boolean }
  | { kind: "session.error"; sid: string; error: string | null }

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

function slotReducer(state: State, action: SlotAction): State {
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

// Registry reducer: routes a registry-level action into a single session's slot.
// Auto-inserts an `empty` slot for unknown sids so a streaming event for a
// session the renderer has never populated still gets tracked (followed by a
// populate fetch from the [sessionID] effect that fills in order/messages).
function registryReducer(reg: Registry, action: Action): Registry {
  switch (action.kind) {
    case "session.activate":
      return { ...reg, active: action.sid }
    case "session.evict": {
      if (!reg.sessions.has(action.sid)) return reg
      const sessions = new Map(reg.sessions)
      sessions.delete(action.sid)
      return { ...reg, sessions }
    }
    case "session.reset": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, {
        kind: "reset",
        messages: action.messages,
        todos: action.todos,
        tasks: action.tasks,
        busy: action.busy,
        files: action.files,
        permissions: action.permissions,
        questions: action.questions,
      })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.loading": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "loading", loading: action.loading })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.files": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "files", files: action.files })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.sync": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "sync", messages: action.messages, busy: action.busy })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.event": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "event", event: action.event })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.busy": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "busy", busy: action.busy })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    case "session.error": {
      const slot = reg.sessions.get(action.sid) ?? empty
      const next = slotReducer(slot, { kind: "error", error: action.error })
      const sessions = new Map(reg.sessions)
      sessions.set(action.sid, next)
      return { ...reg, sessions }
    }
    default:
      return reg
  }
}

const emptyReg: Registry = { sessions: new Map(), active: null }

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
  const [reg, dispatch] = useReducer(registryReducer, emptyReg)
  const regRef = useRef(reg)
  regRef.current = reg
  const sessionRef = useRef(sessionID)
  sessionRef.current = sessionID
  const directoryRef = useRef(directory)
  directoryRef.current = directory
  const sinceRef = useRef(since)
  sinceRef.current = since
  const onAgentSyncRef = useRef(onAgentSync)
  onAgentSyncRef.current = onAgentSync
  // Set of sessionIDs we've already populated (fetch + reset). Survives session
  // switches so we don't refetch a backgrounded session's state on tab switch —
  // this is the multitask win. Keyed by sid, not by the active session pointer.
  const populatedForRef = useRef<Set<string>>(new Set())

  const setCurrentSession = useCallback((sid: string) => {
    sessionRef.current = sid
    dispatch({ kind: "session.activate", sid })
  }, [])

  // Soft re-sync after an SSE reconnect. The 1s auto-reconnect in the main
  // process restores the stream, but events published during the gap (or
  // dropped server-side) are gone — including the final message.updated that
  // carries tokens/cost and session.idle. Fan out across EVERY known session
  // in the registry so backgrounded runs also heal, not just the active one.
  const lastResyncRef = useRef(0)
  const resyncRef = useRef<() => void>(() => {})
  resyncRef.current = () => {
    const known = Array.from(regRef.current.sessions.keys())
    if (known.length === 0) return
    const now = Date.now()
    if (now - lastResyncRef.current < 1_000) return
    lastResyncRef.current = now
    const dir = directoryRef.current
    // Snapshot the status map once (cheap), reuse for all sids in this dir.
    void window.mimo
      .getSessionStatus(dir ?? undefined)
      .catch(() => null)
      .then((statuses) => {
        if (!statuses) return
        for (const sid of known) {
          void window.mimo
            .getMessages(sid, dir ?? undefined)
            .catch(() => null)
            .then((messages) => {
              if (!messages) return
              const busy = statuses[sid]?.type ? statuses[sid].type !== "idle" : undefined
              dispatch({ kind: "session.sync", sid, messages: messages as ConvMessage[], busy })
            })
        }
      })
  }

  // Re-derive the workspace file list from disk for the active session only
  // (file list is per-directory; the registry cares about the active tab's dir).
  const rescanRef = useRef<(sid?: string) => void>(() => {})
  rescanRef.current = (sidArg) => {
    const sid = sidArg ?? sessionRef.current
    const dir = directoryRef.current
    if (!sid || !dir) return
    window.mimo
      .listWorkspaceFiles(dir, sinceRef.current ?? 0)
      .then((list) => {
        dispatch({ kind: "session.files", sid, files: list })
      })
      .catch(() => {})
  }

  // Populate effect: when `sessionID` changes, activate the slot. Only fetch +
  // reset if we haven't already populated this session — the multitask win is
  // that a backgrounded session's state is preserved across tab switches.
  useEffect(() => {
    if (!sessionID) {
      dispatch({ kind: "session.activate", sid: null })
      return
    }
    dispatch({ kind: "session.activate", sid: sessionID })
    if (populatedForRef.current.has(sessionID)) {
      // Already populated — keep the backgrounded state. No refetch.
      return
    }
    dispatch({ kind: "session.loading", sid: sessionID, loading: true })
    let cancelled = false
    const sid = sessionID
    ;(async () => {
      const [messages, todos, tasks, statuses, diskFiles, pendingPerms, pendingQuestions] = await Promise.all([
        window.mimo.getMessages(sid, directory ?? undefined).catch(() => [] as ConvMessage[]),
        window.mimo.getTodos(sid, directory ?? undefined).catch(() => [] as Todo[]),
        window.mimo.getTasks(sid, directory ?? undefined).catch(() => [] as TaskInfo[]),
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
      if (populatedForRef.current.has(sid)) {
        // A concurrent populate raced and won — drop ours.
        dispatch({ kind: "session.loading", sid, loading: false })
        return
      }
      populatedForRef.current.add(sid)
      dispatch({ kind: "session.reset", sid, messages, todos, tasks, busy: seededBusy, files: seededFiles, permissions: seededPerms, questions: seededQuestions })
      dispatch({ kind: "session.loading", sid, loading: false })
    })()
    return () => {
      cancelled = true
    }
  }, [sessionID])

  // Single SSE subscription. Demux every event by its extracted sessionID and
  // route into the matching slot — one stream keeps ALL sessions' state live,
  // not just the active tab's. This is the core of the multitasking fix.
  useEffect(() => {
    const unsub = window.mimo.onServerEvent((event) => {
      const t = event.type
      // The server sends server.connected as the first SSE frame of every
      // (re)connection — use it to heal any state lost during the gap.
      if (t === "server.connected") {
        resyncRef.current()
        return
      }
      const evtSid = eventSessionId(event)
      // Sync agent mode dropdown when server changes agent (slash command / tool) —
      // only relevant for the active session, since that's the tab the user is on.
      if (t === "message.updated" && evtSid === sessionRef.current) {
        const info = (event as any).properties?.info
        if (info?.role === "user" && typeof info.agent === "string" && info.agent) {
          onAgentSyncRef.current?.(info.agent)
        }
      }
      const targetSid = evtSid ?? sessionRef.current
      if (!targetSid) return
      // Mark the session as populated (events are flowing) so the populate
      // effect won't refetch it on next activation.
      populatedForRef.current.add(targetSid)
      dispatch({ kind: "session.event", sid: targetSid, event })
      // A finished turn is the moment files have settled — re-derive from disk
      // but only for the session that actually went idle.
      if (t === "session.idle" && targetSid === sessionRef.current) {
        rescanRef.current(targetSid)
      }
    })
    return unsub
  }, [])

  // Active session's state — what every tab component receives via props.state.
  const state = (reg.active && reg.sessions.get(reg.active)) || empty

  // Shallow per-session busy snapshot for sidebar busy dots. Recomputed on each
  // registry change — cheap (Map iteration), and these are the only reactive
  // consumers of registry state outside the active session.
  const sessionBusyMap = useMemo<Record<string, boolean>>(() => {
    const out: Record<string, boolean> = {}
    for (const [sid, slot] of reg.sessions) {
      if (slot.busy) out[sid] = true
    }
    return out
  }, [reg])

  const isSessionBusy = useCallback(
    (sid: string | null | undefined): boolean => (sid ? Boolean(reg.sessions.get(sid)?.busy) : false),
    [reg],
  )

  // Convenience setters target the active session. Use the explicit-sid
  // variants (`setBusyFor`/`setErrorFor`) when the caller might cross a tab
  // switch boundary (see sendPrompt race note in the plan).
  const setBusy = useCallback((busy: boolean) => {
    const sid = sessionRef.current
    if (sid) dispatch({ kind: "session.busy", sid, busy })
  }, [])
  const setError = useCallback((error: string | null) => {
    const sid = sessionRef.current
    if (sid) dispatch({ kind: "session.error", sid, error })
  }, [])
  const setBusyFor = useCallback((sid: string | null, busy: boolean) => {
    if (sid) dispatch({ kind: "session.busy", sid, busy })
  }, [])
  const setErrorFor = useCallback((sid: string | null, error: string | null) => {
    if (sid) dispatch({ kind: "session.error", sid, error })
  }, [])

  return {
    state,
    setBusy,
    setError,
    setCurrentSession,
    // New — registry extensions:
    isSessionBusy,
    sessionBusyMap,
    setBusyFor,
    setErrorFor,
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
