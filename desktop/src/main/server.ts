import { spawn, type ChildProcess, spawnSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs"
import { dirname, join, relative, sep } from "node:path"
import { EventEmitter } from "node:events"
import type { ServerStatus } from "@shared/types"
import { sanitizeGlobalConfig } from "./ipc"
import { getStore } from "./store"
import { getBrowserServerUrl } from "./index"
import { dlog } from "./logger"

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
      dlog.error("server", "crash loop detected — giving up on automatic restarts", { detail })
      this.setStatus({
        state: "error",
        message: `MiMo Code server keeps exiting (${detail}). Giving up after an automatic restart.`,
      })
      return
    }
    dlog.warn("server", "attempting automatic restart", { detail })
    this.handle = null
    this.proc = null
    this.intentionalStop = false
    this.setStatus({ state: "starting" })
    try {
      await this.bringUp(this.lastOpts.port ?? 0)
      this.emit("respawn")
    } catch (err) {
      dlog.error("server", "automatic restart failed", { error: String((err as Error)?.message ?? err) })
      this.setStatus({ state: "error", message: `Automatic restart failed: ${String((err as Error)?.message ?? err)}` })
    }
  }

  /**
   * On-demand recovery: called when a request hits a connection failure
   * (ECONNREFUSED etc.) while we believe we spawned a server. Covers the gap
   * the automatic restart leaves behind — after a crash loop it gives up and
   * the user is stranded with endless "fetch failed" until they restart the
   * whole app. A revive is only attempted from a settled bad state, never
   * while starting/stopping, and is rate-limited by the same cooldown.
   */
  private reviveInFlight = false
  async revive(): Promise<boolean> {
    if (this.reviveInFlight || this.intentionalStop) return false
    if (this.status.state === "starting") return false
    if (this.proc && this.proc.exitCode === null) return false // child still alive
    if (this.handle && !this.handle.spawned) return false // attached server: not ours to spawn
    this.reviveInFlight = true
    dlog.warn("server", "revive requested after connection failure")
    try {
      this.handle = null
      this.proc = null
      this.setStatus({ state: "starting" })
      await this.bringUp(this.lastOpts.port ?? 0)
      this.emit("respawn")
      return true
    } catch (err) {
      dlog.error("server", "revive failed", { error: String((err as Error)?.message ?? err) })
      this.setStatus({ state: "error", message: `Server revive failed: ${String((err as Error)?.message ?? err)}` })
      return false
    } finally {
      this.reviveInFlight = false
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

  /**
   * Dev-mode optimization: build a native `mimo` binary once and cache it,
   * rebuilding only when server sources change. Hashes all .ts/.tsx files
   * under packages/opencode/src/ (mtime+size) plus key config files; if the
   * hash matches a cached binary, returns it instantly. Otherwise runs
   * `bun build:dev` to produce a fresh binary and updates the cache.
   */
  /**
   * Mtime+size hash over the server sources that should trigger a rebuild.
   * Skips build-generated files (models-snapshot.*): `script/generate.ts`
   * rewrites them on EVERY build, so including them made a pre-build hash
   * permanently stale — the cache never hit and the app rebuilt every launch.
   */
  private computeDevHash(repoRoot: string): string {
    const srcDir = join(repoRoot, "packages", "opencode", "src")
    const trackedConfigs = [
      join(repoRoot, "packages", "opencode", "package.json"),
      join(repoRoot, "packages", "opencode", "tsconfig.json"),
      join(repoRoot, "packages", "opencode", "script", "build.ts"),
    ]
    const entries: string[] = []
    const walk = (dir: string) => {
      let items: import("node:fs").Dirent[]
      try {
        items = readdirSync(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const item of items) {
        const full = join(dir, item.name)
        if (item.isDirectory()) {
          if (item.name === "node_modules" || item.name === "dist" || item.name === ".artifacts") continue
          walk(full)
        } else if (item.isFile() && (item.name.endsWith(".ts") || item.name.endsWith(".tsx"))) {
          // Generated on every build — never a reason to rebuild.
          if (item.name.startsWith("models-snapshot.")) continue
          try {
            const stat = statSync(full)
            entries.push(`${relative(repoRoot, full).replace(/\\/g, "/")}|${stat.mtimeMs}|${stat.size}`)
          } catch {
            /* skip unreadable */
          }
        }
      }
    }
    walk(srcDir)
    for (const cfg of trackedConfigs) {
      if (!existsSync(cfg)) continue
      try {
        const stat = statSync(cfg)
        entries.push(`${relative(repoRoot, cfg).replace(/\\/g, "/")}|${stat.mtimeMs}|${stat.size}`)
      } catch {
        /* skip */
      }
    }
    entries.sort()
    return entries.join("\n")
  }

  private async ensureDevBinary(repoRoot: string): Promise<string | null> {
    if (!this.which("bun")) return null

    const cacheDir = join(repoRoot, "desktop", ".server-cache")
    const binName = process.platform === "win32" ? "mimo.exe" : "mimo"
    const cachedBin = join(cacheDir, binName)
    const hashFile = join(cacheDir, "hash.json")

    const hash = this.computeDevHash(repoRoot)

    // Check cache
    try {
      const cached = JSON.parse(readFileSync(hashFile, "utf-8"))
      if (cached.hash === hash && existsSync(cachedBin)) {
        return cachedBin
      }
    } catch {
      /* no cache or corrupt — rebuild */
    }

    // Rebuild. MUST be async: the old spawnSync blocked the Electron main
    // process event loop for the whole build, starving Chromium's network
    // service ("Network service crashed, restarting service.") and leaving
    // the app stuck before the window ever appeared.
    this.setStatus({ state: "starting", message: "Rebuilding server binary (sources changed)..." })
    console.log("[mimo-server] server sources changed, rebuilding binary...")
    const buildCwd = join(repoRoot, "packages", "opencode")
    const built = await new Promise<boolean>((resolve) => {
      let output = ""
      let done = false
      const finish = (ok: boolean) => {
        if (done) return
        done = true
        clearTimeout(timer)
        if (!ok && output) console.error("[mimo-server] build failed:", output.slice(-4000))
        resolve(ok)
      }
      const proc = spawn("bun", ["run", "build:dev"], {
        cwd: buildCwd,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
      })
      // Generous cap: a cold bun compile on a busy machine can exceed the old
      // 120s limit, which made the build "fail" and fall back to slow JIT.
      const timer = setTimeout(() => {
        proc.kill()
        console.error("[mimo-server] build timed out")
        finish(false)
      }, 300_000)
      proc.stdout?.on("data", (d: Buffer) => (output += d.toString()))
      proc.stderr?.on("data", (d: Buffer) => (output += d.toString()))
      proc.on("exit", (code) => finish(code === 0))
      proc.on("error", (err) => {
        console.error("[mimo-server] build error:", err)
        finish(false)
      })
    })
    if (!built) return null

    // Re-hash AFTER the build: codegen inside `build:dev` touches sources, so
    // a pre-build hash would never match on the next launch.
    const finalHash = this.computeDevHash(repoRoot)

    // Find the built binary — output dir is dist/mimocode-<os>-<arch>/bin/mimo[.exe]
    const distDir = join(buildCwd, "dist")
    const osName = process.platform === "win32" ? "windows" : process.platform
    const expectedDir = `mimocode-${osName}-${process.arch}`
    const builtBin = join(distDir, expectedDir, "bin", binName)

    if (!existsSync(builtBin)) {
      // Search dist/ for any matching binary
      try {
        for (const sub of readdirSync(distDir, { withFileTypes: true })) {
          if (!sub.isDirectory()) continue
          const candidate = join(distDir, sub.name, "bin", binName)
          if (existsSync(candidate)) {
            mkdirSync(cacheDir, { recursive: true })
            copyFileSync(candidate, cachedBin)
            writeFileSync(hashFile, JSON.stringify({ hash: finalHash, built: Date.now() }))
            console.log("[mimo-server] binary rebuilt + cached")
            return cachedBin
          }
        }
      } catch {
        /* fall through */
      }
      console.error("[mimo-server] could not find built binary in dist/")
      return null
    }

    mkdirSync(cacheDir, { recursive: true })
    copyFileSync(builtBin, cachedBin)
    writeFileSync(hashFile, JSON.stringify({ hash: finalHash, built: Date.now() }))
    console.log("[mimo-server] binary rebuilt + cached")
    return cachedBin
  }

  /**
   * Kill stale `mimo serve` processes left behind by a crashed/killed desktop.
   * The server's retry loop has no owner once the app dies — an orphan keeps
   * hammering the provider with retries forever, invisibly. Runs only on the
   * spawn path (attaching to an external server never reaches here).
   */
  private killOrphanServers() {
    try {
      if (process.platform === "win32") {
        spawnSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-Command",
            "Get-CimInstance Win32_Process -Filter \"Name='mimo.exe'\" | Where-Object { $_.CommandLine -match ' serve' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
          ],
          { windowsHide: true, timeout: 10_000 },
        )
      } else {
        spawnSync("pkill", ["-f", "mimo serve"], { timeout: 5_000 })
      }
    } catch {
      /* best-effort */
    }
  }

  private spawn(port: number): Promise<string> {
    this.killOrphanServers()
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

    // Dev mode: try to use a cached/rebuilt native binary before falling
    // back to JIT-compiling with `bun run src/index.ts`. The native binary
    // starts in ~1s vs 5-15s for a cold JIT compile.
    return this.ensureDevBinary(repoRoot).then((devBin) => {
      if (devBin) {
        return this.spawnBinary(devBin, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], repoRoot)
      }

      // Fall back to JIT-compile path if bun is available
      let command: string
      let args: string[]
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
    })
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
        // Enable snapshots (and therefore session diffs / the Tasker DiffGrid)
        // for EVERY project, git repo or not. Snapshots use their own shadow
        // git dir under <data>/snapshot with the project as work-tree, so the
        // project itself never needs git — and with MIMOCODE_DISABLE_GIT the
        // worktree is already anchored at the project directory. Gated on a
        // usable git binary: without one, snapshot tracking must stay off.
        ...(this.which("git") ? { MIMOCODE_FAKE_VCS: "git" } : {}),
        MIMOCODE_EXPERIMENTAL_WEB_AGENT: "1",
        MIMOCODE_WEB_AGENT_BRIDGE: (await getBrowserServerUrl()) ?? "",
        // Same local bridge server also hosts /list-apps and /run-app for the
        // run_app / list_apps tools (launching user-registered applications).
        MIMOCODE_DESKTOP_BRIDGE: (await getBrowserServerUrl()) ?? "",
        GIT_USERNAME: githubUsername,
        GIT_PASSWORD: githubToken,
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    this.proc = proc

    dlog.info("server", "spawning", { command, args, cwd })
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
        // Rolling tail: the server logs for its whole lifetime through this
        // handler — unbounded growth is a slow leak, and for crash forensics
        // only the tail matters anyway.
        if (buffer.length > 16_384) buffer = buffer.slice(-16_384)
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
          dlog.info("server", "listening", { url: match[1] })
          resolvePromise(match[1].replace(/\/$/, ""))
        }
      }

      proc.stdout?.on("data", onData)
      proc.stderr?.on("data", onData)

      proc.on("exit", (code, signal) => {
        this.handle = null
        // Always record WHY the server went away — the tail of its output is
        // the single most useful artifact when a user reports "fetch failed".
        dlog[this.intentionalStop ? "info" : "error"]("server", "server exited", {
          code,
          signal,
          intentional: this.intentionalStop,
          tail: buffer.slice(-3000),
        })
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
