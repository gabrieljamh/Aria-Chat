import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import type { WebAgentRef, WebAgentState, ModelRef, ProvidersResponse } from "@shared/types"
import type { State } from "./types-internal"
import { MessageView } from "./MessageView"
import { Sidebar } from "./Sidebar"
import { IconRefresh, IconSend } from "./Icons"
import { useAutoScroll } from "./useAutoScroll"
import { useCustomModels } from "./customModels"
import { ModelSearchSelect } from "./ModelSearchSelect"
import { buildModelOptions } from "./modelOptions"
import type { Suggestion } from "./generate"

const STATIC_SUGGESTIONS: Suggestion[] = [
  { label: "Research a topic", text: "Research the latest news on a topic of your choice and summarize the key findings", desc: "Navigate search engines and gather information." },
  { label: "Compare two products", text: "Find and compare the top two laptops under $1500, including specs and reviews", desc: "Open multiple retailer pages and extract specs." },
  { label: "Fill out a form", text: "Go to a website and fill out a form with the details I provide", desc: "Automate repetitive form entry." },
  { label: "Monitor a page", text: "Open a news site and list the top 5 headlines right now", desc: "Extract the current top stories." },
]

interface Props {
  collapsed: boolean
  rightCollapsed: boolean
  onToggleCollapse: () => void
  onToggleRight: () => void
  state: State
  onSend: (text: string, files?: any[]) => void
  onAbort: () => void
  sessions: WebAgentRef[]
  activeId: string | null
  onSelect: (ref: WebAgentRef) => void
  onNew: () => void
  onDelete: (ref: WebAgentRef) => void
  onRename: (id: string, title: string) => void
  onOpenSettings: () => void
  greeting?: string | null
  suggestions?: Suggestion[] | null
  aiHome?: boolean
  onRegenerate?: () => void
  providers: ProvidersResponse | null
  model: ModelRef | null
  onModelChange: (m: ModelRef) => void
  // Per-session sidebar busy dot — threaded from App.
  isSessionBusy?: (sid: string | null) => boolean
}

/**
 * Web Agent mode, laid out like the other tabs: shared Sidebar on the left,
 * browser stage in the center (4:3 frame), agent chat on the right.
 */
export function WebAgentMode(props: Props) {
  const { collapsed, rightCollapsed, onToggleCollapse, onToggleRight, state, onSend } = props
  const [browserState, setBrowserState] = useState<WebAgentState>({ url: null, title: "", loading: false })
  const [urlInput, setUrlInput] = useState("")
  const [input, setInput] = useState("")
  const [autonomous, setAutonomous] = useState(true)
  const [zoom, setZoom] = useState(1)
  const viewportRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef<string | null>(null)

  const activeSession = props.sessions.find((s) => s.id === props.activeId) ?? null
  const agentActive = state.busy
  const noFavorites = useMemo(() => new Set<string>(), [])
  const suggestions = props.suggestions ?? STATIC_SUGGESTIONS
  const [prefill, setPrefill] = useState({ text: "", n: 0 })
  const applyPrefill = useCallback((text: string) => setPrefill((p) => ({ text, n: p.n + 1 })), [])

  // Hero / default screen: shown while no chat messages exist AND no real
  // browser URL is loaded (or saved on the session ref). Either threshold
  // flips dismisses the hero for the rest of the tab's lifetime — the user
  // has either started a conversation or the browser object is up. Saved
  // URLs count as "browser object is up" so a restart with a saved URL
  // skips the hero and lands straight on the page.
  const savedUrl = activeSession?.url ?? null
  const liveUrl = browserState.url
  const showHero = state.order.length === 0 && !liveUrl && !savedUrl

  const customModels = useCustomModels()
  const modelOptions = useMemo(
    () => buildModelOptions(props.providers, customModels),
    [props.providers, customModels],
  )

  const { scrollRef } = useAutoScroll([state.order, state.messages], {
    resetKey: activeSession?.sessionID ?? null,
    loading: state.loading,
  })

  useEffect(() => {
    const unsub = window.mimo.onWebagentEvent((event) => {
      if (event.type === "title" || event.type === "navigate" || event.type === "loading") {
        setBrowserState((prev) => ({
          url: event.url ?? prev.url,
          title: event.title ?? prev.title,
          loading: event.loading ?? prev.loading,
        }))
        if (event.url) setUrlInput(event.url)
      }
      // Keep the toolbar zoom % in sync when the agent zooms via browser_zoom.
      if (event.type === "zoom" && typeof event.zoom === "number" && event.sessionId === activeSession?.sessionID) {
        setZoom(event.zoom)
      }
      // Persist URL when browser navigates (e.g. user clicks a link)
      if (event.type === "navigate" && event.url) {
        const sid = activeSession?.sessionID
        if (sid && event.sessionId === sid) {
          window.mimo.webagentSessionSetUrl(activeSession!.id, event.url).catch(() => {})
        }
      }
    })
    return unsub
  }, [activeSession])

  // Keep the native BrowserView glued to the 4:3 frame. ResizeObserver only
  // fires on size changes, so also re-send on window resizes and layout
  // changes (sidebar/chat collapse) that shift the frame without resizing it.
  const sendBounds = useCallback(() => {
    const el = viewportRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      window.mimo.webagentSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    }
  }, [])

  // showHero in the deps is essential: the .webagent-frame element only exists
  // when the hero is NOT shown, so this must RE-RUN when the hero dismisses to
  // attach the observer to the freshly-mounted frame and send its bounds.
  // Without it the effect ran once at mount (frame null → early return) and the
  // BrowserView was never positioned — the page rendered at 0×0 (invisible).
  useEffect(() => {
    if (showHero || !viewportRef.current) return
    // Frame just mounted — position the view now, then keep it glued.
    sendBounds()
    const ro = new ResizeObserver(sendBounds)
    ro.observe(viewportRef.current)
    window.addEventListener("resize", sendBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", sendBounds)
    }
  }, [sendBounds, showHero])

  useEffect(() => {
    // Layout shifted (columns collapsed/expanded): reposition after paint.
    if (showHero) return
    const t = setTimeout(sendBounds, 50)
    return () => clearTimeout(t)
  }, [collapsed, rightCollapsed, sendBounds, showHero])

  // Track whether the hero OR any modal/overlay is suppressing the native
  // BrowserView. The MutationObserver and the hero effect both feed this ref.
  const hiddenByHeroRef = useRef(false)
  const hiddenByOverlayRef = useRef(false)

  useEffect(() => {
    // While the hero / default screen is shown the native BrowserView
    // (about:blank on a fresh session) would paint over it. Pin it hidden
    // for the lifetime of the hero, restore on dismiss.
    hiddenByHeroRef.current = showHero
    const next = showHero || hiddenByOverlayRef.current
    window.mimo.webagentSetHidden(next).catch(() => {})
    return () => {
      hiddenByHeroRef.current = false
      const next = hiddenByOverlayRef.current
      window.mimo.webagentSetHidden(next).catch(() => {})
    }
  }, [showHero])

  // Native BrowserViews render above ALL renderer DOM — settings modal, delete
  // confirmations, context menus would appear underneath the page. Watch the
  // DOM for overlay elements and hide the view while any is open.
  useEffect(() => {
    const OVERLAYS =
      ".modal-overlay, .ctx-overlay, .rename-overlay, .terminal-modal-overlay, " +
      ".brand-menu-overlay, .model-editor-overlay, .scheduler-editor-overlay, " +
      ".attach-preview-overlay, .settings-modal, .cs-modal, .provider-modal"
    let raf = 0
    const check = () => {
      raf = 0
      const shouldHide = document.querySelector(OVERLAYS) != null
      if (shouldHide !== hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = shouldHide
        const next = shouldHide || hiddenByHeroRef.current
        window.mimo.webagentSetHidden(next).catch(() => {})
      }
    }
    const mo = new MutationObserver(() => {
      if (!raf) raf = requestAnimationFrame(check)
    })
    mo.observe(document.body, { childList: true, subtree: true })
    check()
    return () => {
      mo.disconnect()
      if (raf) cancelAnimationFrame(raf)
      if (hiddenByOverlayRef.current) {
        hiddenByOverlayRef.current = false
        const next = hiddenByHeroRef.current
        window.mimo.webagentSetHidden(next).catch(() => {})
      }
    }
  }, [])

  useEffect(() => {
    const sid = activeSession?.sessionID ?? null
    if (attachedRef.current && attachedRef.current !== sid) {
      window.mimo.webagentDetachView(attachedRef.current).catch(() => {})
      attachedRef.current = null
    }
    if (sid) {
      window.mimo.webagentAttachView(sid).catch(() => {})
      attachedRef.current = sid
      window.mimo.webagentGetState(sid).then((st) => {
        setBrowserState(st)
        setUrlInput(st.url ?? "")
      })
      // Auto-navigate to saved URL if browser is on about:blank
      if (activeSession?.url) {
        window.mimo.webagentNavigate(sid, activeSession.url).catch(() => {})
      }
    } else {
      // No active session (New button, or session deleted): clear stale
      // browser state so showHero can flip back to true instead of being
      // pinned false by the previously-attached session's URL.
      setBrowserState({ url: null, title: "", loading: false })
      setUrlInput("")
    }
    return () => {
      if (attachedRef.current) {
        window.mimo.webagentDetachView(attachedRef.current).catch(() => {})
        attachedRef.current = null
      }
    }
  }, [activeSession?.sessionID])

  useEffect(() => {
    if (prefill.text) {
      setInput(prefill.text)
      setPrefill({ text: "", n: 0 })
    }
  }, [prefill])

  const navigate = useCallback(async (url: string) => {
    if (!activeSession) return
    let fullUrl = url.trim()
    if (!fullUrl) return
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      fullUrl = "https://" + fullUrl
    }
    await window.mimo.webagentNavigate(activeSession.sessionID, fullUrl)
    setUrlInput(fullUrl)
    window.mimo.webagentSessionSetUrl(activeSession.id, fullUrl).catch(() => {})
  }, [activeSession])

  const sendPrompt = useCallback(() => {
    if (!input.trim()) return
    onSend(input.trim())
    setInput("")
  }, [input, onSend])

  // Reflect the active session's remembered zoom in the toolbar when switching.
  useEffect(() => {
    const sid = activeSession?.sessionID
    if (!sid) {
      setZoom(1)
      return
    }
    window.mimo.webagentGetZoom(sid).then(setZoom).catch(() => setZoom(1))
  }, [activeSession])

  const changeZoom = useCallback(
    (opts: { factor?: number; direction?: "in" | "out" | "reset" }) => {
      const sid = activeSession?.sessionID
      if (!sid) return
      window.mimo.webagentSetZoom(sid, opts).then(setZoom).catch(() => {})
    },
    [activeSession],
  )

  const composer = (
    <div className="composer-wrap webagent-composer-wrap">
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              sendPrompt()
            }
          }}
          placeholder="Tell the agent what to do..."
          rows={2}
        />
        <div className="composer-footer">
          <div className="spacer" />
          {state.busy ? (
            <button className="send-btn" onClick={props.onAbort} title="Stop">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <rect x="5" y="5" width="14" height="14" rx="2" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              onClick={sendPrompt}
              disabled={!input.trim()}
              title="Send"
            >
              <IconSend size={15} />
            </button>
          )}
        </div>
      </div>
    </div>
  )

  const modelSelector = modelOptions.length > 0 ? (
    <div className="webagent-model-select">
      <ModelSearchSelect
        value={props.model ? `${props.model.providerID}/${props.model.modelID}` : ""}
        options={modelOptions.map((o) => ({ value: `${o.providerID}/${o.modelID}`, label: o.label }))}
        onChange={(v) => {
          const [providerID, ...rest] = v.split("/")
          props.onModelChange({ providerID, modelID: rest.join("/") })
        }}
        placeholder="Model"
      />
    </div>
  ) : null

  return (
    <>
      <Sidebar
        favoriteIds={noFavorites}
        newLabel="New session"
        items={props.sessions}
        activeId={props.activeId}
        onSelect={(ref) => props.onSelect(ref as WebAgentRef)}
        onNew={props.onNew}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        emptyText="No web sessions yet"
        onOpenSettings={props.onOpenSettings}
        onPin={() => {}}
        showPin={false}
        onRename={props.onRename}
        onDelete={(ref) => props.onDelete(ref as WebAgentRef)}
        deleteMessage="This will permanently remove this Web Agent session and its sandbox."
        isSessionBusy={props.isSessionBusy}
      />

      <main className="main">
        {showHero ? (
          <div className="greeting greeting-webagent greeting-webagent-full">
            <h1>
              {props.greeting ? (
                <>
                  <span className="accent">✻</span> {props.greeting}
                </>
              ) : (
                <>
                  <span className="accent">✻</span> Where should the agent browse?
                </>
              )}
            </h1>
            {activeSession && (
              <p className="webagent-hero-hint">Send the agent its first instruction to wake the browser.</p>
            )}
            {modelSelector && <div className="webagent-hero-model">{modelSelector}</div>}
            <div className="chips">
              {suggestions.map((sug, i) => (
                <button
                  key={sug.label + i}
                  className="chip"
                  title={sug.text}
                  onClick={() => applyPrefill(sug.text)}
                >
                  {sug.label}
                </button>
              ))}
            </div>
            {props.aiHome && (
              <button className="regen-btn" onClick={props.onRegenerate} title="Regenerate with AI">
                <IconRefresh size={13} /> Regenerate
              </button>
            )}
            <div className="webagent-hero-composer">{composer}</div>
          </div>
        ) : (
          <>
            <div className="webagent-bar">
              <button
                className="webagent-nav-btn"
                onClick={() => navigate(browserState.url ?? "")}
                title="Reload"
                disabled={!activeSession}
              >
                <IconRefresh size={14} />
              </button>
              <input
                className="webagent-url-input"
                type="text"
                value={urlInput}
                placeholder={activeSession ? "Enter URL or search..." : "Create or select a session to browse"}
                onChange={(e) => setUrlInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && navigate(urlInput)}
                disabled={!activeSession}
              />
              <div className="webagent-zoom" title="Page zoom">
                <button
                  className="webagent-nav-btn"
                  onClick={() => changeZoom({ direction: "out" })}
                  disabled={!activeSession}
                  title="Zoom out"
                >
                  −
                </button>
                <button
                  className="webagent-zoom-label"
                  onClick={() => changeZoom({ direction: "reset" })}
                  disabled={!activeSession}
                  title="Reset zoom to 100%"
                >
                  {Math.round(zoom * 100)}%
                </button>
                <button
                  className="webagent-nav-btn"
                  onClick={() => changeZoom({ direction: "in" })}
                  disabled={!activeSession}
                  title="Zoom in"
                >
                  +
                </button>
              </div>
              <div className="webagent-status">
                <div className={`webagent-status-dot ${agentActive ? "working" : "idle"}`} />
                <span>{agentActive ? "Agent working" : "Your control"}</span>
              </div>
              {rightCollapsed && (
                <button className="webagent-nav-btn" onClick={onToggleRight} title="Show agent chat">
                  «
                </button>
              )}
            </div>

            <div className="webagent-stage">
              <div className="webagent-frame" ref={viewportRef}>
                {activeSession && agentActive && <div className="webagent-control-lock" />}
                {!activeSession && (
                  <div className="webagent-empty">
                    <p>No active Web Agent session</p>
                    <p>Create a new session to start browsing</p>
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </main>

      {!rightCollapsed && (
        <aside className="webagent-chat">
          <div className="webagent-chat-head">
            <span className="webagent-chat-title">Agent</span>
            <label className="webagent-autonomous" title="Let the agent browse without asking between steps">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              Autonomous
            </label>
            {modelSelector}
            <button className="webagent-nav-btn" onClick={onToggleRight} title="Hide agent chat">
              »
            </button>
          </div>

          <div className="conversation webagent-conversation" ref={scrollRef}>
            <div className="conversation-inner">
              {state.order.map((id) => {
                const msg = state.messages[id]
                if (!msg) return null
                return <MessageView key={id} message={msg} showDots={state.busy} busy={state.busy} />
              })}
              {state.order.length === 0 && (
                <div className="webagent-chat-empty">
                  {activeSession ? (
                    <>
                      <p className="webagent-chat-hint">Tell the agent what to do below.</p>
                      <div className="chips chips-sm">
                        {suggestions.map((sug, i) => (
                          <button
                            key={sug.label + i}
                            className="chip"
                            title={sug.text}
                            onClick={() => applyPrefill(sug.text)}
                          >
                            {sug.label}
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    "Select a session to view its conversation."
                  )}
                </div>
              )}
              {state.error && <div className="status-banner error">{state.error}</div>}
            </div>
          </div>

          {composer}
        </aside>
      )}
    </>
  )
}
