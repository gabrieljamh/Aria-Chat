import { exec, spawn, spawnSync } from "node:child_process"
import { join } from "node:path"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { Notification, app } from "electron"
import { createChatSandbox, deleteSandbox, ensureProjectMarker } from "./workspaces"
import type { MimoClient } from "./client"
import type { SchedulerRule, ExecutionLogEntry, SchedulerStats, RunningProcess } from "@shared/types"

/** Scheduler rules live in their own JSON file (not settings.json) to prevent
 *  cross-version settings corruption when multiple app instances share userData. */
function rulesFile(): string {
  return join(app.getPath("userData"), "scheduler", "SchedulerRules.json")
}

function serializeRule(r: SchedulerRule): SchedulerRule | null {
  if (!r || typeof r.id !== "string" || typeof r.name !== "string") return null
  return r
}

function loadRules(): SchedulerRule[] {
  const file = rulesFile()
  if (!existsSync(file)) return []
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    const items = Array.isArray(data?.items) ? data.items : []
    const rules: SchedulerRule[] = []
    for (const item of items) {
      const r = serializeRule(item as SchedulerRule)
      if (r) rules.push(r)
    }
    return rules
  } catch {
    return []
  }
}

function saveRules(rules: SchedulerRule[]) {
  const file = rulesFile()
  const dir = join(file, "..")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify({ items: rules }, null, 2))
}

type FireResult = { ok: true; detail?: string } | { ok: false; error: string }

/** Compute ms until the next fire of a schedule trigger. Returns null if none. */
function nextDelay(trigger: SchedulerRule["trigger"], now: Date = new Date()): number | null {
  if (trigger.type === "on-startup") return null // handled at boot

  if (trigger.type === "interval") {
    return trigger.minutes * 60_000
  }

  const [hh, mm] = trigger.time.split(":").map(Number)
  if (isNaN(hh) || isNaN(mm)) return null

  const target = new Date(now)
  target.setHours(hh, mm, 0, 0)

  if (trigger.type === "daily") {
    if (target.getTime() <= now.getTime()) target.setDate(target.getDate() + 1)
    return target.getTime() - now.getTime()
  }

  if (trigger.type === "weekly") {
    for (let i = 0; i <= 7; i++) {
      const candidate = new Date(target)
      candidate.setDate(candidate.getDate() + i)
      const day = candidate.getDay()
      if (trigger.days.includes(day) && candidate.getTime() > now.getTime()) {
        return candidate.getTime() - now.getTime()
      }
    }
    return null
  }

  return null
}

/** Check if a schedule was missed since lastFired. */
function wasMissed(rule: SchedulerRule, now: Date = new Date()): boolean {
  if (rule.trigger.type === "on-startup" || rule.trigger.type === "interval") return false
  if (!rule.lastFired) return false

  const [hh, mm] = rule.trigger.time.split(":").map(Number)
  const lastScheduled = new Date(rule.lastFired)
  lastScheduled.setHours(hh, mm, 0, 0)
  if (lastScheduled.getTime() < rule.lastFired) {
    lastScheduled.setDate(lastScheduled.getDate() + 1)
  }

  // If the scheduled time between lastFired and now was passed, it was missed
  const nextAfterLast = new Date(rule.lastFired)
  if (rule.trigger.type === "daily") {
    nextAfterLast.setDate(nextAfterLast.getDate() + 1)
  } else if (rule.trigger.type === "weekly") {
    for (let i = 1; i <= 7; i++) {
      const cand = new Date(rule.lastFired)
      cand.setDate(cand.getDate() + i)
      if (rule.trigger.days.includes(cand.getDay())) {
        nextAfterLast.setTime(cand.getTime())
        break
      }
    }
  }
  nextAfterLast.setHours(hh, mm, 0, 0)
  return now.getTime() > nextAfterLast.getTime()
}

function notify(title: string, body: string) {
  if (!Notification.isSupported()) return
  try {
    const ico = app.isPackaged
      ? join(__dirname, "../shared/img/aria-icon.png")
      : join(__dirname, "../../src/shared/img/aria-icon.png")
    const n = new Notification({ title, body, icon: ico })
    n.show()
  } catch {
    /* best-effort */
  }
}

export class Scheduler {
  private rules: SchedulerRule[] = []
  private timers = new Map<string, NodeJS.Timeout>()
  private client: () => MimoClient
  private running = false
  private executing = false
  private history: ExecutionLogEntry[] = []
  private runningProcesses = new Map<number, RunningProcess>()
  private stats: SchedulerStats = {
    total: 0, success: 0, running: 0, failed: 0,
    sandboxesCreated: 0, sandboxesDestroyed: 0, sessionsCreated: 0,
  }

  constructor(clientAccessor: () => MimoClient) {
    this.client = clientAccessor
  }

  /** Load rules from store, fire startup rules, arm timers, check missed. */
  async init() {
    this.rules = loadRules()
    this.running = true

    for (const rule of this.rules) {
      if (!rule.enabled) continue

      if (rule.trigger.type === "on-startup") {
        this.fire(rule)
      } else {
        // Check missed schedules
        if (rule.options.fireIfMissed && wasMissed(rule)) {
          this.fire(rule)
        }
        this.arm(rule)
      }
    }
  }

  /** Set a timeout for the next fire of a schedule rule. */
  private arm(rule: SchedulerRule) {
    this.clearTimer(rule.id)

    const delay = nextDelay(rule.trigger)
    if (delay === null) return

    const handle = setTimeout(() => {
      this.fire(rule)
      // Re-arm for next cycle (rule may have been updated)
      const updated = this.rules.find((r) => r.id === rule.id)
      if (updated && updated.enabled && updated.trigger.type !== "on-startup") {
        this.arm(updated)
      }
    }, delay)

    this.timers.set(rule.id, handle)
  }

  private clearTimer(id: string) {
    const h = this.timers.get(id)
    if (h) {
      clearTimeout(h)
      this.timers.delete(id)
    }
  }

  /** Execute a rule's action. Queued (max 1 concurrent). */
  private fire = async (rule: SchedulerRule) => {
    if (this.executing) {
      // Queue: retry after a short delay
      setTimeout(() => this.fire(rule), 5_000)
      return
    }
    this.executing = true

    const entry: ExecutionLogEntry = {
      id: crypto.randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      actionType: rule.action.type,
      triggerType: rule.trigger.type,
      status: "running",
      startedAt: Date.now(),
      targetLabel: this.targetLabel(rule),
    }
    this.history.push(entry)
    this.stats.total++
    this.stats.running++

    try {
      const result = await this.execute(rule)
      this.markFired(rule.id)

      if (result.ok) {
        entry.status = "success"
        entry.finishedAt = Date.now()
        entry.detail = result.detail
        this.stats.running = Math.max(0, this.stats.running - 1)
        this.stats.success++
        this.stats.lastSuccess = entry
      } else {
        entry.status = "failed"
        entry.finishedAt = Date.now()
        entry.detail = result.error
        this.stats.running = Math.max(0, this.stats.running - 1)
        this.stats.failed++
        this.stats.lastFailure = entry
      }

      // Skip the post-action notification for notify actions — they fire their own
      if (rule.options.notifications && rule.action.type !== "notify") {
        if (result.ok) {
          notify(`Scheduler: ${rule.name}`, result.detail ?? "Completed successfully")
        } else {
          notify(`Scheduler: ${rule.name}`, `Failed: ${result.error}`)
        }
      }
    } catch (err) {
      console.error(`[scheduler] rule "${rule.name}" threw:`, err)
      entry.status = "failed"
      entry.finishedAt = Date.now()
      entry.detail = String(err)
      this.stats.running = Math.max(0, this.stats.running - 1)
      this.stats.failed++
      this.stats.lastFailure = entry
      if (rule.options.notifications && rule.action.type !== "notify") {
        notify(`Scheduler: ${rule.name}`, `Error: ${String(err)}`)
      }
    } finally {
      this.executing = false
    }
  }

  /** Run the action for a rule. */
  private async execute(rule: SchedulerRule): Promise<FireResult> {
    const { action, target } = rule

    // Bash-only actions (no session needed)
    if (action.type === "bash") {
      return this.runBash(action.command, action.cwd)
    }
    if (action.type === "bash-detached") {
      return this.runBashDetached(action.command, action.cwd, rule.id, rule.name)
    }
    if (action.type === "notify") {
      notify(action.title, action.body)
      return { ok: true, detail: action.body }
    }

    // MCP tool call (no session needed, but needs a directory for the server instance)
    if (action.type === "mcp") {
      let directory: string | undefined
      if (target.type === "project") {
        directory = target.dir
      } else if (target.type === "sandbox") {
        directory = createChatSandbox().directory
        this.stats.sandboxesCreated++
      } else {
        // "none" target — use the first project's worktree as fallback
        const projects = await this.client().listProjects()
        const project = projects.find((p) => p.worktree)
        if (!project) return { ok: false, error: "No target directory for MCP tool call" }
        directory = project.worktree
      }

      try {
        const result = await this.client().callMcpTool(action.server, action.tool, action.arguments, directory)
        if (result?.isError) {
          const text = (result.content as ({ type?: string; text?: string }[])).find((c) => c.type === "text")
          return { ok: false, error: text?.text ?? "MCP tool returned an error" }
        }
        const text = (result?.content as ({ type?: string; text?: string }[]) | undefined)?.find((c) => c.type === "text")
        return { ok: true, detail: text?.text ?? "MCP tool call succeeded" }
      } catch (err) {
        return { ok: false, error: `MCP tool call failed: ${String(err)}` }
      }
    }

    // Session-based actions (prompt / command)
    if (action.type === "prompt" || action.type === "command") {
      let directory: string | undefined
      let sandboxDir: string | undefined

      if (target.type === "sandbox") {
        const sb = createChatSandbox()
        directory = sb.directory
        sandboxDir = sb.directory
        this.stats.sandboxesCreated++
      } else if (target.type === "project") {
        directory = target.dir
        ensureProjectMarker(directory)
      } else {
        return { ok: false, error: "No target directory for session action" }
      }

      try {
        const session = await this.client().createSession({ directory })
        this.stats.sessionsCreated++
        const sessionID = session.id

        if (action.type === "prompt") {
          await this.client().prompt({
            sessionID,
            text: action.text,
            model: action.model,
            agent: action.agent,
            directory,
          })

          // Read back the AI's response for the notification body
          let aiResponse = ""
          try {
            const messages = await this.client().getMessages(sessionID, directory)
            for (const m of messages) {
              if (m.info.role !== "assistant") continue
              for (const p of m.parts) {
                if ((p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
                  aiResponse += (p as { text: string }).text
                }
              }
            }
          } catch { /* best-effort */ }

          return { ok: true, detail: aiResponse.trim() || `Session ${sessionID} created and prompt sent` }
        } else {
          await this.client().sendCommand({
            sessionID,
            command: action.command,
            arguments: action.args ?? "",
            directory,
          })
        }

        // Wait for session to become idle (poll messages — the prompt() call
        // resolves only after the HTTP response, but the AI turn continues via
        // SSE. For the scheduler we treat the HTTP response as completion.)
        return { ok: true, detail: `Session ${sessionID} created and prompt sent` }
      } finally {
        if (sandboxDir && rule.options.disposeAfter) {
          try { deleteSandbox(sandboxDir); this.stats.sandboxesDestroyed++ } catch {}
        }
      }
    }

    return { ok: false, error: `Unknown action type` }
  }

  private runBash(command: string, cwd?: string): Promise<FireResult> {
    return new Promise((resolve) => {
      exec(command, { cwd: cwd ?? app.getAppPath(), timeout: 120_000 }, (err, stdout, stderr) => {
        if (err) {
          resolve({ ok: false, error: `${err.message}${stderr ? "\n" + stderr : ""}` })
        } else {
          resolve({ ok: true, detail: stdout.trim() || stderr.trim() || "Command completed" })
        }
      })
    })
  }

  private runBashDetached(command: string, cwd: string | undefined, ruleId: string, ruleName: string): FireResult {
    const child = spawn(command, {
      cwd: cwd ?? app.getAppPath(),
      shell: true,
      detached: true,
      stdio: "ignore",
    })
    const pid = child.pid ?? 0
    if (pid) {
      const rp: RunningProcess = { pid, ruleId, ruleName, command, startedAt: Date.now() }
      this.runningProcesses.set(pid, rp)
      child.on("exit", () => {
        this.runningProcesses.delete(pid)
      })
    }
    child.unref()
    return { ok: true, detail: `Detached process PID ${pid}` }
  }

  private markFired(id: string) {
    const rule = this.rules.find((r) => r.id === id)
    if (!rule) return
    rule.lastFired = Date.now()
    saveRules(this.rules)
  }

  /** Reload rules from store (called when renderer updates config). */
  reload() {
    this.dispose()
    this.rules = loadRules()
    this.running = true
    for (const rule of this.rules) {
      if (!rule.enabled) continue
      if (rule.trigger.type === "on-startup") continue // already fired at boot
      if (rule.options.fireIfMissed && wasMissed(rule)) {
        this.fire(rule)
      }
      this.arm(rule)
    }
  }

  /** Run a specific rule immediately (manual trigger). */
  runNow(ruleId: string): boolean {
    const rule = this.rules.find((r) => r.id === ruleId)
    if (!rule) return false
    this.fire(rule)
    return true
  }

  private targetLabel(rule: SchedulerRule): string {
    if (rule.target.type === "sandbox") return "Sandbox"
    if (rule.target.type === "project") return rule.target.dir.split(/[\\/]/).pop() ?? rule.target.dir
    return "None"
  }

  getStats(): SchedulerStats {
    return { ...this.stats, running: this.runningProcesses.size }
  }

  getHistory(): ExecutionLogEntry[] {
    return [...this.history].reverse().slice(0, 200)
  }

  getRunningProcesses(): RunningProcess[] {
    return Array.from(this.runningProcesses.values())
  }

  async killProcess(pid: number): Promise<boolean> {
    const proc = this.runningProcesses.get(pid)
    if (!proc) return false
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true })
      } else {
        process.kill(pid, "SIGTERM")
      }
      this.runningProcesses.delete(pid)
      const entry = this.history.find((e) => e.ruleId === proc.ruleId && e.status === "running")
      if (entry) {
        entry.status = "failed"
        entry.finishedAt = Date.now()
        entry.detail = "Killed by user"
      }
      this.stats.failed++
      return true
    } catch {
      return false
    }
  }

  /** Clear all timers. */
  dispose() {
    this.running = false
    for (const [, handle] of this.timers) clearTimeout(handle)
    this.timers.clear()
  }
}

export { loadRules, saveRules }
