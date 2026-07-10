import { spawn } from "node:child_process"
import { basename } from "node:path"
import { existsSync } from "node:fs"
import { getStore } from "./store"
import type { ExecuteApp } from "@shared/types"

/** All apps the user has registered in Settings → Applications. */
export function getRegisteredApps(): ExecuteApp[] {
  const list = getStore().get("executeApps")
  return Array.isArray(list) ? (list as ExecuteApp[]) : []
}

/**
 * Resolve a free-form query (from the model) to a registered app. Matches, in
 * priority order: exact id, exact name, exact binary basename, then a
 * case-insensitive substring on name or basename. Returns null if nothing fits.
 */
export function resolveApp(query: string): ExecuteApp | null {
  const apps = getRegisteredApps()
  if (!query) return null
  const byId = apps.find((a) => a.id === query)
  if (byId) return byId
  const q = query.trim().toLowerCase()
  const base = (a: ExecuteApp) => basename(a.path).toLowerCase()
  return (
    apps.find((a) => a.name.toLowerCase() === q) ??
    apps.find((a) => base(a) === q || base(a).replace(/\.[^.]+$/, "") === q) ??
    apps.find((a) => a.name.toLowerCase().includes(q) || base(a).includes(q)) ??
    null
  )
}

/** Split an argument string on spaces, respecting single/double quotes. */
function parseArgs(input?: string): string[] {
  if (!input) return []
  const out: string[] = []
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(input)) !== null) out.push(m[1] ?? m[2] ?? m[3] ?? "")
  return out
}

/**
 * Launch a registered app detached (so it outlives the turn / the scheduler
 * tick). Cross-platform: macOS `.app` bundles go through `open -a`; everything
 * else is spawned directly. Extra args from the caller are appended to the
 * app's configured default args.
 */
export function launchApp(appEntry: ExecuteApp, extraArgs?: string): { ok: boolean; pid?: number; error?: string } {
  if (!appEntry?.path) return { ok: false, error: "App has no path configured" }
  if (!existsSync(appEntry.path)) return { ok: false, error: `Path does not exist: ${appEntry.path}` }

  const args = [...parseArgs(appEntry.args), ...parseArgs(extraArgs)]
  const cwd = appEntry.cwd && existsSync(appEntry.cwd) ? appEntry.cwd : undefined

  try {
    let child
    if (process.platform === "darwin" && appEntry.path.endsWith(".app")) {
      const openArgs = ["-a", appEntry.path]
      if (args.length) openArgs.push("--args", ...args)
      child = spawn("open", openArgs, { detached: true, stdio: "ignore", cwd })
    } else if (process.platform === "win32") {
      // Windows CreateProcess can only launch .exe directly. For .bat/.cmd/.ps1
      // / .lnk paths we need shell:true so cmd.exe resolves them; for .exe paths
      // shell:true is also safer (handles paths with parens/quoted segments).
      // Build a single command-line string (no args array) so Node doesn't emit
      // DEP0190 about unescaped args with shell:true.
      const quotedPath = `"${appEntry.path}"`
      const fullCmd = args.length ? `${quotedPath} ${args.join(" ")}` : quotedPath
      child = spawn(fullCmd, [], { shell: true, detached: true, stdio: "ignore", cwd, windowsHide: false })
    } else {
      child = spawn(appEntry.path, args, { detached: true, stdio: "ignore", cwd, windowsHide: false })
    }
    const pid = child.pid
    let asyncError: string | undefined
    child.on("error", (e) => {
      asyncError = e instanceof Error ? e.message : String(e)
    })
    child.unref()
    if (!pid) return { ok: false, error: asyncError ?? "Failed to start process" }
    return { ok: true, pid }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

/** Convenience: resolve + launch by free-form query (used by the desktop bridge). */
export function launchByQuery(query: string, extraArgs?: string): { ok: boolean; pid?: number; error?: string; app?: ExecuteApp } {
  const app = resolveApp(query)
  if (!app) return { ok: false, error: `No registered app matches "${query}"` }
  return { ...launchApp(app, extraArgs), app }
}
