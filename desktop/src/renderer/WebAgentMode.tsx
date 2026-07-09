import { useEffect, useRef, useState, useCallback, useMemo } from "react"
import type { WebAgentRef, WebAgentState } from "@shared/types"
import type { State } from "./types-internal"
import { MessageView } from "./MessageView"
import { Sidebar } from "./Sidebar"
import { IconRefresh, IconSend } from "./Icons"
import { useAutoScroll } from "./useAutoScroll"

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
  const viewportRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef<string | null>(null)

  const activeSession = props.sessions.find((s) => s.id === props.activeId) ?? null
  const agentActive = state.busy
  const noFavorites = useMemo(() => new Set<string>(), [])

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

  useEffect(() => {
    if (!viewportRef.current) return
    const ro = new ResizeObserver(sendBounds)
    ro.observe(viewportRef.current)
    window.addEventListener("resize", sendBounds)
    return () => {
      ro.disconnect()
      window.removeEventListener("resize", sendBounds)
    }
  }, [sendBounds])

  useEffect(() => {
    // Layout shifted (columns collapsed/expanded): reposition after paint.
    const t = setTimeout(sendBounds, 50)
    return () => clearTimeout(t)
  }, [collapsed, rightCollapsed, sendBounds])

  // Native BrowserViews render above ALL renderer DOM — settings modal, delete
  // confirmations, context menus would appear underneath the page. Watch the
  // DOM for overlay elements and hide the view while any is open.
  useEffect(() => {
    const OVERLAYS =
      ".modal-overlay, .ctx-overlay, .rename-overlay, .terminal-modal-overlay, " +
      ".brand-menu-overlay, .model-editor-overlay, .scheduler-editor-overlay, " +
      ".attach-preview-overlay, .settings-modal, .cs-modal, .provider-modal"
    let hidden = false
    let raf = 0
    const check = () => {
      raf = 0
      const shouldHide = document.querySelector(OVERLAYS) != null
      if (shouldHide !== hidden) {
        hidden = shouldHide
        window.mimo.webagentSetHidden(shouldHide).catch(() => {})
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
      if (hidden) window.mimo.webagentSetHidden(false).catch(() => {})
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
    }
    return () => {
      if (attachedRef.current) {
        window.mimo.webagentDetachView(attachedRef.current).catch(() => {})
        attachedRef.current = null
      }
    }
  }, [activeSession?.sessionID])

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
      />

      <main className="main">
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
      </main>

      {!rightCollapsed && (
        <aside className="webagent-chat">
          <div className="webagent-chat-head">
            <span className="webagent-chat-title">Agent</span>
            <label className="webagent-autonomous" title="Let the agent browse without asking between steps">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              Autonomous
            </label>
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
                  {activeSession ? "Tell the agent what to do below." : "Select a session to view its conversation."}
                </div>
              )}
              {state.error && <div className="status-banner error">{state.error}</div>}
            </div>
          </div>

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
                disabled={!activeSession}
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
                    disabled={!activeSession || !input.trim()}
                    title="Send"
                  >
                    <IconSend size={15} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      )}
    </>
  )
}
