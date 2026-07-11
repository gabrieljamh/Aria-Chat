import { app } from "electron"
import * as fs from "node:fs"
import { join } from "node:path"

/**
 * Focused debug log for the Aria desktop main process.
 *
 * Everything that matters for post-mortem debugging lands here — most
 * importantly FAILED HTTP REQUESTS with their status + error body and
 * connection-level fetch failures with the full undici cause chain
 * (ECONNREFUSED & friends), which Electron IPC otherwise strips down to a
 * useless "TypeError: fetch failed".
 *
 * Location: <userData>/logs/aria-main.log  (e.g. %APPDATA%/aria-desktop/logs)
 * Rotation: 5 MB → aria-main.log.1 (single backup, no daemon, no deps).
 */

const MAX_BYTES = 5 * 1024 * 1024
const MAX_DATA_CHARS = 4000

let cachedPath: string | null = null

function logFile(): string | null {
  if (cachedPath) return cachedPath
  try {
    // userData is unavailable before app is ready in rare early paths — retry later.
    const dir = join(app.getPath("userData"), "logs")
    fs.mkdirSync(dir, { recursive: true })
    cachedPath = join(dir, "aria-main.log")
    return cachedPath
  } catch {
    return null
  }
}

function rotate(file: string) {
  try {
    const { size } = fs.statSync(file)
    if (size < MAX_BYTES) return
    fs.rmSync(`${file}.1`, { force: true })
    fs.renameSync(file, `${file}.1`)
  } catch {
    /* first write or race — ignore */
  }
}

function write(level: "INFO" | "WARN" | "ERROR", component: string, msg: string, data?: unknown) {
  let suffix = ""
  if (data !== undefined) {
    try {
      suffix = " " + JSON.stringify(data)
    } catch {
      suffix = " " + String(data)
    }
    if (suffix.length > MAX_DATA_CHARS) suffix = suffix.slice(0, MAX_DATA_CHARS) + "…[truncated]"
  }
  const line = `${new Date().toISOString()} ${level.padEnd(5)} [${component}] ${msg}${suffix}`
  // Mirror to the console so `npm run dev` users see it live.
  if (level === "ERROR") console.error(line)
  else if (level === "WARN") console.warn(line)
  else console.log(line)
  const file = logFile()
  if (!file) return
  try {
    rotate(file)
    fs.appendFileSync(file, line + "\n")
  } catch {
    /* disk full / permissions — logging must never crash the app */
  }
}

export const dlog = {
  info: (component: string, msg: string, data?: unknown) => write("INFO", component, msg, data),
  warn: (component: string, msg: string, data?: unknown) => write("WARN", component, msg, data),
  error: (component: string, msg: string, data?: unknown) => write("ERROR", component, msg, data),
  /** Absolute path of the log file (for "open log" affordances). */
  path: (): string | null => logFile(),
}

/**
 * Human-readable description of an error INCLUDING its cause chain.
 * undici buries the actionable part ("connect ECONNREFUSED 127.0.0.1:4096")
 * inside err.cause (sometimes an AggregateError) while err.message is just
 * "fetch failed" — this digs it out.
 */
export function describeError(err: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; depth < 6 && cur && !seen.has(cur); depth++) {
    seen.add(cur)
    if (cur instanceof AggregateError && cur.errors?.length) {
      parts.push(cur.message || cur.name)
      for (const e of cur.errors.slice(0, 3)) {
        const anyE = e as { code?: string; message?: string }
        parts.push(anyE.code ? `${anyE.code}${anyE.message ? ` ${anyE.message}` : ""}` : String(anyE.message ?? e))
      }
      cur = undefined
      break
    }
    const anyErr = cur as { code?: string; errno?: unknown; syscall?: string; address?: string; port?: number; message?: string; cause?: unknown }
    const bits = [
      anyErr.code,
      anyErr.syscall && anyErr.syscall !== anyErr.code ? anyErr.syscall : undefined,
      anyErr.address ? `${anyErr.address}${anyErr.port ? `:${anyErr.port}` : ""}` : undefined,
    ].filter(Boolean)
    if (bits.length) parts.push(bits.join(" "))
    else if (anyErr.message && !parts.includes(anyErr.message)) parts.push(anyErr.message)
    cur = anyErr.cause
  }
  return parts.filter(Boolean).join(" <- ") || String(err)
}

/** First error code found anywhere in the cause chain (e.g. "ECONNREFUSED"). */
export function errorCode(err: unknown): string | undefined {
  const seen = new Set<unknown>()
  let cur: unknown = err
  for (let depth = 0; depth < 6 && cur && !seen.has(cur); depth++) {
    seen.add(cur)
    const anyErr = cur as { code?: string; cause?: unknown; errors?: unknown[] }
    if (typeof anyErr.code === "string") return anyErr.code
    if (Array.isArray(anyErr.errors)) {
      for (const e of anyErr.errors) {
        const c = (e as { code?: string }).code
        if (typeof c === "string") return c
      }
    }
    cur = anyErr.cause
  }
  return undefined
}

/** True when the error means "could not reach the server at all". */
export function isConnectionFailure(err: unknown): boolean {
  const code = errorCode(err)
  return (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "EADDRNOTAVAIL" ||
    code === "ENETUNREACH" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_SOCKET" ||
    (err instanceof TypeError && err.message === "fetch failed" && code === undefined)
  )
}
