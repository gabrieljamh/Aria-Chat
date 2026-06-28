import { spawn, type ChildProcess, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { EventEmitter } from "node:events"
import type { ServerStatus } from "@shared/types"
import { sanitizeGlobalConfig } from "./ipc"
import { getStore } from "./store"

/**
 * Manages the MiMo Code local server: either attaches to an already-running
 * instance (MIMO_SERVER_URL / stored setting) or spawns `serve` as a child
 * process and waits for the "mimocode server listening on <url>" line.
 *
 * See ../../API_NOTES.md for the contract this relies on.
 */

const LISTEN_RE = /listening on\s+(https?:\/\/[^\s]+)/i

// Cold starts compile the server with Bun and can take a while on a slow or
// busy machine / first run; a 30s cap tripped intermittently. Process exit /
// spawn errors still reject early, so this only bounds a genuinely slow boot.
const START_TIMEOUT_MS = 60_000

// A ready server must survive at least this long before a crash earns another
// automatic restart; shorter-lived crashes are treated as a crash loop.
const RESTART_COOLDOWN_MS = 10_000

export interface ServerHandle {
  url: string
  spawned: boolean
}

export class ServerManager extends EventEmitter {
  private proc: ChildProcess | null = null
  private handle: ServerHandle | null = null
  private status: ServerStatus = { state: "stopped" }
  private credentials: { username: string; password: string } | null = null
  // Distinguishes a deliberate stop() (clean "stopped") from the process dying
  // on its own (a crash that must surface as an error, not a silent "stopped").
  private intentionalStop = false
  // Remembered so an auto-restart can respawn with the same settings.
  private lastOpts: { attachUrl?: string | null; attachPassword?: string | null; port?: number } = {}
  // Timestamp of the last (re)start, used to avoid a tight crash-restart loop.
  private lastStartAt = 0

  getCredentials(): { username: string; password: string } | null {
    return this.credentials
  }

  getStatus(): ServerStatus {
    return this.status
  }

  getUrl(): string | null {
    return this.handle?.url ?? null
  }

  private setStatus(status: ServerStatus) {
    this.status = status
    this.emit("status", status)
  }

  /** Find the monorepo root by walking up looking for packages/opencode. */
  private findRepoRoot(): string | null {
    let dir = process.cwd()
    for (let i = 0; i < 8; i++) {
      if (existsSync(join(dir, "packages", "opencode", "src", "index.ts"))) return dir
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
    return null
  }

  private which(cmd: string): boolean {
    const probe = process.platform === "win32" ? "where" : "which"
    try {
      return spawnSync(probe, [cmd], { stdio: "ignore" }).status === 0
    } catch {
      return false
    }
  }

  async start(opts: { attachUrl?: string | null; attachPassword?: string | null; port?: number } = {}): Promise<ServerHandle> {
    if (this.handle) return this.handle
    this.lastOpts = opts
    this.intentionalStop = false
    this.setStatus({ state: "starting" })

    const attachUrl = opts.attachUrl || process.env.MIMO_SERVER_URL || null
    if (attachUrl) {
      const pw = opts.attachPassword || process.env.MIMO_SERVER_PASSWORD || null
      this.credentials = pw ? { username: "mimocode", password: pw } : null
      const ok = await this.waitForHealth(attachUrl, 10_000)
      if (!ok) {
        this.setStatus({ state: "error", message: `Could not reach server at ${attachUrl}` })
        throw new Error(`Could not reach MiMo Code server at ${attachUrl}`)
      }
      this.handle = { url: attachUrl.replace(/\/$/, ""), spawned: false }
      this.setStatus({ state: "ready", url: this.handle.url })
      return this.handle
    }

    return this.bringUp(opts.port ?? 0)
  }

  /** Spawn the child, health-check it, and mark ready. Shared by start + restart. */
  private async bringUp(port: number): Promise<ServerHandle> {
    this.lastStartAt = Date.now()
    // Sanitize global config before server reads it (removes undefined values)
    await sanitizeGlobalConfig()
    const url = await this.spawn(port)
    // The "listening on" line means the HTTP server is up, but confirm it
    // actually answers /global/health before declaring ready. This also catches
    // a misparsed URL: otherwise we'd sit on a dead port while the app looks
    // "ready" but every request fails.
    const healthy = await this.waitForHealth(url, 15_000)
    if (!healthy) {
      this.stop()
      const message = `MiMo Code server started at ${url} but never answered /global/health.`
      this.setStatus({ state: "error", message })
      throw new Error(message)
    }
    this.handle = { url, spawned: true }
    this.setStatus({ state: "ready", url })
    return this.handle
  }

  /**
   * Respawn after an unexpected crash. One-shot per crash with a cooldown: if the
   * server had been up for less than RESTART_COOLDOWN_MS we give up (it is crash-
   * looping) and surface an error rather than restarting forever. On success the
   * "respawn" event lets the IPC layer rebuild its client against the new URL.
   */
  private async restart(code: number | null, signal: NodeJS.Signals | null) {
    const detail = `code ${code}${signal ? `, signal ${signal}` : ""}`
    if (Date.now() - this.lastStartAt < RESTART_COOLDOWN_MS) {
      this.setStatus({
        state: "error",
        message: `MiMo Code server keeps exiting (${detail}). Giving up after an automatic restart.`,
      })
      return
    }
    this.handle = null
    this.proc = null
    this.intentionalStop = false
    this.setStatus({ state: "starting" })
    try {
      await this.bringUp(this.lastOpts.port ?? 0)
      this.emit("respawn")
    } catch (err) {
      this.setStatus({ state: "error", message: `Automatic restart failed: ${String((err as Error)?.message ?? err)}` })
    }
  }

  /** Look for a bundled server binary next to the Electron executable. */
  private findBundledBinary(): string | null {
    const exeDir = dirname(process.execPath)
    const name = process.platform === "win32" ? "mimo.exe" : "mimo"
    const candidate = join(exeDir, "server", name)
    if (existsSync(candidate)) return candidate
    return null
  }

  private spawn(port: number): Promise<string> {
    const repoRoot = this.findRepoRoot()
    // In a portable distribution there is no repo root — prefer the bundled
    // server binary shipped alongside the Electron app.
    const bundled = this.findBundledBinary()
    if (bundled) {
      return this.spawnBinary(bundled, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], dirname(bundled))
    }
    if (!repoRoot) {
      const message =
        "Could not locate the MiMo Code repo (packages/opencode). Run the desktop app from inside the repo, or set MIMO_SERVER_URL to an already-running server."
      this.setStatus({ state: "error", message })
      return Promise.reject(new Error(message))
    }

    // Prefer bun (the repo's runtime). Fall back to an installed `opencode`/
    // `mimocode` binary if bun is unavailable.
    let command: string
    let args: string[]
    // Default cwd is the repo root, but Bun must run with cwd =
    // packages/opencode so it picks up that package's tsconfig
    // (jsxImportSource: solid-js) and node_modules. Running from the repo root
    // makes Bun compile the TUI's .tsx with React's jsx-dev-runtime, which is
    // not installed -> "Cannot find module 'react/jsx-dev-runtime'".
    let cwd = repoRoot
    if (this.which("bun")) {
      command = "bun"
      cwd = join(repoRoot, "packages", "opencode")
      args = [
        "run",
        "--conditions=browser",
        join("src", "index.ts"),
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ]
      return this.spawnBinary(command, args, cwd)
    } else if (this.which("opencode")) {
      command = "opencode"
      args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
      return this.spawnBinary(command, args, cwd)
    } else if (this.which("mimocode")) {
      command = "mimocode"
      args = ["serve", "--hostname", "127.0.0.1", "--port", String(port)]
      return this.spawnBinary(command, args, cwd)
    } else {
      const message = "Neither `bun` nor an `opencode`/`mimocode` binary was found on PATH."
      this.setStatus({ state: "error", message })
      return Promise.reject(new Error(message))
    }
  }

  /** Spawn the actual child process and wire up stdout/stderr promise. */
  private async spawnBinary(command: string, args: string[], cwd: string): Promise<string> {
    // Sanitize global config (strip undefined values that cause validation errors)
    // before the server reads it. This handles configs written before the fix.
    await sanitizeGlobalConfig()

    // Get GitHub credentials from settings for git push auth
    const store = getStore()
    const githubUsername = (store.get("githubUsername") as string | undefined) ?? ""
    const githubToken = (store.get("githubToken") as string | undefined) ?? ""

    // Run the server with a random local-only password so the app can use
    // working directories OUTSIDE the repo (e.g. per-chat sandboxes under
    // AppData). Without a password the server confines every request to its
    // own cwd. The password never leaves this machine.
    const password = randomBytes(24).toString("base64url")
    this.credentials = { username: "mimocode", password }

    const proc = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        MIMOCODE_CLIENT: "desktop",
        MIMOCODE_SERVER_USERNAME: "mimocode",
        MIMOCODE_SERVER_PASSWORD: password,
        MIMOCODE_DISABLE_GIT: "1",
        GIT_USERNAME: githubUsername,
        GIT_PASSWORD: githubToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.proc = proc

    return new Promise<string>((resolvePromise, reject) => {
      let buffer = ""
      let settled = false
      const timeout = setTimeout(() => {
        if (settled) return
        settled = true
        this.stop()
        reject(
          new Error(
            `Timed out waiting for MiMo Code server to start (${START_TIMEOUT_MS / 1000}s). ` +
              `Last output:\n${buffer.slice(-2000) || "(none)"}`,
          ),
        )
      }, START_TIMEOUT_MS)

      const onData = (chunk: Buffer) => {
        buffer += chunk.toString()
        if (settled) return
        // Match only on COMPLETE lines (up to the last newline). A pipe can split
        // a chunk mid-line, and matching the partial buffer captured a truncated
        // URL when the break landed inside the port (".../127.0.0.1:503" + "21"),
        // so the app then dialed a dead port. Waiting for the trailing newline
        // guarantees the captured URL is whole. console.log always terminates it.
        const lastNewline = buffer.lastIndexOf("\n")
        if (lastNewline === -1) return
        const match = buffer.slice(0, lastNewline).match(LISTEN_RE)
        if (match) {
          settled = true
          clearTimeout(timeout)
          resolvePromise(match[1].replace(/\/$/, ""))
        }
      }

      proc.stdout?.on("data", onData)
      proc.stderr?.on("data", onData)

      proc.on("exit", (code, signal) => {
        this.handle = null
        if (!settled) {
          // Died before it ever announced a listening URL.
          settled = true
          clearTimeout(timeout)
          reject(
            new Error(
              `MiMo Code server exited (code ${code}${signal ? `, signal ${signal}` : ""}) ` +
                `before becoming ready.\nLast output:\n${buffer.slice(-2000) || "(none)"}`,
            ),
          )
          return
        }
        // Exited AFTER it was up. A deliberate stop() is a clean shutdown; an
        // unexpected exit is a crash and must surface as an error. Previously this
        // always reported a bland "stopped", which hid the real cause and also
        // clobbered an error we had just set (e.g. a failed health check).
        if (this.status.state === "error") return
        if (this.intentionalStop) {
          this.setStatus({ state: "stopped" })
          return
        }
        // Crashed on its own while up: attempt one automatic restart (the SSE
        // client gets rebuilt by the IPC layer on the "respawn" event).
        console.warn(`[mimo-server] server exited unexpectedly (code ${code}, signal ${signal}); restarting once`)
        void this.restart(code, signal)
      })
      proc.on("error", (err) => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        reject(err)
      })
    })
  }

  private async waitForHealth(url: string, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    const healthUrl = new URL("/global/health", url).toString()
    const headers: Record<string, string> = {}
    if (this.credentials) {
      const basic = Buffer.from(`${this.credentials.username}:${this.credentials.password}`).toString("base64")
      headers["authorization"] = `Basic ${basic}`
    }
    while (Date.now() < deadline) {
      try {
        const res = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(2_000) })
        if (res.ok) return true
      } catch {
        /* retry */
      }
      await new Promise((r) => setTimeout(r, 200))
    }
    return false
  }

  stop() {
    this.intentionalStop = true
    const proc = this.proc
    this.proc = null
    this.handle = null
    if (!proc) return
    if (proc.exitCode !== null || proc.signalCode !== null) return
    if (process.platform === "win32" && proc.pid) {
      try {
        spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true })
        return
      } catch {
        /* fall through */
      }
    }
    proc.kill()
  }
}
