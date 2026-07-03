import { useEffect, useState, useCallback } from "react"
import type { SchedulerRule, SchedulerTrigger, SchedulerTarget, SchedulerAction, McpStatus, McpToolDef, ExecutionLogEntry, SchedulerStats, RunningProcess } from "@shared/types"
import { IconPlus, IconRefresh, IconTrash } from "./Icons"
import { RightPanel } from "./RightPanel"
import type { Suggestion } from "./generate"

type Props = {
  onOpenSettings: () => void
  onToggleCollapse: () => void
  collapsed: boolean
  rightCollapsed: boolean
  onToggleRight: () => void
  greeting?: string | null
  suggestions?: Suggestion[] | null
  aiHome?: boolean
  onRegenerate?: () => void
}

const ACTION_LABELS: Record<string, string> = {
  prompt: "Prompt",
  command: "Command",
  bash: "Bash",
  "bash-detached": "Bash (detached)",
  notify: "Notify",
  mcp: "MCP Tool",
}

const ACTION_DESCRIPTIONS: Record<string, string> = {
  prompt: "Sends a prompt to an AI session. The AI's response will be shown as a desktop notification if enabled. Requires a sandbox or project target.",
  command: "Runs a slash command (like /init) in an AI session. Requires a sandbox or project target.",
  bash: "Executes a shell command and waits for it to finish (up to 2 minutes). Works with any target — the target directory is used as the working directory.",
  "bash-detached": "Launches a background process that keeps running independently. Works with any target — the target directory is used as the working directory.",
  notify: "Shows a desktop notification with a title and body. No session is created — works with any target.",
  mcp: "Calls an MCP tool directly, bypassing the AI session loop. The tool runs server-side and returns its result. Works with any target — the target directory determines which MCP server instance is used.",
}

/** Actions that require a session (sandbox or project target). */
const SESSION_ACTIONS = new Set(["prompt", "command"])

function actionCompatible(actionType: string, targetType: string): boolean {
  if (SESSION_ACTIONS.has(actionType) && targetType === "none") return false
  return true
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const STATIC_RULES: Suggestion[] = [
  { label: "Daily code review", text: "Run a code review on today's changes", desc: "Schedule a daily review of recent commits with an AI-generated summary." },
  { label: "Startup dev server", text: "Start the development server", desc: "Launch your dev server as a background process on app startup." },
  { label: "Hourly git pull", text: "Pull latest changes from main", desc: "Keep your local repo synced with hourly git pulls." },
  { label: "Build & notify", text: "Run the build and notify on result", desc: "Schedule a build run and get a desktop notification of success or failure." },
]

function triggerLabel(t: SchedulerTrigger): string {
  if (t.type === "on-startup") return "On Startup"
  if (t.type === "daily") return `Daily ${t.time}`
  if (t.type === "weekly") return `${t.days.map((d) => DAY_NAMES[d]).join(", ")} ${t.time}`
  if (t.type === "interval") return `Every ${t.minutes}m`
  return "?"
}

function actionLabel(a: SchedulerAction): string {
  if (a.type === "prompt") return `Prompt: "${a.text.slice(0, 60)}${a.text.length > 60 ? "…" : ""}"`
  if (a.type === "command") return `/${a.command}${a.args ? " " + a.args : ""}`
  if (a.type === "bash") return `$ ${a.command.slice(0, 60)}`
  if (a.type === "bash-detached") return `$ ${a.command.slice(0, 60)} (detached)`
  if (a.type === "notify") return `Notify: "${a.body.slice(0, 60)}"`
  if (a.type === "mcp") return `MCP: ${a.server}/${a.tool}`
  return "?"
}

function nextFireTime(rule: SchedulerRule): string {
  if (rule.trigger.type === "on-startup") {
    if (rule.lastFired) return `Fired ${formatRelativeAgo(Date.now() - rule.lastFired)}`
    return "On next launch"
  }
  if (rule.trigger.type === "interval") return `In ~${rule.trigger.minutes}m`
  const now = new Date()
  const [hh, mm] = (rule.trigger.type === "daily" || rule.trigger.type === "weekly")
    ? rule.trigger.time.split(":").map(Number)
    : [0, 0]
  if (rule.trigger.type === "daily") {
    const target = new Date(now)
    target.setHours(hh, mm, 0, 0)
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return formatRelative(target.getTime() - now.getTime())
  }
  if (rule.trigger.type === "weekly") {
    for (let i = 0; i <= 7; i++) {
      const cand = new Date(now)
      cand.setDate(cand.getDate() + i)
      cand.setHours(hh, mm, 0, 0)
      if (rule.trigger.days.includes(cand.getDay()) && cand.getTime() > now.getTime()) {
        return formatRelative(cand.getTime() - now.getTime())
      }
    }
  }
  return "—"
}

function formatRelative(ms: number): string {
  if (ms < 60_000) return "In <1m"
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `In ${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `In ${hours}h ${mins % 60}m`
  const days = Math.floor(hours / 24)
  return `In ${days}d ${hours % 24}h`
}

function formatRelativeAgo(ms: number): string {
  if (ms < 60_000) return "just now"
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function newRule(): SchedulerRule {
  return {
    id: crypto.randomUUID(),
    enabled: true,
    name: "New Rule",
    trigger: { type: "on-startup" },
    target: { type: "sandbox" },
    action: { type: "notify", title: "Aria Scheduler", body: "" },
    options: { fireIfMissed: false, disposeAfter: true, notifications: true },
  }
}

const SETTINGS_ICON = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
  </svg>
)

export function SchedulerMode(props: Props) {
  const [rules, setRules] = useState<SchedulerRule[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<SchedulerRule | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [history, setHistory] = useState<ExecutionLogEntry[]>([])
  const [stats, setStats] = useState<SchedulerStats | null>(null)
  const [runningProcesses, setRunningProcesses] = useState<RunningProcess[]>([])

  const suggestions = props.suggestions ?? STATIC_RULES

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const r = await window.mimo.getSchedulerRules()
      setRules(r)
    } catch {
      setRules([])
    }
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    const id = setInterval(() => { load() }, 10_000)
    return () => clearInterval(id)
  }, [load])

  // Poll history + stats + running processes
  useEffect(() => {
    const poll = async () => {
      try {
        const [h, s, rp] = await Promise.all([
          window.mimo.getSchedulerHistory(),
          window.mimo.getSchedulerStats(),
          window.mimo.getRunningProcesses(),
        ])
        setHistory(h)
        setStats(s)
        setRunningProcesses(rp)
      } catch { /* best-effort */ }
    }
    poll()
    const id = setInterval(poll, 5_000)
    return () => clearInterval(id)
  }, [])

  const save = useCallback(async (updated: SchedulerRule[]) => {
    await window.mimo.setSchedulerRules(updated)
    setRules(updated)
  }, [])

  const handleToggle = (id: string) => {
    save(rules.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r))
  }

  const handleAdd = () => {
    setEditing(newRule())
    setIsNew(true)
  }

  const handleEdit = (rule: SchedulerRule) => {
    setEditing(rule)
    setIsNew(false)
  }

  const handleSaveRule = (rule: SchedulerRule) => {
    if (isNew) {
      save([...rules, rule])
    } else {
      save(rules.map((r) => r.id === rule.id ? rule : r))
    }
    setEditing(null)
  }

  const handleDeleteRule = (rule: SchedulerRule) => {
    save(rules.filter((r) => r.id !== rule.id))
    setEditing(null)
  }

  const handleSuggestionClick = (sug: Suggestion) => {
    const rule = newRule()
    rule.name = sug.label
    const text = sug.text.toLowerCase()
    const label = sug.label.toLowerCase()

    // Infer trigger from suggestion text
    if (label.includes("startup") || text.includes("startup") || text.includes("on startup")) {
      rule.trigger = { type: "on-startup" }
    } else if (text.includes("hourly") || label.includes("hourly")) {
      rule.trigger = { type: "interval", minutes: 60 }
    } else if (text.includes("daily") || label.includes("daily")) {
      rule.trigger = { type: "daily", time: "09:00" }
    } else if (text.includes("weekly") || label.includes("weekly")) {
      rule.trigger = { type: "weekly", days: [1], time: "09:00" }
    } else {
      rule.trigger = { type: "daily", time: "09:00" }
    }

    // Infer action from suggestion text
    // "notify" alone → notify action. "build/review/summary + notify" → prompt action (notifications handle the notify part).
    if (text.includes("dev server") || text.includes("background") || label.includes("startup")) {
      rule.action = { type: "bash-detached", command: sug.text }
    } else if (text.includes("review") || text.includes("summary") || text.includes("pull") || text.includes("build")) {
      rule.action = { type: "prompt", text: sug.text }
    } else if (text.includes("notify") || text.includes("notification") || label.includes("notify")) {
      rule.action = { type: "notify", title: "Aria Scheduler", body: sug.text }
    } else {
      rule.action = { type: "prompt", text: sug.text }
    }

    setEditing(rule)
    setIsNew(true)
  }

  const handleKill = useCallback(async (pid: number) => {
    const ok = await window.mimo.killProcess(pid)
    if (ok) {
      setRunningProcesses((prev) => prev.filter((p) => p.pid !== pid))
    }
  }, [])

  return (
    <>
      {props.collapsed ? (
        <aside className="sidebar collapsed">
          <button className="icon-btn" title="Expand sidebar" onClick={props.onToggleCollapse}>»</button>
          <button className="icon-btn" title="New Rule" onClick={handleAdd}><IconPlus size={16} /></button>
          <div className="sidebar-spacer" />
          <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>{SETTINGS_ICON}</button>
        </aside>
      ) : (
        <aside className="sidebar">
          <div className="sidebar-head">
            <button className="new-btn" onClick={handleAdd}><IconPlus size={15} /> New Rule</button>
            <button className="icon-btn collapse-btn" title="Collapse sidebar" onClick={props.onToggleCollapse}>«</button>
          </div>
          <div className="sidebar-scroll">
            {loading && <div className="scheduler-empty">Loading…</div>}
            {!loading && rules.length === 0 && (
              <div className="scheduler-empty">No rules yet. Click "+ New Rule" to create one.</div>
            )}
            {rules.map((rule) => (
              <div
                key={rule.id}
                className={`rule-card ${rule.enabled ? "" : "disabled"}`}
                onClick={() => handleEdit(rule)}
              >
                <div className="rule-card-header">
                  <button
                    className="rule-toggle"
                    onClick={(e) => { e.stopPropagation(); handleToggle(rule.id) }}
                    title={rule.enabled ? "Disable" : "Enable"}
                  >
                    <span className={`rule-toggle-dot ${rule.enabled ? "on" : ""}`} />
                  </button>
                  <span className="rule-name">{rule.name}</span>
                </div>
                <div className="rule-trigger">{triggerLabel(rule.trigger)}</div>
                <div className="rule-action">{actionLabel(rule.action)}</div>
                <div className="rule-next">{rule.enabled ? nextFireTime(rule) : "Disabled"}</div>
              </div>
            ))}
          </div>
          <div className="sidebar-footer">
            <button className="sidebar-settings-btn" onClick={props.onOpenSettings}>
              {SETTINGS_ICON} Settings
            </button>
          </div>
        </aside>
      )}

      <div className="scheduler-content-row">
        <div className="scheduler-content">
          <div className="greeting greeting-scroll" style={{ justifyContent: "flex-start", paddingTop: 36 }}>
            <h1 style={{ fontSize: 32 }}>
              <span className="accent">✻</span> {props.greeting || "Automate your workflow."}
            </h1>

            <button className="new-rule-prominent" onClick={handleAdd}>
              <IconPlus size={16} /> New Rule
            </button>

            <div className="task-cards" style={{ maxWidth: 720 }}>
              {suggestions.map((sug, i) => (
                <button key={sug.label + i} className="task-card" onClick={() => handleSuggestionClick(sug)}>
                  <div className="t">{sug.label}</div>
                  <div className="d">{sug.desc ?? sug.text}</div>
                </button>
              ))}
            </div>

            {props.aiHome && (
              <button className="regen-btn" onClick={props.onRegenerate} title="Regenerate with AI">
                <IconRefresh size={13} /> Regenerate
              </button>
            )}

            {history.length > 0 && (
              <div className="scheduler-history">
                <div className="section-label" style={{ padding: "8px 0" }}>Execution History</div>
                {history.map((entry) => (
                  <div key={entry.id} className="history-card">
                    <div className="history-status" data-status={entry.status} />
                    <div className="history-body">
                      <div className="history-name">{entry.ruleName}</div>
                      <div className="history-meta">
                        {entry.actionType} · {entry.targetLabel} · {formatRelativeAgo(Date.now() - entry.startedAt)}
                      </div>
                      {entry.detail && <div className="history-detail">{entry.detail}</div>}
                    </div>
                  </div>
                ))}
              </div>
            )}

            <details className="scheduler-debug-log">
              <summary>Debug Log</summary>
              <pre>{history.map((e) =>
                `[${new Date(e.startedAt).toISOString()}] ${e.status} ${e.ruleName} (${e.actionType})`
              ).join("\n")}</pre>
            </details>
          </div>
        </div>

        <RightPanel
          collapsed={props.rightCollapsed}
          onToggleCollapse={props.onToggleRight}
          tasks={[]}
          files={[]}
          onOpenFile={() => {}}
          showProgress={false}
          showFiles={false}
          stats={
            <SchedulerStatsPanel
              stats={stats}
              runningProcesses={runningProcesses}
              onKill={handleKill}
            />
          }
        />
      </div>

      {editing && (
        <SchedulerEditor
          rule={editing}
          isNew={isNew}
          onSave={handleSaveRule}
          onDelete={handleDeleteRule}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  )
}

/* ------------------------- Scheduler Stats Panel ------------------------- */

function SchedulerStatsPanel({ stats, runningProcesses, onKill }: {
  stats: SchedulerStats | null
  runningProcesses: RunningProcess[]
  onKill: (pid: number) => void
}) {
  if (!stats) {
    return (
      <div className="panel-section stats-section">
        <h3>Stats</h3>
        <div className="stat-row"><span className="stat-label">No data yet</span></div>
      </div>
    )
  }
  return (
    <>
      <div className="panel-section stats-section">
        <h3>Stats</h3>
        <div className="stat-row">
          <span className="stat-label">Success</span>
          <span className="stat-val">{stats.success}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Running</span>
          <span className="stat-val">{stats.running}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Failed</span>
          <span className="stat-val">{stats.failed}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Sandboxes</span>
          <span className="stat-val">{stats.sandboxesCreated} / {stats.sandboxesDestroyed}</span>
        </div>
        <div className="stat-row">
          <span className="stat-label">Sessions</span>
          <span className="stat-val">{stats.sessionsCreated}</span>
        </div>
        {stats.lastSuccess && (
          <div className="scheduler-last-rule">
            <div className="scheduler-last-label">Last Success</div>
            <div className="scheduler-last-name">{stats.lastSuccess.ruleName}</div>
          </div>
        )}
        {stats.lastFailure && (
          <div className="scheduler-last-rule">
            <div className="scheduler-last-label">Last Failure</div>
            <div className="scheduler-last-name">{stats.lastFailure.ruleName}</div>
          </div>
        )}
      </div>
      <div className="panel-section">
        <h3>Running Processes</h3>
        {runningProcesses.length === 0 ? (
          <div className="panel-empty">No background processes running.</div>
        ) : (
          <div className="running-process-list">
            {runningProcesses.map((proc) => (
              <div key={proc.pid} className="running-process-item">
                <div className="rp-info">
                  <div className="rp-name">{proc.ruleName}</div>
                  <div className="rp-pid">PID {proc.pid} · {formatRelativeAgo(Date.now() - proc.startedAt)}</div>
                </div>
                <button className="rp-kill-btn" onClick={() => onKill(proc.pid)} title="Kill process">
                  Kill
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ------------------------------ Editor ------------------------------ */

type EditorProps = {
  rule: SchedulerRule
  isNew: boolean
  onSave: (rule: SchedulerRule) => void
  onDelete: (rule: SchedulerRule) => void
  onClose: () => void
}

function SchedulerEditor({ rule: initial, isNew, onSave, onDelete, onClose }: EditorProps) {
  const [rule, setRule] = useState<SchedulerRule>(initial)
  const [mcpServers, setMcpServers] = useState<Record<string, McpStatus>>({})
  const [mcpTools, setMcpTools] = useState<McpToolDef[]>([])
  const [argsText, setArgsText] = useState("{}")
  const [argsError, setArgsError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const update = (patch: Partial<SchedulerRule>) => setRule((r) => ({ ...r, ...patch }))

  const updateTrigger = (trigger: SchedulerTrigger) => update({ trigger })
  const updateTarget = (target: SchedulerTarget) => update({ target })
  const updateAction = (action: SchedulerAction) => update({ action })

  // Resolve directory for MCP calls from the rule's target
  const mcpDirectory = rule.target.type === "project" ? rule.target.dir : ""
  const mcpServer = rule.action.type === "mcp" ? rule.action.server : ""
  const mcpTool = rule.action.type === "mcp" ? rule.action.tool : ""

  // Fetch MCP servers when MCP action is selected
  useEffect(() => {
    if (rule.action.type !== "mcp" || !mcpDirectory) return
    window.mimo.getMcpStatus(mcpDirectory).then(setMcpServers).catch(() => {})
  }, [rule.action.type, mcpDirectory])

  // Fetch tools when server changes
  useEffect(() => {
    if (rule.action.type !== "mcp" || !mcpServer || !mcpDirectory) return
    window.mimo.listMcpTools(mcpServer, mcpDirectory).then(setMcpTools).catch(() => {})
  }, [rule.action.type, mcpServer, mcpDirectory])

  // Sync argsText when switching to MCP
  useEffect(() => {
    if (rule.action.type === "mcp") {
      setArgsText(JSON.stringify(rule.action.arguments, null, 2))
      setArgsError(null)
    }
  }, [rule.action.type])

  const days = rule.trigger.type === "weekly" ? rule.trigger.days : []

  const toggleDay = (day: number) => {
    if (rule.trigger.type !== "weekly") return
    const next = days.includes(day) ? days.filter((d) => d !== day) : [...days, day].sort()
    updateTrigger({ type: "weekly", days: next, time: rule.trigger.time })
  }

  return (
    <div className="scheduler-editor-overlay" onClick={onClose}>
      <div className="scheduler-editor" onClick={(e) => e.stopPropagation()}>
        <div className="scheduler-editor-header">
          <h2>{isNew ? "New Rule" : "Edit Rule"}</h2>
          <button className="editor-close" onClick={onClose}>✕</button>
        </div>

        <div className="editor-field">
          <label>Name</label>
          <input
            type="text"
            value={rule.name}
            onChange={(e) => update({ name: e.target.value })}
            placeholder="Rule name"
          />
        </div>

        {/* Trigger */}
        <div className="editor-field">
          <label>Trigger</label>
          <div className="editor-options">
            {(["on-startup", "daily", "weekly", "interval"] as const).map((t) => (
              <button
                key={t}
                className={rule.trigger.type === t ? "active" : ""}
                onClick={() => {
                  if (t === "on-startup") update({ trigger: { type: "on-startup" } })
                  else if (t === "daily") update({ trigger: { type: "daily", time: "09:00" } })
                  else if (t === "weekly") update({ trigger: { type: "weekly", days: [1], time: "09:00" } })
                  else if (t === "interval") update({ trigger: { type: "interval", minutes: 30 } })
                }}
              >
                {t === "on-startup" ? "On Startup" : t === "daily" ? "Daily" : t === "weekly" ? "Weekly" : "Interval"}
              </button>
            ))}
          </div>
        </div>

        {rule.trigger.type === "daily" && (
          <div className="editor-field">
            <label>Time (24h)</label>
            <input
              type="time"
              value={rule.trigger.time}
              onChange={(e) => update({ trigger: { type: "daily", time: e.target.value } })}
            />
          </div>
        )}

        {rule.trigger.type === "weekly" && (
          <>
            <div className="editor-field">
              <label>Days</label>
              <div className="editor-days">
                {DAY_NAMES.map((name, i) => (
                  <button
                    key={i}
                    className={days.includes(i) ? "active" : ""}
                    onClick={() => toggleDay(i)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            </div>
            <div className="editor-field">
              <label>Time (24h)</label>
              <input
                type="time"
                value={rule.trigger.time}
                onChange={(e) => {
                  if (rule.trigger.type !== "weekly") return
                  updateTrigger({ type: "weekly", days: rule.trigger.days, time: e.target.value })
                }}
              />
            </div>
          </>
        )}

        {rule.trigger.type === "interval" && (
          <div className="editor-field">
            <label>Minutes</label>
            <input
              type="number"
              min={1}
              value={rule.trigger.minutes}
              onChange={(e) => updateTrigger({ type: "interval", minutes: Math.max(1, Number(e.target.value)) })}
            />
          </div>
        )}

        {/* Target */}
        <div className="editor-field">
          <label>Target</label>
          <div className="editor-options">
            {(["sandbox", "project", "none"] as const).map((t) => (
              <button
                key={t}
                className={rule.target.type === t ? "active" : ""}
                onClick={() => {
                  if (t === "sandbox") update({ target: { type: "sandbox" } })
                  else if (t === "project") update({ target: { type: "project", dir: "" } })
                  else {
                    if (SESSION_ACTIONS.has(rule.action.type)) {
                      update({ target: { type: "none" }, action: { type: "notify", title: "Aria Scheduler", body: "" } })
                    } else {
                      update({ target: { type: "none" } })
                    }
                  }
                }}
              >
                {t === "sandbox" ? "Sandbox" : t === "project" ? "Project" : "None"}
              </button>
            ))}
          </div>
        </div>

        {rule.target.type === "project" && (
          <div className="editor-field">
            <label>Project Directory</label>
            <input
              type="text"
              value={rule.target.dir}
              onChange={(e) => updateTarget({ type: "project", dir: e.target.value })}
              placeholder="C:\path\to\project"
            />
          </div>
        )}

        {/* Action */}
        <div className="editor-field">
          <label>Action</label>
          <div className="editor-options">
            {(["prompt", "command", "bash", "bash-detached", "notify", "mcp"] as const).map((t) => {
              const compatible = actionCompatible(t, rule.target.type)
              return (
                <button
                  key={t}
                  className={`${rule.action.type === t ? "active" : ""} ${compatible ? "" : "disabled"}`}
                  disabled={!compatible}
                  title={compatible ? undefined : "Requires a sandbox or project target"}
                  onClick={() => {
                    if (!compatible) return
                    if (t === "prompt") update({ action: { type: "prompt", text: "" } })
                    else if (t === "command") update({ action: { type: "command", command: "", args: "" } })
                    else if (t === "bash") update({ action: { type: "bash", command: "" } })
                    else if (t === "bash-detached") update({ action: { type: "bash-detached", command: "" } })
                    else if (t === "notify") update({ action: { type: "notify", title: "Aria Scheduler", body: "" } })
                    else if (t === "mcp") update({ action: { type: "mcp", server: "", tool: "", arguments: {} } })
                  }}
                >
                  {ACTION_LABELS[t]}
                </button>
              )
            })}
          </div>
          {rule.action.type && (
            <div className="action-description">{ACTION_DESCRIPTIONS[rule.action.type]}</div>
          )}
        </div>

        {rule.action.type === "prompt" && (
          <div className="editor-field">
            <label>Prompt Text</label>
            <textarea
              value={rule.action.text}
              onChange={(e) => updateAction({ type: "prompt", text: e.target.value })}
              placeholder="Prompt to send"
              rows={3}
            />
          </div>
        )}

        {rule.action.type === "command" && (
          <>
            <div className="editor-field">
              <label>Command</label>
              <input
                type="text"
                value={rule.action.command}
                onChange={(e) => {
                  if (rule.action.type !== "command") return
                  updateAction({ type: "command", command: e.target.value, args: rule.action.args })
                }}
                placeholder="e.g. init"
              />
            </div>
            <div className="editor-field">
              <label>Arguments</label>
              <input
                type="text"
                value={rule.action.args ?? ""}
                onChange={(e) => {
                  if (rule.action.type !== "command") return
                  updateAction({ type: "command", command: rule.action.command, args: e.target.value })
                }}
                placeholder="optional"
              />
            </div>
          </>
        )}

        {(rule.action.type === "bash" || rule.action.type === "bash-detached") && (
          <div className="editor-field">
            <label>Bash Command</label>
            <textarea
              value={rule.action.command}
              onChange={(e) => {
                if (rule.action.type !== "bash" && rule.action.type !== "bash-detached") return
                updateAction({ type: rule.action.type, command: e.target.value })
              }}
              placeholder="echo hello"
              rows={3}
            />
          </div>
        )}

        {rule.action.type === "notify" && (
          <>
            <div className="editor-field">
              <label>Title</label>
              <input
                type="text"
                value={rule.action.title}
                onChange={(e) => {
                  if (rule.action.type !== "notify") return
                  updateAction({ type: "notify", title: e.target.value, body: rule.action.body })
                }}
              />
            </div>
            <div className="editor-field">
              <label>Body</label>
              <textarea
                value={rule.action.body}
                onChange={(e) => {
                  if (rule.action.type !== "notify") return
                  updateAction({ type: "notify", title: rule.action.title, body: e.target.value })
                }}
                rows={2}
              />
            </div>
          </>
        )}

        {rule.action.type === "mcp" && (
          <>
            <div className="editor-field">
              <label>MCP Server</label>
              <select
                value={mcpServer}
                onChange={(e) => {
                  const server = e.target.value
                  updateAction({ type: "mcp", server, tool: "", arguments: {} })
                  setMcpTools([])
                }}
              >
                <option value="">— Select server —</option>
                {Object.entries(mcpServers).map(([name, status]) => (
                  <option key={name} value={name} disabled={status.status !== "connected"}>
                    {name} ({status.status})
                  </option>
                ))}
              </select>
              {Object.keys(mcpServers).length === 0 && mcpDirectory && (
                <div className="action-description">No MCP servers configured. Add one in Settings.</div>
              )}
              {!mcpDirectory && (
                <div className="action-description">Select a project target to choose an MCP server.</div>
              )}
            </div>

            {mcpServer && (
              <div className="editor-field">
                <label>Tool</label>
                <select
                  value={mcpTool}
                  onChange={(e) => updateAction({ type: "mcp", server: mcpServer, tool: e.target.value, arguments: {} })}
                >
                  <option value="">— Select tool —</option>
                  {mcpTools.map((t) => (
                    <option key={t.name} value={t.name}>
                      {t.name}{t.description ? ` — ${t.description.slice(0, 60)}` : ""}
                    </option>
                  ))}
                </select>
                {mcpTools.length === 0 && (
                  <div className="action-description">No tools available. Ensure the server is connected.</div>
                )}
              </div>
            )}

            {mcpTool && (
              <div className="editor-field">
                <label>Arguments (JSON)</label>
                <textarea
                  value={argsText}
                  onChange={(e) => {
                    setArgsText(e.target.value)
                    try {
                      const parsed = JSON.parse(e.target.value || "{}")
                      setArgsError(null)
                      updateAction({ type: "mcp", server: mcpServer, tool: mcpTool, arguments: parsed })
                    } catch (err) {
                      setArgsError(`Invalid JSON: ${String(err)}`)
                    }
                  }}
                  rows={5}
                  placeholder={"{\n  \"key\": \"value\"\n}"}
                />
                {argsError && <div className="action-description" style={{ color: "var(--danger)" }}>{argsError}</div>}
              </div>
            )}
          </>
        )}

        {/* Options */}
        <div className="editor-field">
          <label>Options</label>
          <div className="editor-toggles">
            <label className="editor-checkbox">
              <input
                type="checkbox"
                checked={rule.options.fireIfMissed}
                onChange={(e) => update({ options: { ...rule.options, fireIfMissed: e.target.checked } })}
              />
              Fire if missed
            </label>
            <label className="editor-checkbox">
              <input
                type="checkbox"
                checked={rule.options.disposeAfter}
                disabled={rule.target.type !== "sandbox"}
                onChange={(e) => update({ options: { ...rule.options, disposeAfter: e.target.checked } })}
              />
              Dispose sandbox after
            </label>
            <label className="editor-checkbox">
              <input
                type="checkbox"
                checked={rule.options.notifications}
                onChange={(e) => update({ options: { ...rule.options, notifications: e.target.checked } })}
              />
              Desktop notification
            </label>
          </div>
        </div>

        <div className="editor-actions">
          <button className="editor-save" onClick={() => onSave(rule)}>Save</button>
          <button className="editor-cancel" onClick={onClose}>Cancel</button>
          {!isNew && !confirmDelete && (
            <button className="editor-delete" title="Delete rule" onClick={() => setConfirmDelete(true)}><IconTrash size={15} /></button>
          )}
          {!isNew && confirmDelete && (
            <button className="editor-delete confirm" title="Confirm delete" onClick={() => onDelete(rule)}><IconTrash size={15} /> Delete</button>
          )}
        </div>
      </div>
    </div>
  )
}
