import { useEffect, useRef, useState, useCallback } from "react"
import type { WebAgentRef, WebAgentState } from "@shared/types"
import type { State } from "./types-internal"
import { MessageView } from "./MessageView"
import { IconPlus, IconRefresh, IconTrash } from "./Icons"

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
}

export function WebAgentMode(props: Props) {
  const { collapsed, rightCollapsed, onToggleCollapse, onToggleRight, state, onSend } = props
  const [browserState, setBrowserState] = useState<WebAgentState>({ url: null, title: "", loading: false })
  const [urlInput, setUrlInput] = useState("")
  const [input, setInput] = useState("")
  const [autonomous, setAutonomous] = useState(true)
  const viewportRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const attachedRef = useRef<string | null>(null)

  const activeSession = props.sessions.find((s) => s.id === props.activeId) ?? null
  const agentActive = state.busy

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
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!viewportRef.current) return
    const ro = new ResizeObserver(() => {
      if (!viewportRef.current) return
      const rect = viewportRef.current.getBoundingClientRect()
      if (rect.width > 0 && rect.height > 0) {
        window.mimo.webagentSetBounds({
          x: Math.round(rect.left),
          y: Math.round(rect.top),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        })
      }
    })
    ro.observe(viewportRef.current)
    return () => ro.disconnect()
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
    }
    return () => {
      if (attachedRef.current) {
        window.mimo.webagentDetachView(attachedRef.current).catch(() => {})
        attachedRef.current = null
      }
    }
  }, [activeSession?.sessionID])

  const selectSession = useCallback(async (session: WebAgentRef) => {
    props.onSelect(session)
  }, [props])

  const navigate = useCallback(async (url: string) => {
    if (!activeSession) return
    let fullUrl = url.trim()
    if (!fullUrl) return
    if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://")) {
      fullUrl = "https://" + fullUrl
    }
    await window.mimo.webagentNavigate(activeSession.sessionID, fullUrl)
    setUrlInput(fullUrl)
  }, [activeSession])

  const sendPrompt = useCallback(() => {
    if (!input.trim()) return
    onSend(input.trim())
    setInput("")
  }, [input, onSend])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.order, state.messages])

  return (
    <div className="webagent-layout">
      {!collapsed && (
        <div className="webagent-sidebar">
          <div className="webagent-sidebar-header">
            <button className="webagent-new-btn" onClick={props.onNew}>
              <IconPlus /> New
            </button>
          </div>
          <div className="webagent-session-list">
            {props.sessions.map((s) => (
              <div
                key={s.id}
                className={`webagent-session-card ${props.activeId === s.id ? "active" : ""}`}
                onClick={() => selectSession(s)}
              >
                <div className="webagent-session-title">{s.title || "New Web Agent"}</div>
                {s.url && <div className="webagent-session-url">{s.url}</div>}
                <div className="webagent-session-time">{new Date(s.updatedAt).toLocaleDateString()}</div>
                <button
                  className="webagent-session-delete"
                  onClick={(e) => { e.stopPropagation(); props.onDelete(s) }}
                  title="Delete session"
                >
                  <IconTrash size={12} />
                </button>
              </div>
            ))}
          </div>
          <button className="webagent-collapse-btn" onClick={onToggleCollapse} title="Collapse sidebar">
            ☰
          </button>
        </div>
      )}

      <div className="webagent-center">
        <div className="webagent-bar">
          <button
            className="webagent-nav-btn"
            onClick={() => activeSession && window.mimo.webagentGetState(activeSession.sessionID)}
            title="Back"
            disabled={!activeSession}
          >
            ←
          </button>
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
            placeholder="Enter URL or search..."
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && navigate(urlInput)}
            disabled={!activeSession}
          />
          <div className="webagent-status">
            <div className={`webagent-status-dot ${agentActive ? "working" : "idle"}`} />
            <span>{agentActive ? "Agent working" : "Your control"}</span>
          </div>
        </div>

        <div className="webagent-viewport" ref={viewportRef}>
          {activeSession && agentActive && <div className="webagent-control-lock" />}
          {!activeSession && (
            <div className="webagent-empty">
              <p>No active Web Agent session</p>
              <p>Create a new session to start browsing</p>
            </div>
          )}
        </div>
      </div>

      {!rightCollapsed && (
        <div className="webagent-chat">
          <div className="webagent-chat-header">
            <button onClick={onToggleCollapse} title="Toggle sidebar">☰</button>
            <label className="webagent-autonomous">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              Autonomous
            </label>
            <button onClick={onToggleRight} title="Collapse chat">→</button>
          </div>
          <div className="webagent-message-list" ref={scrollRef}>
            {state.order.map((id) => {
              const msg = state.messages[id]
              if (!msg) return null
              return <MessageView key={id} message={msg} />
            })}
            {!activeSession && <div className="webagent-chat-empty">Select a session to view conversation</div>}
          </div>
          <div className="webagent-composer">
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
              rows={3}
              disabled={!activeSession}
            />
            <button onClick={sendPrompt} disabled={!activeSession || !input.trim()}>
              Send
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
