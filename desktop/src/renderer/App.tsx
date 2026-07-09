import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { applyAccentHue, startRgbCycle, stopRgbCycle } from "./accent"
import type {
  AgentInfo,
  ChatRef,
  CommandInfo,
  ModelRef,
  Part,
  PermissionReply,
  ProjectInfo,
  PtyInfo,
  ProvidersResponse,
  RegistryKind,
  ServerStatus,
  SessionInfoFull,
  WebAgentRef,
} from "@shared/types"
import { useConversation } from "./useConversation"
import { ChatTab } from "./ChatTab"
// TaskerTab is the renamed CoworkTab (old internal name: "cowork")
import { TaskerTab } from "./TaskerTab"
import { SchedulerMode } from "./SchedulerMode"
import { WebAgentMode } from "./WebAgentMode"
import { SettingsModal } from "./SettingsModal"
import { FileViewer } from "./FileViewer"
import { TerminalModal } from "./TerminalModal"
import { Splash } from "./Splash"
import { CustomServerModal } from "./CustomServerModal"
import { generateGreeting, generateSuggestions, type Suggestion } from "./generate"
import type { FileAttachment } from "@shared/types"

import ariaLogoRaw from "@shared/img/aria-logo.svg?raw"
import ariaTextRaw from "@shared/img/aria-text.svg?raw"

type Tab = "chat" | "cowork" | "scheduler" | "webagent" // "cowork" = Tasker mode internal key

async function resolveHomeModel(): Promise<ModelRef | null | undefined> {
  const on = await window.mimo.getSetting("homeRedirect").catch(() => null)
  if (on !== true) return undefined
  const m = (await window.mimo.getSetting("homeModel").catch(() => null)) as ModelRef | null
  if (m?.providerID && m?.modelID) return m
  return undefined
}

function uuid(): string {
  return (crypto as any).randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

// RGB accent cycle lives in accent.ts (startRgbCycle/stopRgbCycle) so the
// settings modal can stop/start it instantly instead of waiting for close.

export function App() {
  const [tab, setTab] = useState<Tab>("chat")
  const [status, setStatus] = useState<ServerStatus>({ state: "starting" })
  const [providers, setProviders] = useState<ProvidersResponse | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [model, setModel] = useState<ModelRef | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)
  const [userName, setUserName] = useState<string>("")
  const [webSearch, setWebSearch] = useState(false)
  // Auto-compaction token threshold (null when disabled/unset). Drives the
  // "forced auto-compaction" progress bar in the right-panel Stats section.
  const [compactThreshold, setCompactThreshold] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsPage, setSettingsPage] = useState<string | undefined>(undefined)
  const [customServerOpen, setCustomServerOpen] = useState(false)
  // True once the initial registries/providers/agents have loaded after the
  // server became ready. Drives the splash fade-out.
  const [dataLoaded, setDataLoaded] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  // Right workspace panel collapse — defaults differ per tab: Chat starts
  // collapsed (a thin strip), Tasker starts open.
  const [chatRightCollapsed, setChatRightCollapsed] = useState(true)
  const [coworkRightCollapsed, setCoworkRightCollapsed] = useState(false)
  const [schedulerRightCollapsed, setSchedulerRightCollapsed] = useState(false)
  const [webAgentRightCollapsed, setWebAgentRightCollapsed] = useState(false)
  const [webAgentMode, setWebAgentMode] = useState(false)
  // AI-generated home-screen content (per tab, cached for the app session).
  const [aiGreetings, setAiGreetings] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState(false)
  const [genGreeting, setGenGreeting] = useState<{ chat?: string; cowork?: string; scheduler?: string; webagent?: string }>({})
  const [genSuggest, setGenSuggest] = useState<{ chat?: Suggestion[]; cowork?: Suggestion[]; scheduler?: Suggestion[]; webagent?: Suggestion[] }>({})
  const genInflight = useRef<Set<string>>(new Set())
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const [brandMenuOpen, setBrandMenuOpen] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())

  // Interactive bash terminal
  const [ptyInfo, setPtyInfo] = useState<PtyInfo | null>(null)

  // registries
  const [chats, setChats] = useState<ChatRef[]>([])
  const [cowork, setCowork] = useState<ChatRef[]>([])
  const [webAgentSessions, setWebAgentSessions] = useState<WebAgentRef[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [activeCoworkId, setActiveCoworkId] = useState<string | null>(null)
  const [activeWebAgentId, setActiveWebAgentId] = useState<string | null>(null)
  const [coworkDir, setCoworkDir] = useState<string | null>(null)

  // Tasker mode: project + session tree state (Phase 1 rework)
  const [projects, setProjects] = useState<ProjectInfo[]>([])
  const [projectsLoading, setProjectsLoading] = useState(false)
  const [sessionsByDir, setSessionsByDir] = useState<Map<string, SessionInfoFull[]>>(new Map())
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set())
  const [pinnedDirs, setPinnedDirs] = useState<Set<string>>(new Set())

  // Synchronous mirrors of the registries. React state updates are async, so
  // within one async action (create chat -> send -> refresh title) reading the
  // state closure would be stale and could clobber the registry. The refs are
  // updated synchronously by `persist`, so every step sees the latest list.
  const chatsRef = useRef<ChatRef[]>([])
  const coworkRef = useRef<ChatRef[]>([])
  const webAgentRef = useRef<WebAgentRef[]>([])
  const hasHistoryImagesRef = useRef(false)

  const activeRef: ChatRef | null = useMemo(() => {
    if (tab === "chat") return chats.find((c) => c.id === activeChatId) ?? null
    if (tab === "cowork") return cowork.find((c) => c.id === activeCoworkId) ?? null
    if (tab === "webagent") return webAgentSessions.find((s) => s.id === activeWebAgentId) ?? null
    return null
  }, [tab, chats, cowork, webAgentSessions, activeChatId, activeCoworkId, activeWebAgentId])

  const activeSession = activeRef?.sessionID ?? null
  const activeDir = activeRef?.directory ?? null
  const taskerProjectDir = activeRef?.directory ?? coworkDir

  const { state, setBusy, setError, setCurrentSession } = useConversation(activeSession, activeDir, activeRef?.createdAt, (agent) => {
    if (agent && agent !== agentName) setAgentName(agent)
  })

  // Track whether the conversation history contains images (from tool results
  // like browser.screenshot) so sendPrompt can apply the vision redirect.
  useEffect(() => {
    for (const msg of Object.values(state.messages)) {
      for (const part of msg.parts) {
        if (part.type === "file" && typeof part.mime === "string" && part.mime.startsWith("image/")) {
          hasHistoryImagesRef.current = true
          return
        }
        // Tool results (e.g. browser.screenshot) carry their attachments under
        // part.state.attachments, not as a top-level "file" part, so scan there
        // too. Part's "tool" branch isn't discriminated cleanly because
        // GenericPart has `type: string`, so cast like extractFiles does.
        if (part.type === "tool") {
          const tp = part as Extract<Part, { type: "tool" }>
          if (tp.state?.status === "completed" && Array.isArray(tp.state.attachments)) {
            for (const att of tp.state.attachments) {
              if (typeof att?.mime === "string" && att.mime.startsWith("image/")) {
                hasHistoryImagesRef.current = true
                return
              }
            }
          }
        }
      }
    }
    hasHistoryImagesRef.current = false
  }, [state.messages])

  // Interactive bash: spawn PTY when a bash.interactive.asked event arrives
  useEffect(() => {
    if (!state.bashInteractiveRequest) return
    const req = state.bashInteractiveRequest
    // Abort any existing PTY first
    if (ptyInfo) {
      window.mimo.ptyAbort(ptyInfo.id)
      setPtyInfo(null)
    }
    window.mimo
      .ptyCreateAndConnect(req)
      .then((info) => setPtyInfo(info))
      .catch((err) => console.error("[App] Failed to spawn interactive PTY:", err))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.bashInteractiveRequest])

  // Auto-close terminal when PTY exits (for cases where pty.exit IPC fires)
  // The TerminalModal's own onPtyExit handler calls onClose, so we just
  // need to clear state when it closes.
  const closeTerminal = useCallback(() => {
    setPtyInfo(null)
  }, [])

  const abortTerminal = useCallback((ptyId: string) => {
    window.mimo.ptyAbort(ptyId)
    setPtyInfo(null)
  }, [])

  const sendCloseTerminal = useCallback((ptyId: string) => {
    window.mimo.ptyForceReply(ptyId, 0)
    setPtyInfo(null)
  }, [])

  // Desktop notifications for: approval needed, question asked, idle after busy
  const prevPermCount = useRef(0)
  const prevQCount = useRef(0)
  const prevBusy = useRef(state.busy)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const busyRef = useRef(state.busy)
  busyRef.current = state.busy
  const chatTitle = activeRef?.title ?? "Chat"
  useEffect(() => {
    const wasBusy = prevBusy.current
    prevBusy.current = state.busy
    if (idleTimer.current) { clearTimeout(idleTimer.current); idleTimer.current = null }
    if (wasBusy && !state.busy) {
      const busyAtSchedule = busyRef.current
      window.mimo.getSetting("notifIdle").then((enabled) => {
        if (enabled === false) return
        if (busyRef.current !== busyAtSchedule) return
        window.mimo.getSetting("notifIdleDelay").then((delay) => {
          if (busyRef.current !== busyAtSchedule) return
          const ms = typeof delay === "number" ? delay * 1000 : 3000
          const title = `Aria Chat \u2014 ${chatTitle}`
          const body = "Aria has finished working on your request, come take a look!"
          idleTimer.current = setTimeout(() => {
            if (busyRef.current !== busyAtSchedule) return
            window.mimo.notify(title, body)
          }, ms)
        })
      })
    }
  }, [state.busy, chatTitle])
  useEffect(() => {
    const len = state.permissions.length
    if (len > prevPermCount.current && len > 0) {
      window.mimo.getSetting("notifApproval").then((v) => {
        if (v === false) return
        window.mimo.notify(`Aria Chat \u2014 ${chatTitle}`, "Aria needs your approval to run a tool \u2014 swing by and grant it!")
      })
    }
    prevPermCount.current = len
  }, [state.permissions.length, chatTitle])
  useEffect(() => {
    const len = state.questions.length
    if (len > prevQCount.current && len > 0) {
      window.mimo.getSetting("notifQuestion").then((v) => {
        if (v === false) return
        window.mimo.notify(`Aria Chat \u2014 ${chatTitle}`, "Aria has a question for you \u2014 drop in and help out!")
      })
    }
    prevQCount.current = len
  }, [state.questions.length, chatTitle])

  /* ----------------------------- server status ---------------------------- */
  useEffect(() => {
    window.mimo.getServerStatus().then(setStatus)
    return window.mimo.onServerStatus(setStatus)
  }, [])

  useEffect(() => {
    window.mimo.getSetting("aiGreetings").then((v) => setAiGreetings(v === true))
    window.mimo.getSetting("aiSuggestions").then((v) => setAiSuggestions(v === true))
    window.mimo.getSetting("webAgentMode").then((v) => setWebAgentMode(v === true))
    window.mimo.getSetting("userName").then((v) => setUserName(typeof v === "string" ? v : ""))
    window.mimo.getSetting("accentHue").then((hv) => {
      const n = typeof hv === "number" ? hv : 0
      window.mimo.getSetting("accentDarkText").then((dv) => {
        const d = dv === true || dv === false ? dv : undefined
        window.mimo.getSetting("accentRgb").then((rgb) => {
          if (rgb === true) {
            startRgbCycle(n, d)
          } else {
            applyAccentHue(n, d)
          }
        })
      })
    })
  }, [])

  // Reconcile RGB mode when the settings modal closes. The modal starts/stops
  // the shared cycle directly for instant feedback; this is just a safety net
  // (e.g. settings changed by other means).
  useEffect(() => {
    if (settingsOpen) return
    window.mimo.getSetting("accentRgb").then((rgb) => {
      if (rgb === true) {
        window.mimo.getSetting("accentHue").then((hv) => {
          const n = typeof hv === "number" ? hv : 0
          window.mimo.getSetting("accentDarkText").then((dv) => {
            startRgbCycle(n, dv === true || dv === false ? dv : undefined)
          })
        })
      } else {
        stopRgbCycle()
        window.mimo.getSetting("accentHue").then((hv) => {
          const n = typeof hv === "number" ? hv : 0
          window.mimo.getSetting("accentDarkText").then((dv) => {
            applyAccentHue(n, dv === true || dv === false ? dv : undefined)
          })
        })
      }
    })
  }, [settingsOpen])

  // Load (and reload when the settings modal closes) the auto-compaction
  // threshold for the Stats bar. Only surfaced when auto-compaction is enabled.
  useEffect(() => {
    if (settingsOpen) return
    window.mimo.getSetting("compaction").then((v) => {
      const cfg = (v ?? {}) as { auto?: boolean; threshold?: number }
      const on = cfg.auto !== false
      setCompactThreshold(on && cfg.threshold && cfg.threshold > 0 ? cfg.threshold : null)
    })
  }, [settingsOpen])

  // Generate the home-screen greeting/suggestions in a throwaway sandbox when
  // landing on a new (empty) chat/task with the toggle on. Cached per tab; any
  // failure is swallowed so the static content remains.
  useEffect(() => {
    if (status.state !== "ready" || !model) return
    const kind: "chat" | "cowork" | "scheduler" | "webagent" | null =
      tab === "chat" && activeChatId === null ? "chat"
      : tab === "cowork" && activeCoworkId === null ? "cowork"
      : tab === "scheduler" ? "scheduler"
      : tab === "webagent" && activeWebAgentId === null ? "webagent"
      : null
    if (!kind) return
    if (aiGreetings && genGreeting[kind] === undefined && !genInflight.current.has("g-" + kind)) {
      genInflight.current.add("g-" + kind)
      ;(async () => {
        const hm = await resolveHomeModel()
        generateGreeting(kind, model, agentName, hm, userName)
          .then((g) => setGenGreeting((s) => ({ ...s, [kind]: g })))
          .catch(() => {})
          .finally(() => genInflight.current.delete("g-" + kind))
      })()
    }
    if (aiSuggestions && genSuggest[kind] === undefined && !genInflight.current.has("s-" + kind)) {
      genInflight.current.add("s-" + kind)
      ;(async () => {
        const hm = await resolveHomeModel()
        generateSuggestions(kind, model, agentName, hm)
          .then((sg) => setGenSuggest((s) => ({ ...s, [kind]: sg })))
          .catch(() => {})
          .finally(() => genInflight.current.delete("s-" + kind))
      })()
    }
  }, [status.state, tab, activeChatId, activeCoworkId, activeWebAgentId, aiGreetings, aiSuggestions, model, agentName, userName, genGreeting, genSuggest])

  /* ----------------------- initial load on ready -------------------------- */
  useEffect(() => {
    if (status.state !== "ready") {
      setDataLoaded(false)
      return
    }
    let cancelled = false
    ;(async () => {
      const [chatList, coworkList, webAgentList, provs, ags] = await Promise.all([
        window.mimo.getRegistry("chats").catch(() => []),
        window.mimo.getRegistry("cowork").catch(() => []),
        // ALWAYS load the webagent registry — never gate it on the webAgentMode
        // setting. That setting loads async and was still false when this
        // effect ran, so the list came up empty on every startup; creating a
        // new session then saved [newRef] over the file, silently destroying
        // all previous sessions. The toggle only controls tab visibility.
        window.mimo.getRegistry("webagent").catch(() => []),
        window.mimo.getProviders().catch(() => null),
        window.mimo.getAgents().catch(() => []),
      ])
      if (cancelled) return
      const sortedChats = sortByUpdated(chatList)
      const sortedCowork = sortByUpdated(coworkList)
      const sortedWebAgents = sortByUpdated(webAgentList)
      chatsRef.current = sortedChats
      coworkRef.current = sortedCowork
      webAgentRef.current = sortedWebAgents
      setChats(sortedChats)
      setCowork(sortedCowork)
      setWebAgentSessions(sortedWebAgents)
      setProviders(provs)
      setAgents(ags)
      // Restore the last-used model if we have one; otherwise fall back to the
      // server's default. Only set when nothing is chosen yet.
      const last = (await window.mimo.getSetting("lastModel").catch(() => null)) as ModelRef | null
      if (cancelled) return
      if (last && last.providerID && last.modelID) {
        setModel(last)
      } else if (provs && !model) {
        const entries = Object.entries(provs.default ?? {})
        const preferred = entries.find(([pid]) => (provs.connected ?? []).includes(pid)) ?? entries[0]
        if (preferred) setModel({ providerID: preferred[0], modelID: preferred[1] })
      }
      if (ags.length && !agentName) {
        const primary = ags.find((a) => a.name === "build") ?? ags.find((a) => a.mode !== "subagent") ?? ags[0]
        setAgentName(primary?.name ?? null)
      }
      // Restore pinned chats
      const favs = (await window.mimo.getSetting("favoriteIds").catch(() => [])) as string[]
      if (cancelled) return
      if (Array.isArray(favs)) setFavoriteIds(new Set(favs))
      // Restore pinned project dirs
      const pinned = (await window.mimo.getSetting("pinnedProjectDirs").catch(() => [])) as string[]
      if (cancelled) return
      if (Array.isArray(pinned)) setPinnedDirs(new Set(pinned))
      setDataLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [status.state])

  // Phase 1: Fetch projects from server when ready. Also merge in existing
  // cowork registry directories (backward compat — dirs registered before
  // the rework that might not be in the server's project list yet).
  useEffect(() => {
    if (status.state !== "ready") return
    let cancelled = false
    ;(async () => {
      setProjectsLoading(true)
      const isChatDir = (d: string) => d.includes("\\chats\\") || d.includes("/chats/")
      const _rawProjects = await window.mimo.listProjects().catch(() => [])
      const serverProjects = _rawProjects
        .filter((p: any) => !isChatDir(p.worktree))
      if (cancelled) return
      // Merge registry dirs not in server list — read from coworkRef (sync ref)
      const registryDirs = coworkRef.current.map((c) => c.directory)
        .filter((d) => !serverProjects.some((p) => p.worktree === d) && !isChatDir(d))
      const merged = [
        ...serverProjects,
        ...registryDirs.map((d) => ({
          id: "registry:" + d,
          worktree: d,
          time: { created: 0, updated: 0 },
        } as ProjectInfo)),
      ].filter((p, i, arr) => arr.findIndex((q) => q.worktree === p.worktree) === i)
      setProjects(merged)
      setProjectsLoading(false)
      // Fetch sessions for project directories that aren't cached yet
      const dirsToFetch = merged.map((p) => p.worktree).filter((d) => !sessionsByDir.has(d))
      await Promise.allSettled(dirsToFetch.map((d) => fetchSessions(d)))
    })()
    return () => { cancelled = true }
  }, [status.state, cowork.length])

  // Fetch sessions for a specific project directory (used by sidebar tree expand + refresh)
  const fetchSessions = useCallback(async (directory: string) => {
    setLoadingDirs((prev) => {
      const n = new Set(prev)
      n.add(directory)
      return n
    })
    const sessions = (await window.mimo.listProjectSessions(directory).catch(() => []))
      .filter((s) => {
        const t = s.title ?? ""
        return !t.startsWith("checkpoint-writer:") && !t.startsWith("dream:") && !t.startsWith("distill:")
      })
    setSessionsByDir((prev) => {
      const n = new Map(prev)
      n.set(directory, sessions)
      return n
    })
    setLoadingDirs((prev) => {
      const n = new Set(prev)
      n.delete(directory)
      return n
    })
  }, [])

  // Auto-fetch sessions for the active Tasker project when switching to the
  // Tasker tab or when the project changes. This drives the sidebar tree.
  useEffect(() => {
    if (tab !== "cowork" || !taskerProjectDir) return
    if (!sessionsByDir.has(taskerProjectDir)) {
      fetchSessions(taskerProjectDir)
    }
  }, [tab, taskerProjectDir, fetchSessions, sessionsByDir])

  const refreshProviders = useCallback(async () => {
    const provs = await window.mimo.getProviders(activeDir ?? undefined).catch(() => null)
    if (provs) setProviders(provs)
  }, [activeDir])

  const openSettings = useCallback((pageId?: string) => {
    setSettingsPage(pageId)
    setSettingsOpen(true)
  }, [])

  // Drop the cached home-screen generations for the current tab so the effect
  // regenerates them (manual, opt-in — costs a token call only when clicked).
  const regenerateHome = useCallback(() => {
    const kind: "chat" | "cowork" | "scheduler" | "webagent" =
      tab === "cowork" ? "cowork" : tab === "scheduler" ? "scheduler" : tab === "webagent" ? "webagent" : "chat"
    genInflight.current.delete("g-" + kind)
    genInflight.current.delete("s-" + kind)
    setGenGreeting((s2) => { const n = { ...s2 }; delete n[kind]; return n })
    setGenSuggest((s2) => { const n = { ...s2 }; delete n[kind]; return n })
  }, [tab])

  // Persist the chosen model so the app reopens on the same one.
  const selectModel = useCallback((m: ModelRef) => {
    setModel(m)
    window.mimo.setSetting("lastModel", m).catch(() => {})
  }, [])

  /* --------------------------- registry helpers --------------------------- */
  const persist = useCallback((kind: RegistryKind, items: ChatRef[]) => {
    const sorted = sortByUpdated(items)
    if (kind === "chats") {
      chatsRef.current = sorted
      setChats(sorted)
    } else if (kind === "webagent") {
      // Was a chats/cowork two-way branch: persist("webagent", …) fell into
      // the cowork arm, and the title-sync path fed it the Tasker list — the
      // whole Tasker registry got written into WebAgentList.json, which the
      // loader's directory filter then (rightly) rejected wholesale.
      webAgentRef.current = sorted as WebAgentRef[]
      setWebAgentSessions(sorted as WebAgentRef[])
    } else {
      coworkRef.current = sorted
      setCowork(sorted)
    }
    window.mimo.saveRegistry(kind, sorted).catch(() => {})
  }, [])

  const createChat = useCallback(async (): Promise<ChatRef> => {
    // Providers live in the global server config, so a fresh sandbox needs no
    // per-directory seeding — the model resolves everywhere.
    const { id, directory } = await window.mimo.createChatSandbox()
    const session = await window.mimo.createSession({ directory })
    const ref: ChatRef = {
      id,
      sessionID: session.id,
      title: "New chat",
      directory,
      mode: "chats",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    persist("chats", [ref, ...chatsRef.current])
    setCurrentSession(session.id)
    setActiveChatId(id)
    return ref
  }, [persist, setCurrentSession])

  const createCowork = useCallback(async (): Promise<ChatRef | null> => {
    let dir = taskerProjectDir ?? coworkDir
    if (!dir) {
      dir = await window.mimo.pickDirectory()
      if (!dir) return null
      setCoworkDir(dir)
    }
    await window.mimo.ensureProjectMarker(dir)
    const session = await window.mimo.createSession({ directory: dir })
    const ref: ChatRef = {
      id: uuid(),
      sessionID: session.id,
      title: "New task",
      directory: dir,
      mode: "cowork",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    persist("cowork", [ref, ...coworkRef.current])
    setCurrentSession(session.id)
    setActiveCoworkId(ref.id)
    // Refresh the sessions list for this directory so the new session appears
    fetchSessions(dir)
    return ref
  }, [taskerProjectDir, coworkDir, persist, setCurrentSession, fetchSessions])

  // Used when the user posts a prompt on the webagent tab with no session
  // selected (e.g. clicked a home-screen suggestion chip). Mirrors the
  // onNew dance the WebAgentMode sidebar uses, lifted here so sendPrompt
  // can auto-provision a webagent sandbox just like it does for chats/cowork.
  const createWebAgentSession = useCallback(async (): Promise<WebAgentRef> => {
    const sandbox = await window.mimo.webagentCreateSandbox()
    const session = await window.mimo.createSession({ directory: sandbox.directory, title: "New Web Agent" })
    const ref: WebAgentRef = {
      id: sandbox.id,
      sessionID: session.id,
      title: "New Web Agent",
      directory: sandbox.directory,
      mode: "webagent",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const updated = [ref, ...webAgentRef.current]
    webAgentRef.current = updated
    setWebAgentSessions(updated)
    await window.mimo.saveRegistry("webagent", updated)
    setActiveWebAgentId(ref.id)
    setCurrentSession(session.id)
    return ref
  }, [setCurrentSession])

  // Phase 1: Select a session from the project tree. Finds or creates the
  // matching ChatRef in the cowork registry so the existing useConversation
  // flow works unchanged.
  const handleSelectSession = useCallback((sessionID: string, directory: string) => {
    // Check if we already have a ChatRef for this sessionID
    const existing = coworkRef.current.find((c) => c.sessionID === sessionID)
    if (existing) {
      setActiveCoworkId(existing.id)
      setCoworkDir(directory)
      setCurrentSession(sessionID)
      return
    }
    // Create a new ChatRef entry for this session
    const sessions = sessionsByDir.get(directory) ?? []
    const sess = sessions.find((s) => s.id === sessionID)
    const ref: ChatRef = {
      id: uuid(),
      sessionID,
      title: sess?.title || "Untitled",
      directory,
      mode: "cowork",
      createdAt: sess?.time?.created ?? Date.now(),
      updatedAt: sess?.time?.updated ?? Date.now(),
    }
    persist("cowork", [ref, ...coworkRef.current])
    setActiveCoworkId(ref.id)
    setCoworkDir(directory)
    setCurrentSession(sessionID)
  }, [persist, sessionsByDir, setCurrentSession])

  // Pull the auto-generated title from MiMo after a turn — but only if the
  // local title is still the default/empty. We never overwrite a user rename.
  const refreshTitle = useCallback(
    async (ref: ChatRef) => {
      const sessions = await window.mimo.listSessions(ref.directory).catch(() => [])
      const s = sessions.find((x) => x.id === ref.sessionID)
      const serverTitle = s?.title?.trim()
      if (!serverTitle) return
      const list =
        ref.mode === "chats" ? chatsRef.current : ref.mode === "webagent" ? webAgentRef.current : coworkRef.current
      const local = list.find((c) => c.id === ref.id)
      // Skip if the user has already set a custom title (non-default, non-empty).
      if (local?.title && local.title !== "New chat" && local.title !== "New task") return
      const updated = list.map((c) =>
        c.id === ref.id ? { ...c, title: serverTitle, updatedAt: Date.now() } : c,
      )
      persist(ref.mode, updated)
    },
    [persist],
  )

  /* --------------------- complementary working dirs ----------------------- */
  // Per-session extra work dirs (Tasker): pre-approved by merging an
  // external_directory allow rule into the session's persisted permission
  // ruleset (evaluation is findLast, so a later "ask" rule reverts an allow).
  // The dir list itself lives on the ChatRef for display.
  const addExtraDir = useCallback(async () => {
    const ref = activeRef
    if (!ref || ref.mode !== "cowork") return
    const dir = await window.mimo.pickDirectory()
    if (!dir) return
    const norm = dir.replace(/[\\/]+$/, "")
    if (norm === ref.directory || (ref.extraDirs ?? []).includes(norm)) return
    try {
      await window.mimo.updateSessionPermission(
        ref.sessionID,
        [{ permission: "external_directory", pattern: norm + "/*", action: "allow" }],
        ref.directory,
      )
    } catch (e) {
      console.error("extra dir permission seed failed", e)
      return
    }
    persist("cowork", coworkRef.current.map((c) => (c.id === ref.id ? { ...c, extraDirs: [...(c.extraDirs ?? []), norm] } : c)))
  }, [activeRef, persist])

  const removeExtraDir = useCallback(async (dir: string) => {
    const ref = activeRef
    if (!ref || ref.mode !== "cowork") return
    // Appended "ask" rule wins over the earlier allow — prompts resume.
    await window.mimo
      .updateSessionPermission(
        ref.sessionID,
        [{ permission: "external_directory", pattern: dir + "/*", action: "ask" }],
        ref.directory,
      )
      .catch((e) => console.error("extra dir permission revert failed", e))
    persist("cowork", coworkRef.current.map((c) => (c.id === ref.id ? { ...c, extraDirs: (c.extraDirs ?? []).filter((d) => d !== dir) } : c)))
  }, [activeRef, persist])

  /* -------------------------------- actions ------------------------------- */
  const newChat = useCallback(() => setActiveChatId(null), [])
  const newCowork = useCallback(() => setActiveCoworkId(null), [])

  const sendPrompt = useCallback(
    async (text: string, files?: FileAttachment[]) => {
      setError(null)
      let ref = activeRef
      if (!ref) {
        try {
          ref = tab === "cowork" ? await createCowork()
            : tab === "webagent" ? await createWebAgentSession()
            : await createChat()
        } catch (e: any) {
          console.error("[sendPrompt] create failed:", e)
          setError(String(e?.message ?? e))
          return
        }
        if (!ref) return
      }
      const finalRef = ref
      let turnModel = model
      let turnVisionModel: ModelRef | undefined
      const atts = files ?? []
      const hasImageAtts = atts.some((f) => f.mime?.startsWith("image/"))
      if (hasImageAtts || hasHistoryImagesRef.current) {
        const on = await window.mimo.getSetting("visionRedirect").catch(() => null)
        const vm = (await window.mimo.getSetting("visionModel").catch(() => null)) as ModelRef | null
        if (on === true && vm?.providerID && vm?.modelID) turnModel = vm
      } else if (atts.some((f) => f.mime?.startsWith("audio/"))) {
        const on = await window.mimo.getSetting("audioRedirect").catch(() => null)
        const am = (await window.mimo.getSetting("audioModel").catch(() => null)) as ModelRef | null
        if (on === true && am?.providerID && am?.modelID) turnModel = am
      } else if (atts.some((f) => f.mime?.startsWith("video/"))) {
        const on = await window.mimo.getSetting("videoRedirect").catch(() => null)
        const vm2 = (await window.mimo.getSetting("videoModel").catch(() => null)) as ModelRef | null
        if (on === true && vm2?.providerID && vm2?.modelID) turnModel = vm2
      }
      // Vision redirect override: even when the active model wasn't swapped
      // above (e.g. because the user attached no image and no prior screenshot
      // exists in history yet), advertise the configured vision model to the
      // server. The server-side loop swaps to it mid-turn whenever an
      // image-bearing tool result (browser.screenshot) appears and the active
      // model can't read images — covering the in-flight screenshot turn that
      // the client-side hasHistoryImagesRef check can never catch in time.
      if (!turnModel || turnModel === model) {
        const on = await window.mimo.getSetting("visionRedirect").catch(() => null)
        if (on === true) {
          const vm = (await window.mimo.getSetting("visionModel").catch(() => null)) as ModelRef | null
          if (vm?.providerID && vm?.modelID) turnVisionModel = vm
        }
      }
      const slashMatch = text.match(/^\/(\S+)(?:\s+(.*))?$/s)
      if (slashMatch && !files?.length) {
        const cmdName = slashMatch[1]
        const cmdArgs = slashMatch[2] ?? ""
        const cmds = await window.mimo.getCommands(finalRef.directory).catch(() => [] as CommandInfo[])
        if (cmds.some((c) => c.name === cmdName)) {
          setBusy(true)
          try {
            await window.mimo.sendCommand({
              sessionID: finalRef.sessionID,
              command: cmdName,
              arguments: cmdArgs,
              model: turnModel ?? undefined,
              visionModel: turnVisionModel,
              agent: agentName ?? undefined,
              directory: finalRef.directory,
            })
          } catch (e: any) {
            console.error("[sendPrompt] sendCommand failed:", e)
            setError(String(e?.message ?? e))
            setBusy(false)
          }
          refreshTitle(finalRef)
          return
        }
      }
      setBusy(true)
      try {
        await window.mimo.prompt({
          sessionID: finalRef.sessionID,
          text: webSearch ? `${text}\n\n(You may use web search if helpful.)` : text,
          model: turnModel ?? undefined,
          visionModel: turnVisionModel,
          agent: tab === "webagent" ? "webagent" : agentName ?? undefined,
          directory: finalRef.directory,
          files,
        })
      } catch (e: any) {
        console.error("[sendPrompt] prompt failed:", e)
        setError(String(e?.message ?? e))
        setBusy(false)
      }
      refreshTitle(finalRef)
    },
    [activeRef, tab, createChat, createCowork, createWebAgentSession, webSearch, model, agentName, setBusy, setError, refreshTitle],
  )

  const abort = useCallback(() => {
    if (activeRef) window.mimo.abort(activeRef.sessionID, activeRef.directory).catch(() => {})
  }, [activeRef])

  // Replies must target the same directory (= MiMo instance) the request was
  // raised in. Cards only ever belong to the active session, so the active
  // directory is always the correct one — far more robust than trying to map
  // request id -> session -> dir in the main process (which breaks after a
  // restart, when restored sessions were never re-created there).
  const replyPermission = useCallback(
    (permissionID: string, reply: PermissionReply) => {
      window.mimo.replyPermission(permissionID, reply, activeDir ?? undefined).catch(() => {})
    },
    [activeDir],
  )

  const selectProject = useCallback(async (dir: string) => {
    setCoworkDir(dir)
    setActiveCoworkId(null)
    // Fetch sessions for this project if not already loaded
    if (!sessionsByDir.has(dir)) {
      fetchSessions(dir)
    }
  }, [fetchSessions, sessionsByDir])

  const addProject = useCallback(async () => {
    const d = await window.mimo.pickDirectory()
    if (!d) return
    await window.mimo.ensureProjectMarker(d)
    setCoworkDir(d)
    setActiveCoworkId(null)
    // Add to cowork registry so it persists
    const ref: ChatRef = {
      id: uuid(),
      sessionID: "",
      title: d.split(/[\\/]/).filter(Boolean).pop() ?? d,
      directory: d,
      mode: "cowork",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    persist("cowork", [ref, ...coworkRef.current])
    // Add to projects list immediately
    setProjects((prev) => {
      if (prev.some((p) => p.worktree === d)) return prev
      return [...prev, { id: "registry:" + d, worktree: d, time: { created: 0, updated: 0 } } as ProjectInfo]
    })
    // Fetch sessions for the new project
    fetchSessions(d)
  }, [persist, fetchSessions])

  const refreshProject = useCallback((dir: string) => {
    fetchSessions(dir)
  }, [fetchSessions])

  // Rename a project on the server via PATCH /project/:projectID
  const renameProject = useCallback(async (projectID: string, name: string) => {
    if (projectID.startsWith("registry:")) return // can't rename registry-only entries
    const res = await window.mimo.updateProject(projectID, { name }).catch((e) => { console.error("renameProject error:", e); return null })
    if (res) {
      setProjects((prev) => prev.map((p) => p.id === projectID ? { ...p, name } : p))
    }
  }, [])

  const pinProject = useCallback((dir: string) => {
    setPinnedDirs((prev) => {
      const n = new Set(prev)
      if (n.has(dir)) n.delete(dir)
      else n.add(dir)
      window.mimo.setSetting("pinnedProjectDirs", [...n]).catch(() => {})
      return n
    })
  }, [])

  const hideProject = useCallback((dir: string) => {
    // Remove from cowork registry (keeps files + server sessions intact)
    const list = coworkRef.current.filter((c) => c.directory !== dir)
    persist("cowork", list)
    // Remove from projects state
    setProjects((prev) => prev.filter((p) => p.worktree !== dir))
    // Remove from sessions cache
    setSessionsByDir((prev) => {
      const n = new Map(prev)
      n.delete(dir)
      return n
    })
    // Unpin if pinned
    setPinnedDirs((prev) => {
      const n = new Set(prev)
      n.delete(dir)
      window.mimo.setSetting("pinnedProjectDirs", [...n]).catch(() => {})
      return n
    })
    // Clear active if we hid the active project
    if (taskerProjectDir === dir) {
      setActiveCoworkId(null)
    }
  }, [persist, taskerProjectDir])

  const togglePin = useCallback((id: string) => {
    setFavoriteIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      window.mimo.setSetting("favoriteIds", [...next]).catch(() => {})
      return next
    })
  }, [])

  const renameChat = useCallback((id: string, title: string) => {
    const list = chatsRef.current.map((c) =>
      c.id === id ? { ...c, title } : c,
    )
    persist("chats", list)
    const ref = chatsRef.current.find((c) => c.id === id)
    if (ref) window.mimo.updateSession(ref.sessionID, title, ref.directory).catch(() => {})
  }, [persist])

  const renameCowork = useCallback((id: string, title: string) => {
    const list = coworkRef.current.map((c) =>
      c.id === id ? { ...c, title } : c,
    )
    persist("cowork", list)
    const ref = coworkRef.current.find((c) => c.id === id)
    if (ref) window.mimo.updateSession(ref.sessionID, title, ref.directory).catch(() => {})
  }, [persist])

  const deleteChat = useCallback((ref: ChatRef) => {
    const list = chatsRef.current.filter((c) => c.id !== ref.id)
    persist("chats", list)
    if (activeChatId === ref.id) setActiveChatId(null)
    window.mimo.deleteSandbox(ref.directory).catch(() => {})
  }, [persist, activeChatId])

  const deleteCowork = useCallback((ref: ChatRef) => {
    const list = coworkRef.current.filter((c) => c.id !== ref.id)
    persist("cowork", list)
    if (activeCoworkId === ref.id) setActiveCoworkId(null)
  }, [persist, activeCoworkId])

  // Phase 2: Delete cascade — delete session from server first, then remove
  // from local registry. If server delete fails, keep the entry.
  const handleDeleteSession = useCallback(async (sessionID: string, directory: string) => {
    const success = await window.mimo.deleteSession(sessionID, directory).catch(() => false)
    if (!success) {
      console.error("Failed to delete session on server:", sessionID)
      return
    }
    // Remove from cowork registry
    const list = coworkRef.current.filter((c) => c.sessionID !== sessionID)
    persist("cowork", list)
    // Remove from sessionsByDir cache
    setSessionsByDir((prev) => {
      const n = new Map(prev)
      const sessions = n.get(directory)
      if (sessions) n.set(directory, sessions.filter((s) => s.id !== sessionID))
      return n
    })
    // Clear active if we just deleted the active session
    const active = coworkRef.current.find((c) => c.sessionID === sessionID)
    if (active && activeCoworkId === active.id) {
      setActiveCoworkId(null)
    }
  }, [persist, activeCoworkId])

  const handleRenameSession = useCallback(async (sessionID: string, title: string, directory: string) => {
    await window.mimo.updateSession(sessionID, title, directory).catch(() => {})
    // Update cowork registry
    const list = coworkRef.current.map((c) => c.sessionID === sessionID ? { ...c, title } : c)
    persist("cowork", list)
    // Update sessionsByDir cache
    setSessionsByDir((prev) => {
      const n = new Map(prev)
      const sessions = n.get(directory)
      if (sessions) n.set(directory, sessions.map((s) => s.id === sessionID ? { ...s, title } : s))
      return n
    })
  }, [persist])

  const questionReply = useCallback((requestID: string, answers: string[][]) => {
    window.mimo.questionReply(requestID, answers, activeDir ?? undefined).catch((e) => { console.error("questionReply failed", e) })
  }, [activeDir])

  const questionReject = useCallback((requestID: string) => {
    window.mimo.questionReject(requestID, activeDir ?? undefined).catch(() => {})
  }, [activeDir])

  // Delete a single message from the server. The SSE stream will broadcast the
  // removal and update local state.
  const deleteMessage = useCallback(async (messageID: string) => {
    if (!activeSession || !activeDir) return
    await window.mimo.deleteMessage(activeSession, messageID, activeDir).catch((e) => console.error("deleteMessage failed", e))
  }, [activeSession, activeDir])

  // Regen: delete the last assistant message + its user prompt, then re-send the
  // same user text. Finds the user message immediately before this assistant msg.
  const regenMessage = useCallback(async (messageID: string) => {
    if (!activeRef || !model || !state.order.length) return
    const idx = state.order.indexOf(messageID)
    if (idx < 0) return
    // Walk backwards to find the user message that preceded this one
    let userIdx = idx - 1
    let userText = ""
    while (userIdx >= 0) {
      const prevId = state.order[userIdx]
      const prev = state.messages[prevId]
      if (prev.info.role === "user") {
        const texts = prev.parts.filter((p) => p.type === "text" && (p as any).text && !(p as any).synthetic)
        userText = texts.map((p) => (p as any).text).join("\n")
        break
      }
      userIdx--
    }
    if (!userText) return
    // Delete from the user message through to the end (including this assistant)
    const msgsToDelete = state.order.slice(userIdx)
    const serverDir = activeRef.directory
    for (const id of msgsToDelete) {
      const m = state.messages[id]
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch((e) => console.error("deleteMessage failed", e))
    }
    // Re-send the user's text
    setBusy(true)
    sendPrompt(userText)
  }, [activeRef, activeSession, sendPrompt, state.order, state.messages, model, setBusy])

  // Continue from here: delete all messages after and including this one
  const continueFrom = useCallback(async (messageID: string) => {
    if (!activeRef || !activeSession || !state.order.length) return
    const idx = state.order.indexOf(messageID)
    if (idx < 0) return
    const toDelete = state.order.slice(idx)
    const serverDir = activeRef.directory
    for (const id of toDelete) {
      const m = state.messages[id]
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch((e) => console.error("deleteMessage failed", e))
    }
  }, [activeRef, activeSession, state.order, state.messages])

  // Edit message: replace the user message text and re-send
  const editMessage = useCallback(async (messageID: string, newText: string) => {
    if (!activeRef || !activeSession || !state.order.length) return
    const idx = state.order.indexOf(messageID)
    if (idx < 0) return
    // Delete this user message and everything after
    const toDelete = state.order.slice(idx)
    const serverDir = activeRef.directory
    for (const id of toDelete) {
      const m = state.messages[id]
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch((e) => console.error("deleteMessage failed", e))
    }
    // Send the edited text
    sendPrompt(newText)
  }, [activeRef, activeSession, sendPrompt, state.order, state.messages])

  const compactSession = useCallback(async () => {
    if (!model || !activeSession || !activeDir) return
    const [resolvedModel] = await resolveCompactModel(model)
    setBusy(true)
    try {
      await window.mimo.summarizeSession(activeSession, resolvedModel.providerID, resolvedModel.modelID, activeDir)
    } catch (e) {
      setError("Compaction failed: " + (e instanceof Error ? e.message : String(e)))
    }
    setBusy(false)
  }, [model, activeSession, activeDir, setBusy, setError])

  // Resolve the compaction model: if compactRedirect is enabled and a compactModel
  // is set, use that; otherwise fall back to the active model. Returns the resolved
  // model and a boolean indicating whether a redirect was applied.
  const resolveCompactModel = useCallback(async (defaultModel: ModelRef): Promise<[ModelRef, boolean]> => {
    try {
      const redirect = await window.mimo.getSetting("compactRedirect")
      if (redirect !== true) return [defaultModel, false]
      const cm = (await window.mimo.getSetting("compactModel")) as { providerID?: string; modelID?: string } | null
      if (cm?.providerID && cm?.modelID) return [{ providerID: cm.providerID, modelID: cm.modelID }, true]
    } catch {}
    return [defaultModel, false]
  }, [])

  const clearSession = useCallback(async () => {
    if (tab === "chat") {
      await newChat()
      setActiveChatId(null)
    } else {
      await newCowork()
      setActiveCoworkId(null)
    }
  }, [tab, newChat, newCowork])

  

  const shared = {
    providers,
    agents,
    model,
    setModel: selectModel,
    agentName,
    setAgentName,
    webSearch,
    setWebSearch,
    compactThreshold,
    sessionID: activeSession,
    onCompact: compactSession,
    onClear: clearSession,
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <button
            className="brand-logo-btn"
            onClick={(e) => {
              e.stopPropagation()
              setBrandMenuOpen((v) => !v)
            }}
          >
            <span className="brand-logo" dangerouslySetInnerHTML={{ __html: ariaLogoRaw }} />
          </button>
          {brandMenuOpen && (
            <div className="brand-menu-overlay" onClick={() => setBrandMenuOpen(false)} />
          )}
          {brandMenuOpen && (
            <div className="brand-menu" onClick={() => setBrandMenuOpen(false)}>
              <button onClick={() => { setSettingsOpen(true) }}>Settings</button>
              <button onClick={() => location.reload()}>Reload</button>
              <button onClick={() => window.close()}>Quit</button>
            </div>
          )}
          <span className="brand-logo brand-logo-aria-text" dangerouslySetInnerHTML={{ __html: ariaTextRaw }} />
          <div className="tabs-pill">
            {(["chat", "cowork", "scheduler", "webagent"] as Tab[]).filter((t) => t !== "webagent" || webAgentMode).map((t) => (
              <button
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t === "chat" ? "Chat" : t === "cowork" ? "Tasker" : t === "scheduler" ? "Scheduler" : "Web Agent"}
              </button>
            ))}
          </div>
        </div>

        <div className="window-controls">
          <button className="window-btn minimize" onClick={() => window.mimo.minimizeWindow()} title="Minimize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="5.5" width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="window-btn maximize" onClick={() => window.mimo.maximizeWindow()} title="Maximize">
            <svg width="12" height="12" viewBox="0 0 12 12"><rect x="1" y="1" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
          </button>
          <button className="window-btn close" onClick={() => window.mimo.closeWindow()} title="Close to tray — Aria keeps running in the background">
            <svg width="12" height="12" viewBox="0 0 12 12"><line x1="1" y1="1" x2="11" y2="11" stroke="currentColor" strokeWidth="1.2"/><line x1="11" y1="1" x2="1" y2="11" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      <Splash
        status={status}
        ready={status.state === "ready" && dataLoaded}
        onCustomServer={() => setCustomServerOpen(true)}
      />

      {customServerOpen && <CustomServerModal onClose={() => setCustomServerOpen(false)} />}

      <div className="body">
        {tab === "chat" && (
          <ChatTab
            {...shared}
            chats={chats}
            activeId={activeChatId}
            onSelect={(r) => setActiveChatId(r.id)}
            onNew={newChat}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            state={state}
            onSend={sendPrompt}
            onAbort={abort}
            onReply={replyPermission}
            onOpenSettings={() => openSettings()}
            onManageSkills={() => openSettings("skills")}
            onManageConnectors={() => openSettings("connectors")}
            favoriteIds={favoriteIds}
            onPin={togglePin}
            onRename={renameChat}
            onDelete={deleteChat}
            onQuestionReply={questionReply}
            onQuestionReject={questionReject}
            onDeleteMessage={deleteMessage}
            onRegenMessage={regenMessage}
            onContinueFrom={continueFrom}
            onEditMessage={editMessage}
            onOpenFile={(p) => setViewerPath(p)}
            rightCollapsed={chatRightCollapsed}
            onToggleRight={() => setChatRightCollapsed((c) => !c)}
            greeting={genGreeting.chat ?? null}
            suggestions={genSuggest.chat ?? null}
            aiHome={aiGreetings || aiSuggestions}
            onRegenerate={regenerateHome}
          />
        )}
        {tab === "cowork" && (
          <TaskerTab
            {...shared}
            state={state}
            onSend={sendPrompt}
            onAbort={abort}
            workdirMain={activeRef?.mode === "cowork" ? activeRef.directory : null}
            workdirExtras={activeRef?.mode === "cowork" ? activeRef.extraDirs ?? [] : []}
            onAddWorkdir={addExtraDir}
            onRemoveWorkdir={removeExtraDir}
            onReply={replyPermission}
            onOpenFile={(p) => setViewerPath(p)}
            onOpenSettings={() => openSettings()}
            onManageSkills={() => openSettings("skills")}
            onManageConnectors={() => openSettings("connectors")}
            onQuestionReply={questionReply}
            onQuestionReject={questionReject}
            onDeleteMessage={deleteMessage}
            onRegenMessage={regenMessage}
            onContinueFrom={continueFrom}
            onEditMessage={editMessage}
            onNew={newCowork}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            rightCollapsed={coworkRightCollapsed}
            onToggleRight={() => setCoworkRightCollapsed((c) => !c)}
            greeting={genGreeting.cowork ?? null}
            suggestions={genSuggest.cowork ?? null}
            aiHome={aiGreetings || aiSuggestions}
            onRegenerate={regenerateHome}
            // Project dropdown
            projects={projects}
            selectedProjectDir={taskerProjectDir}
            onSelectProject={selectProject}
            onAddProject={addProject}
            projectsLoading={projectsLoading}
            // Tasker sidebar
            sessionsByDir={sessionsByDir}
            activeSessionId={activeRef?.sessionID ?? null}
            onSelectSession={handleSelectSession}
            onRefreshProject={refreshProject}
            onDeleteSession={handleDeleteSession}
            onRenameSession={handleRenameSession}
            onPinProject={pinProject}
            onHideProject={hideProject}
            pinnedDirs={pinnedDirs}
            registryDirs={coworkRef.current.map((c) => c.directory)}
            loadingDirs={loadingDirs}
            onRenameProject={renameProject}
          />
        )}
        {tab === "scheduler" && (
          <SchedulerMode
            onOpenSettings={() => openSettings()}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            collapsed={collapsed}
            rightCollapsed={schedulerRightCollapsed}
            onToggleRight={() => setSchedulerRightCollapsed((c) => !c)}
            greeting={genGreeting.scheduler ?? null}
            suggestions={genSuggest.scheduler ?? null}
            aiHome={aiGreetings || aiSuggestions}
            onRegenerate={regenerateHome}
          />
        )}
        {tab === "webagent" && (
          <WebAgentMode
            collapsed={collapsed}
            rightCollapsed={webAgentRightCollapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            onToggleRight={() => setWebAgentRightCollapsed((c) => !c)}
            state={state}
            onSend={sendPrompt}
            onAbort={abort}
            sessions={webAgentSessions}
            activeId={activeWebAgentId}
            onSelect={(ref) => setActiveWebAgentId(ref.id)}
            onNew={() => {
              // Don't pre-create a sandbox: just deselect so the hero /
              // empty-chat greeting screen is shown. The session is
              // provisioned lazily in sendPrompt -> createWebAgentSession
              // when the user actually sends the first message. Avoids
              // orphaned empty sandboxes accumulating in the sidebar when
              // the user clicks New then abandons.
              setActiveWebAgentId(null)
            }}
            onDelete={async (ref) => {
              await window.mimo.webagentDestroyView(ref.sessionID).catch(() => {})
              await window.mimo.deleteSession(ref.sessionID, ref.directory).catch(() => {})
              const updated = webAgentRef.current.filter((s) => s.id !== ref.id)
              webAgentRef.current = updated
              setWebAgentSessions(updated)
              await window.mimo.saveRegistry("webagent", updated)
              if (activeWebAgentId === ref.id) setActiveWebAgentId(null)
            }}
            onRename={async (id, title) => {
              const updated = webAgentRef.current.map((s) => (s.id === id ? { ...s, title, updatedAt: Date.now() } : s))
              webAgentRef.current = updated
              setWebAgentSessions(updated)
              await window.mimo.saveRegistry("webagent", updated)
            }}
            onOpenSettings={() => openSettings()}
            greeting={genGreeting.webagent ?? null}
            suggestions={genSuggest.webagent ?? null}
            aiHome={aiGreetings || aiSuggestions}
            onRegenerate={regenerateHome}
            providers={providers}
            model={model}
            onModelChange={selectModel}
          />
        )}
      </div>

      {settingsOpen && (
        <SettingsModal
          initialPage={settingsPage}
          providers={providers}
          model={model}
          directory={activeDir}
          onModelChange={selectModel}
          onRefreshProviders={refreshProviders}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      {viewerPath && <FileViewer path={viewerPath} onClose={() => setViewerPath(null)} />}

      {state.bashInteractiveRequest && ptyInfo && (
        <TerminalModal
          request={state.bashInteractiveRequest}
          ptyInfo={ptyInfo}
          onAbort={abortTerminal}
          onSendClose={sendCloseTerminal}
          onClose={closeTerminal}
        />
      )}
    </div>
  )
}

function sortByUpdated(items: ChatRef[]): ChatRef[] {
  return [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
