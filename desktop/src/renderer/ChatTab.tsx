import React, { useRef, useState } from "react"
import type { AgentInfo, ChatRef, ModelRef, PermissionReply, ProvidersResponse } from "@shared/types"
import type { State } from "./types-internal"
import { Composer } from "./Composer"
import { MessageView } from "./MessageView"
import { ApprovalCard } from "./ApprovalCard"
import { QuestionCard } from "./QuestionCard"
import { Sidebar } from "./Sidebar"
import { RightPanel } from "./RightPanel"
import { StatsPanel } from "./StatsPanel"
import type { Suggestion } from "./generate"
import type { FileAttachment } from "@shared/types"
import { IconRefresh, IconChevronDown } from "./Icons"
import { useAutoScroll } from "./useAutoScroll"

interface Props {
  providers: ProvidersResponse | null
  agents: AgentInfo[]
  model: ModelRef | null
  setModel: (m: ModelRef) => void
  agentName: string | null
  setAgentName: (n: string) => void
  webSearch: boolean
  setWebSearch: (v: boolean) => void
  compactThreshold?: number | null
  chats: ChatRef[]
  activeId: string | null
  onSelect: (ref: ChatRef) => void
  onNew: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  state: State
  onSend: (text: string, files?: FileAttachment[]) => void
  onAbort: () => void
  onReply: (requestID: string, reply: PermissionReply) => void | Promise<void>
  onQuestionReply: (requestID: string, answers: string[][]) => void
  onQuestionReject: (requestID: string) => void
  onDeleteMessage: (messageID: string) => void
  onRegenMessage: (messageID: string) => void
  onContinueFrom: (messageID: string) => void
  onEditMessage: (messageID: string, newText: string) => void
  onOpenSettings: () => void
  favoriteIds: Set<string>
  onPin: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (ref: ChatRef) => void
  onOpenFile: (path: string) => void
  rightCollapsed: boolean
  onToggleRight: () => void
  greeting?: string | null
  suggestions?: Suggestion[] | null
  aiHome?: boolean
  onRegenerate?: () => void
  onManageSkills?: () => void
  onManageConnectors?: () => void
  sessionID?: string | null
  onCompact?: () => void
  onClear?: () => void
  // Per-session sidebar busy dot — optional, threaded from App.
  isSessionBusy?: (sid: string | null) => boolean
}

const STATIC_SUGGESTIONS: Suggestion[] = [
  { label: "Explain this codebase to me", text: "Explain this codebase to me" },
  { label: "Write unit tests for a file", text: "Write unit tests for a file" },
  { label: "Draft a README", text: "Draft a README for this project" },
  { label: "Find and fix a bug", text: "Find and fix a bug in this project" },
]

export function ChatTab(props: Props) {
  const { state } = props
  // Stable message-action callbacks: App's handlers get a new identity on
  // every state change (their useCallback deps include state.messages), which
  // would defeat MessageView's React.memo. These wrappers keep a constant
  // identity while always delegating to the latest props — no stale closures.
  const actionsRef = useRef(props)
  actionsRef.current = props
  const msgActions = useState(() => ({
    onDelete: (id: string) => actionsRef.current.onDeleteMessage(id),
    onRegen: (id: string) => actionsRef.current.onRegenMessage(id),
    onContinueFrom: (id: string) => actionsRef.current.onContinueFrom(id),
    onEdit: (id: string, text: string) => actionsRef.current.onEditMessage(id, text),
  }))[0]
  const isLoading = state.loading && state.order.length === 0
  const isEmpty = state.order.length === 0 && !state.busy && !state.loading
  const [prefill, setPrefill] = useState({ text: "", n: 0 })
  const suggestions = props.suggestions ?? STATIC_SUGGESTIONS
  const { scrollRef, enabled: autoScroll, toggle: toggleAutoScroll } = useAutoScroll(
    [state.order, state.messages, state.permissions],
    { resetKey: props.sessionID, loading: state.loading },
  )

  const composer = (
    <Composer
      busy={state.busy}
      providers={props.providers}
      agents={props.agents}
      model={props.model}
      onModelChange={props.setModel}
      showMode={false}
      agentName={props.agentName}
      webSearch={props.webSearch}
      onWebSearchToggle={props.setWebSearch}
      onSend={props.onSend}
      onAbort={props.onAbort}
      directory={props.chats.find((c) => c.id === props.activeId)?.directory ?? null}
      prefill={prefill}
      onManageSkills={props.onManageSkills}
      onManageConnectors={props.onManageConnectors}
      sessionID={props.sessionID}
      onCompact={props.onCompact}
      onClear={props.onClear}
    />
  )

  return (
    <>
      <Sidebar
        favoriteIds={props.favoriteIds}
        newLabel="New chat"
        items={props.chats}
        activeId={props.activeId}
        onSelect={props.onSelect}
        onNew={props.onNew}
        collapsed={props.collapsed}
        onToggleCollapse={props.onToggleCollapse}
        emptyText="No chats yet"
        onOpenSettings={props.onOpenSettings}
        onPin={props.onPin}
        onRename={props.onRename}
        onDelete={props.onDelete}
        deleteMessage="This will permanently remove all files in this chat's sandbox."
        isSessionBusy={props.isSessionBusy}
      />

      <main className="main">
        {isLoading ? (
          <div className="loading-overlay">
            <div className="loading-spinner" />
            <span>Loading chat...</span>
          </div>
        ) : isEmpty ? (
          <div className="greeting">
            <h1>
              {props.greeting ? (
                <>
                  <span className="accent">✻</span> {props.greeting}
                </>
              ) : (
                <>
                  <span className="accent">✻</span> Good to see you. <br />
                  What should we build?
                </>
              )}
            </h1>
            <div style={{ width: "100%", maxWidth: 720 }}>{composer}</div>
            <div className="chips">
              {suggestions.map((sug, i) => (
                <button
                  key={sug.label + i}
                  className="chip"
                  title={sug.text}
                  onClick={() => setPrefill((p) => ({ text: sug.text, n: p.n + 1 }))}
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
            {state.error && <div className="status-banner error">{state.error}</div>}
          </div>
        ) : (
          <>
            <div className="conversation" ref={scrollRef}>
              <div className="conversation-inner">
                {state.order.map((id) => (
                  <MessageView
                    key={id}
                    message={state.messages[id]}
                    showDots={state.busy}
                    busy={state.busy}
                    actorVersion={state.actorVersion}
                    actors={state.actors}
                    onDelete={msgActions.onDelete}
                    onRegen={msgActions.onRegen}
                    onContinueFrom={msgActions.onContinueFrom}
                    onEdit={msgActions.onEdit}
                  />
                ))}
                {state.permissions.map((p) => (
                  <ApprovalCard key={p.id} permission={p} onReply={(id, reply) => props.onReply(id, reply)} />
                ))}
                {state.questions.map((q) => (
                  <QuestionCard
                    key={q.id}
                    question={q}
                    onReply={props.onQuestionReply}
                    onReject={props.onQuestionReject}
                  />
                ))}
                {state.busy && state.statusInfo?.type === "retry" && (
                  <div className="status-banner retry">
                    {state.statusInfo.message ?? "Provider error"} — retrying (attempt {state.statusInfo.attempt ?? "?"}){" "}
                    of 10…
                  </div>
                )}
                {state.error && <div className="status-banner error">{state.error}</div>}
              </div>
              <button
                className={"autoscroll-toggle" + (autoScroll ? " on" : "")}
                onClick={toggleAutoScroll}
                title={autoScroll ? "Auto-scroll on — click to disable" : "Auto-scroll off — click to enable and jump to bottom"}
              >
                <IconChevronDown size={14} />
              </button>
            </div>
            <div className="composer-wrap">{composer}</div>
          </>
        )}
      </main>

      <RightPanel
        collapsed={props.rightCollapsed}
        onToggleCollapse={props.onToggleRight}
        tasks={state.tasks}
        files={state.files}
        onOpenFile={props.onOpenFile}
        showProgress={false}
        stats={
          <StatsPanel
            state={state}
            providers={props.providers}
            model={props.model}
            compactThreshold={props.compactThreshold}
          />
        }
      />
    </>
  )
}
