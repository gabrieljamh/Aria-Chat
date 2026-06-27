import React, { useCallback, useEffect, useMemo, useRef, useState } from "react"
import type {
  AgentInfo,
  ChatRef,
  ModelRef,
  PermissionReply,
  ProvidersResponse,
  RegistryKind,
  ServerStatus,
} from "@shared/types"
import { useConversation } from "./useConversation"
import { ChatTab } from "./ChatTab"
// TaskerTab is the renamed CoworkTab (old internal name: "cowork")
import { TaskerTab } from "./TaskerTab"
import { SettingsModal } from "./SettingsModal"
import { FileViewer } from "./FileViewer"
import { Splash } from "./Splash"
import { CustomServerModal } from "./CustomServerModal"
import { generateGreeting, generateSuggestions, type Suggestion } from "./generate"
import type { FileAttachment } from "@shared/types"

import ariaLogo from "@shared/img/aria-logo.png"
import ariaText from "@shared/img/aria-text.png"

type Tab = "chat" | "cowork" // "cowork" = Tasker mode internal key

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

export function App() {
  const [tab, setTab] = useState<Tab>("chat")
  const [status, setStatus] = useState<ServerStatus>({ state: "starting" })
  const [providers, setProviders] = useState<ProvidersResponse | null>(null)
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [model, setModel] = useState<ModelRef | null>(null)
  const [agentName, setAgentName] = useState<string | null>(null)
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
  // AI-generated home-screen content (per tab, cached for the app session).
  const [aiGreetings, setAiGreetings] = useState(false)
  const [aiSuggestions, setAiSuggestions] = useState(false)
  const [genGreeting, setGenGreeting] = useState<{ chat?: string; cowork?: string }>({})
  const [genSuggest, setGenSuggest] = useState<{ chat?: Suggestion[]; cowork?: Suggestion[] }>({})
  const genInflight = useRef<Set<string>>(new Set())
  const [viewerPath, setViewerPath] = useState<string | null>(null)
  const [brandMenuOpen, setBrandMenuOpen] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<Set<string>>(new Set())

  // registries
  const [chats, setChats] = useState<ChatRef[]>([])
  const [cowork, setCowork] = useState<ChatRef[]>([])
  const [activeChatId, setActiveChatId] = useState<string | null>(null)
  const [activeCoworkId, setActiveCoworkId] = useState<string | null>(null)
  const [coworkDir, setCoworkDir] = useState<string | null>(null)

  // Synchronous mirrors of the registries. React state updates are async, so
  // within one async action (create chat -> send -> refresh title) reading the
  // state closure would be stale and could clobber the registry. The refs are
  // updated synchronously by `persist`, so every step sees the latest list.
  const chatsRef = useRef<ChatRef[]>([])
  const coworkRef = useRef<ChatRef[]>([])

  const activeRef: ChatRef | null = useMemo(() => {
    if (tab === "chat") return chats.find((c) => c.id === activeChatId) ?? null
    if (tab === "cowork") return cowork.find((c) => c.id === activeCoworkId) ?? null
    return null
  }, [tab, chats, cowork, activeChatId, activeCoworkId])

  const activeSession = activeRef?.sessionID ?? null
  const activeDir = activeRef?.directory ?? null

  const { state, setBusy, setError, setCurrentSession } = useConversation(activeSession, activeDir, activeRef?.createdAt)

  /* ----------------------------- server status ---------------------------- */
  useEffect(() => {
    window.mimo.getServerStatus().then(setStatus)
    return window.mimo.onServerStatus(setStatus)
  }, [])

  useEffect(() => {
    window.mimo.getSetting("aiGreetings").then((v) => setAiGreetings(v === true))
    window.mimo.getSetting("aiSuggestions").then((v) => setAiSuggestions(v === true))
  }, [])

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
    const kind: "chat" | "cowork" | null =
      tab === "chat" && activeChatId === null ? "chat" : tab === "cowork" && activeCoworkId === null ? "cowork" : null
    if (!kind) return
    if (aiGreetings && genGreeting[kind] === undefined && !genInflight.current.has("g-" + kind)) {
      genInflight.current.add("g-" + kind)
      ;(async () => {
        const hm = await resolveHomeModel()
        generateGreeting(kind, model, agentName, hm)
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
  }, [status.state, tab, activeChatId, activeCoworkId, aiGreetings, aiSuggestions, model, agentName, genGreeting, genSuggest])

  /* ----------------------- initial load on ready -------------------------- */
  useEffect(() => {
    if (status.state !== "ready") {
      setDataLoaded(false)
      return
    }
    let cancelled = false
    ;(async () => {
      const [chatList, coworkList, provs, ags] = await Promise.all([
        window.mimo.getRegistry("chats").catch(() => []),
        window.mimo.getRegistry("cowork").catch(() => []),
        window.mimo.getProviders().catch(() => null),
        window.mimo.getAgents().catch(() => []),
      ])
      if (cancelled) return
      const sortedChats = sortByUpdated(chatList)
      const sortedCowork = sortByUpdated(coworkList)
      chatsRef.current = sortedChats
      coworkRef.current = sortedCowork
      setChats(sortedChats)
      setCowork(sortedCowork)
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
      setDataLoaded(true)
    })()
    return () => {
      cancelled = true
    }
  }, [status.state])

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
    const kind: "chat" | "cowork" = tab === "cowork" ? "cowork" : "chat"
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
    let dir = coworkDir
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
    return ref
  }, [coworkDir, persist, setCurrentSession])

  // Pull the auto-generated title from MiMo after a turn and store it.
  const refreshTitle = useCallback(
    async (ref: ChatRef) => {
      const sessions = await window.mimo.listSessions(ref.directory).catch(() => [])
      const s = sessions.find((x) => x.id === ref.sessionID)
      const title = s?.title?.trim()
      const list = ref.mode === "chats" ? chatsRef.current : coworkRef.current
      const updated = list.map((c) =>
        c.id === ref.id ? { ...c, title: title || c.title, updatedAt: Date.now() } : c,
      )
      persist(ref.mode, updated)
    },
    [persist],
  )

  /* -------------------------------- actions ------------------------------- */
  const newChat = useCallback(() => setActiveChatId(null), [])
  const newCowork = useCallback(() => setActiveCoworkId(null), [])

  const sendPrompt = useCallback(
    async (text: string, files?: FileAttachment[]) => {
      setError(null)
      let ref = activeRef
      if (!ref) {
        try {
          ref = tab === "cowork" ? await createCowork() : await createChat()
        } catch (e: any) {
          console.error("[sendPrompt] create failed:", e)
          setError(String(e?.message ?? e))
          return
        }
        if (!ref) return
      }
      const finalRef = ref
      // If this turn carries an image and the user enabled redirect, send it to
      // the configured vision model instead of the active one (just this turn).
      let turnModel = model
      const atts = files ?? []
      if (atts.some((f) => f.mime?.startsWith("image/"))) {
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
      setBusy(true)
      try {
        await window.mimo.prompt({
          sessionID: finalRef.sessionID,
          text: webSearch ? `${text}\n\n(You may use web search if helpful.)` : text,
          model: turnModel ?? undefined,
          agent: agentName ?? undefined,
          directory: finalRef.directory,
          files,
        })
      } catch (e: any) {
        console.error("[sendPrompt] prompt failed:", e)
        setError(String(e?.message ?? e))
      } finally {
        setBusy(false)
      }
      refreshTitle(finalRef)
    },
    [activeRef, tab, createChat, createCowork, webSearch, model, agentName, setBusy, setError, refreshTitle],
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

  const pickProject = useCallback(async () => {
    const d = await window.mimo.pickDirectory()
    if (d) {
      setCoworkDir(d)
      setActiveCoworkId(null) // start a fresh task in the new project
    }
  }, [])

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
    if (!activeRef || !state.order.length) return
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
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch(() => {})
    }
    // Re-send the user's text
    sendPrompt(userText)
  }, [activeRef, activeSession, sendPrompt, state.order, state.messages])

  // Continue from here: delete all messages after and including this one
  const continueFrom = useCallback(async (messageID: string) => {
    if (!activeRef || !activeSession || !state.order.length) return
    const idx = state.order.indexOf(messageID)
    if (idx < 0) return
    const toDelete = state.order.slice(idx)
    const serverDir = activeRef.directory
    for (const id of toDelete) {
      const m = state.messages[id]
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch(() => {})
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
      if (m) await window.mimo.deleteMessage(activeSession!, m.info.id, serverDir).catch(() => {})
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
            <img className="brand-logo" src={ariaLogo} alt="Aria" />
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
          <img className="brand-logo brand-logo-aria-text" src={ariaText} alt="Aria" />
          <div className="tabs-pill">
            {(["chat", "cowork"] as Tab[]).map((t) => (
              <button
                key={t}
                className={tab === t ? "active" : ""}
                onClick={() => setTab(t)}
              >
                {t === "chat" ? "Chat" : "Tasker"}
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
          <button className="window-btn close" onClick={() => window.mimo.closeWindow()} title="Close">
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
            items={cowork}
            activeId={activeCoworkId}
            onSelect={(r) => {
              setActiveCoworkId(r.id)
              setCoworkDir(r.directory)
            }}
            onNew={newCowork}
            collapsed={collapsed}
            onToggleCollapse={() => setCollapsed((c) => !c)}
            projectDir={activeRef?.directory ?? coworkDir}
            onPickProject={pickProject}
            state={state}
            onSend={sendPrompt}
            onAbort={abort}
            onReply={replyPermission}
            onOpenFile={(p) => setViewerPath(p)}
            onOpenSettings={() => openSettings()}
            onManageSkills={() => openSettings("skills")}
            onDelete={deleteCowork}
            onQuestionReply={questionReply}
            onQuestionReject={questionReject}
            onDeleteMessage={deleteMessage}
            onRegenMessage={regenMessage}
            onContinueFrom={continueFrom}
            onEditMessage={editMessage}
            rightCollapsed={coworkRightCollapsed}
            onToggleRight={() => setCoworkRightCollapsed((c) => !c)}
            greeting={genGreeting.cowork ?? null}
            suggestions={genSuggest.cowork ?? null}
            aiHome={aiGreetings || aiSuggestions}
            onRegenerate={regenerateHome}
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
    </div>
  )
}

function sortByUpdated(items: ChatRef[]): ChatRef[] {
  return [...items].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}
