import { useEffect, useState, useRef, useCallback } from "react"
import type { WebAgentRef, WebAgentState, WebAgentEvent, PromptInput } from "@shared/types"
import { IconPlus, IconRefresh, IconTrash } from "./Icons"

type Props = {
  collapsed: boolean
  rightCollapsed: boolean
  onToggleCollapse: () => void
  onToggleRight: () => void
}

export function WebAgentMode({ collapsed, rightCollapsed, onToggleCollapse, onToggleRight }: Props) {
  const [sessions, setSessions] = useState<WebAgentRef[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [browserState, setBrowserState] = useState<WebAgentState>({ url: null, title: "", loading: false })
  const [urlInput, setUrlInput] = useState("")
  const [agentActive, setAgentActive] = useState(false)
  const [autonomous, setAutonomous] = useState(true)
  const [messages, setMessages] = useState<Record<string, any[]>>({})
  const [input, setInput] = useState("")
  const viewportRef = useRef<HTMLDivElement>(null)
  const pollingRef = useRef<Set<string>>(new Set())

  const activeSession = sessions.find((s) => s.id === activeId)

  const loadSessions = useCallback(async () => {
    const items = await window.mimo.getRegistry("webagent")
    setSessions(items as WebAgentRef[])
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    const unsub = window.mimo.onWebagentEvent((event) => {
      if (event.type === "title" || event.type === "navigate" || event.type === "loading") {
        setBrowserState((prev) => ({
          url: event.url ?? prev.url,
          title: event.title ?? prev.title,
          loading: event.loading ?? prev.loading,
        }))
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!viewportRef.current) return
    const ro = new ResizeObserver(() => {
      if (!viewportRef.current) return
      const rect = viewportRef.current.getBoundingClientRect()
      window.mimo.webagentSetBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      })
    })
    ro.observe(viewportRef.current)
    return () => ro.disconnect()
  }, [])

  const selectSession = useCallback(async (session: WebAgentRef) => {
    setActiveId(session.id)
    await window.mimo.webagentAttachView(session.sessionID)
    const state = await window.mimo.webagentGetState(session.sessionID)
    setBrowserState(state)
    setUrlInput(state.url ?? "")
    if (state.url) await window.mimo.webagentNavigate(session.sessionID, state.url)
    const msgs = await window.mimo.getMessages(session.sessionID, session.directory)
    setMessages((prev) => ({ ...prev, [session.sessionID]: msgs }))
  }, [])

  const createSession = useCallback(async () => {
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
    const updated = [...sessions, ref]
    setSessions(updated)
    await window.mimo.saveRegistry("webagent", updated)
    await selectSession(ref)
    await window.mimo.webagentCreateView(session.id)
  }, [sessions, selectSession])

  const deleteSession = useCallback(async (session: WebAgentRef) => {
    await window.mimo.webagentDestroyView(session.sessionID)
    await window.mimo.deleteSession(session.sessionID, session.directory)
    const updated = sessions.filter((s) => s.id !== session.id)
    setSessions(updated)
    await window.mimo.saveRegistry("webagent", updated)
    if (activeId === session.id) {
      setActiveId(null)
      setBrowserState({ url: null, title: "", loading: false })
    }
  }, [sessions, activeId])

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

  const sendPrompt = useCallback(async () => {
    if (!activeSession || !input.trim()) return
    const text = input.trim()
    setInput("")
    const promptInput: PromptInput = {
      sessionID: activeSession.sessionID,
      directory: activeSession.directory,
      agent: "webagent",
      text,
    }
    setAgentActive(true)
    await window.mimo.prompt(promptInput)
    const msgs = await window.mimo.getMessages(activeSession.sessionID, activeSession.directory)
    setMessages((prev) => ({ ...prev, [activeSession.sessionID]: msgs }))
  }, [activeSession, input])

  useEffect(() => {
    if (!activeSession) return
    const interval = setInterval(async () => {
      const msgs = await window.mimo.getMessages(activeSession.sessionID, activeSession.directory)
      setMessages((prev) => ({ ...prev, [activeSession.sessionID]: msgs }))
      const status = await window.mimo.getSessionStatus(activeSession.directory)
      const statusInfo = status[activeSession.sessionID]
      if (statusInfo?.type === "idle") setAgentActive(false)
    }, 2000)
    return () => clearInterval(interval)
  }, [activeSession])

  return (
    <div className="webagent-layout">
      {!collapsed && (
        <div className="webagent-sidebar">
          <div className="webagent-sidebar-header">
            <button className="webagent-new-btn" onClick={createSession}>
              <IconPlus /> New
            </button>
          </div>
          <div className="webagent-session-list">
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`webagent-session-card ${activeId === s.id ? "active" : ""}`}
                onClick={() => selectSession(s)}
              >
                <div className="webagent-session-title">{s.title || "New Web Agent"}</div>
                {s.url && <div className="webagent-session-url">{s.url}</div>}
                <div className="webagent-session-time">{new Date(s.updatedAt).toLocaleDateString()}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="webagent-center">
        <div className="webagent-bar">
          <button
            className="webagent-nav-btn"
            onClick={() => activeSession && activeSession.sessionID && window.mimo.webagentGetState(activeSession.sessionID)}
            title="Back"
            disabled={!activeSession}
          >
            ←
          </button>
          <button
            className="webagent-nav-btn"
            onClick={() => activeSession && navigate(browserState.url ?? "")}
            title="Reload"
            disabled={!activeSession}
          >
            <IconRefresh />
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
            <span>{agentActive ? "Agent working..." : "Your control"}</span>
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
            <button onClick={onToggleCollapse} title="Toggle sidebar">
              ☰
            </button>
            <label className="webagent-autonomous">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              Autonomous
            </label>
            <button onClick={onToggleRight} title="Collapse chat">
              →
            </button>
          </div>
          <div className="webagent-message-list">
            {activeSession && (messages[activeSession.sessionID] || []).map((msg) => (
              <div key={msg.id} className={`webagent-message ${msg.role || "user"}`}>
                <div className="webagent-message-role">{msg.role || "user"}</div>
                {msg.parts?.map((part: any, i: number) => {
                  if (part.type === "text") return <div key={i} className="webagent-message-text">{part.text}</div>
                  if (part.type === "tool") return (
                    <div key={i} className="webagent-message-tool">
                      <span className="webagent-tool-name">{part.tool}</span>
                      {part.state?.output && <div className="webagent-tool-output">{part.state.output}</div>}
                    </div>
                  )
                  return null
                })}
              </div>
            ))}
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
