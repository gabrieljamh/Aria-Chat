// Tasker mode (formerly "Cowork" mode) — runs against a user-picked project folder.
// If you see references to "cowork" internals, they refer to this same Tasker mode.
import React, { useEffect, useRef, useState } from "react"
import type { AgentInfo, ModelRef, PermissionReply, ProjectInfo, ProvidersResponse, SessionInfoFull } from "@shared/types"
import type { State } from "./types-internal"
import { Composer } from "./Composer"
import { MessageView } from "./MessageView"
import { ApprovalCard } from "./ApprovalCard"
import { QuestionCard } from "./QuestionCard"
import { TaskerSidebar } from "./TaskerSidebar"
import { ProjectDropdown } from "./ProjectDropdown"
import { DiffGrid } from "./DiffGrid"
import { IconRefresh } from "./Icons"
import { RightPanel } from "./RightPanel"
import { StatsPanel } from "./StatsPanel"
import type { Suggestion } from "./generate"
import type { FileAttachment } from "@shared/types"

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
  state: State
  onSend: (text: string, files?: FileAttachment[]) => void
  onAbort: () => void
  onReply: (requestID: string, reply: PermissionReply) => void
  onQuestionReply: (requestID: string, answers: string[][]) => void
  onQuestionReject: (requestID: string) => void
  onDeleteMessage: (messageID: string) => void
  onRegenMessage: (messageID: string) => void
  onContinueFrom: (messageID: string) => void
  onEditMessage: (messageID: string, newText: string) => void
  onOpenFile: (path: string) => void
  onOpenSettings: () => void
  onManageSkills?: () => void
  onManageConnectors?: () => void
  sessionID?: string | null
  onCompact?: () => void
  onClear?: () => void
  // Project dropdown props
  projects: ProjectInfo[]
  selectedProjectDir: string | null
  onSelectProject: (dir: string) => void
  onAddProject: () => void
  projectsLoading: boolean
  // Tasker sidebar props
  sessionsByDir: Map<string, SessionInfoFull[]>
  activeSessionId: string | null
  onSelectSession: (sessionID: string, directory: string) => void
  onRefreshProject: (directory: string) => void
  onDeleteSession?: (sessionID: string, directory: string) => void
  onRenameSession?: (sessionID: string, title: string, directory: string) => void
  onRenameProject?: (projectID: string, name: string) => void
  onPinProject?: (directory: string) => void
  onHideProject?: (directory: string) => void
  pinnedDirs: Set<string>
  loadingDirs: Set<string>
  registryDirs: string[]
  // Sidebar collapse
  collapsed: boolean
  onToggleCollapse: () => void
  onNew: () => void
  rightCollapsed: boolean
  onToggleRight: () => void
  greeting?: string | null
  suggestions?: Suggestion[] | null
  aiHome?: boolean
  onRegenerate?: () => void
}

const STATIC_TASKS: Suggestion[] = [
  { label: "Organize this folder", text: "Organize this folder: sort and rename files, group by type, and summarize what's here.", desc: "Sort and rename files, group by type, and summarize what's here." },
  { label: "Refactor a module", text: "Pick a module in this project and improve its structure, naming, and tests.", desc: "Pick a file and improve structure, naming, and tests." },
  { label: "Write documentation", text: "Generate a README and inline documentation for this project.", desc: "Generate a README and inline docs for the project." },
  { label: "Audit dependencies", text: "Find outdated or unused packages in this project and propose fixes.", desc: "Find outdated or unused packages and propose fixes." },
]

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function TaskerTab(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { state } = props
  const isLoading = state.loading && state.order.length === 0
  const isEmpty = state.order.length === 0 && !state.busy && !state.loading
  const [prefill, setPrefill] = useState({ text: "", n: 0 })
  const tasks = props.suggestions ?? STATIC_TASKS

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.order, state.messages, state.permissions])

  const projectDir = props.selectedProjectDir
  const composer = (
    <Composer
      placeholder={projectDir ? `Work in ${basename(projectDir)}…` : "Pick a project, then describe a task…"}
      busy={state.busy}
      providers={props.providers}
      agents={props.agents}
      model={props.model}
      onModelChange={props.setModel}
      showMode
      agentName={props.agentName}
      onAgentChange={props.setAgentName}
      webSearch={props.webSearch}
      onWebSearchToggle={props.setWebSearch}
      onSend={props.onSend}
      onAbort={props.onAbort}
      directory={projectDir ?? null}
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
      <TaskerSidebar
        projects={props.projects}
        sessionsByDir={props.sessionsByDir}
        activeSessionId={props.activeSessionId}
        activeProjectDir={props.selectedProjectDir}
        onSelectSession={props.onSelectSession}
        onSelectProject={props.onSelectProject}
        onNewTask={props.onNew}
        onRefreshProject={props.onRefreshProject}
        onAddProject={props.onAddProject}
        onDeleteSession={props.onDeleteSession}
        onRenameSession={props.onRenameSession}
        onRenameProject={props.onRenameProject}
        onPinProject={props.onPinProject}
        onHideProject={props.onHideProject}
        pinnedDirs={props.pinnedDirs}
        collapsed={props.collapsed}
        onToggleCollapse={props.onToggleCollapse}
        onOpenSettings={props.onOpenSettings}
        loadingDirs={props.loadingDirs}
        registryDirs={props.registryDirs}
      />

      <div className="cowork">
        <div className="center">
          <div className="cowork-bar">
            <ProjectDropdown
              projects={props.projects}
              selectedDir={props.selectedProjectDir}
              onSelect={props.onSelectProject}
              onAddProject={props.onAddProject}
              loading={props.projectsLoading}
            />
          </div>

          {isLoading ? (
            <div className="loading-overlay">
              <div className="loading-spinner" />
              <span>Loading chat...</span>
            </div>
          ) : isEmpty ? (
            <div className="greeting greeting-scroll" style={{ justifyContent: "flex-start", paddingTop: 36 }}>
              {projectDir && props.sessionsByDir.get(projectDir) && (
                <DiffGrid
                  sessions={props.sessionsByDir.get(projectDir)!}
                  activeSessionId={props.activeSessionId}
                  onSelectSession={(sid) => props.onSelectSession(sid, projectDir)}
                  getDiffs={(sid) => window.mimo.getSessionDiff(sid)}
                />
              )}
              <h1 style={{ fontSize: 32 }}>{props.greeting || "What should we work on?"}</h1>
              <div className="active-task-card">
                <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--accent)" }} />
                <div>
                  <div style={{ fontWeight: 600 }}>No active task</div>
                  <div style={{ color: "var(--text-dim)", fontSize: 12.5 }}>
                    Pick a folder and describe a task — progress and file changes show on the right.
                  </div>
                </div>
              </div>
              <div style={{ width: "100%", maxWidth: 720 }}>{composer}</div>
              <div className="task-cards">
                {tasks.map((task, i) => (
                  <button
                    key={task.label + i}
                    className="task-card"
                    onClick={() => setPrefill((p) => ({ text: task.text, n: p.n + 1 }))}
                  >
                    <div className="t">{task.label}</div>
                    <div className="d">{task.desc ?? task.text}</div>
                  </button>
                ))}
              </div>
              {props.aiHome && (
                <button className="regen-btn" onClick={props.onRegenerate} title="Regenerate with AI">
                  <IconRefresh size={13} /> Regenerate
                </button>
              )}
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
                      onDelete={props.onDeleteMessage}
                      onRegen={props.onRegenMessage}
                      onContinueFrom={props.onContinueFrom}
                      onEdit={props.onEditMessage}
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
                  {state.error && <div className="status-banner error">{state.error}</div>}
                </div>
              </div>
              <div className="composer-wrap">{composer}</div>
            </>
          )}
        </div>

        <RightPanel
          collapsed={props.rightCollapsed}
          onToggleCollapse={props.onToggleRight}
          tasks={state.tasks}
          files={state.files}
          onOpenFile={props.onOpenFile}
          stats={
            <StatsPanel
              state={state}
              providers={props.providers}
              model={props.model}
              compactThreshold={props.compactThreshold}
            />
          }
        />
      </div>
    </>
  )
}
