import { app } from "electron"
import { randomUUID } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"

/**
 * Manages per-chat sandbox folders and the chat/tasker registries.
 *
 * - Chat-mode chats each get an isolated sandbox under
 *   <userData>/chats/<id> (like Claude), so file work never touches the repo.
 * - Tasker-mode tasks (internally stored with key "cowork") run in a user-picked project folder.
 * - Two JSON registries map our stable ids -> { sessionID, title, directory }:
 *     <userData>/chats/ChatsList.json
 *     <userData>/projects/ProjectsList.json
 *
 * A ".mimocode" marker dir is created in each working folder so MiMo's
 * `isValidProjectDirectory` accepts it (required for folders outside the repo,
 * which the auth'd server allows).
 */

// Tasker mode uses the internal key "cowork" (legacy name). This is NOT renamed
// because it's the registry kind used in JSON storage and IPC; the UI label is "Tasker".
export type RegistryKind = "chats" | "cowork" | "webagent"

export interface ChatRef {
  id: string
  sessionID: string
  title: string
  directory: string
  mode: RegistryKind
  createdAt: number
  updatedAt: number
}

function chatsRoot(): string {
  return join(app.getPath("userData"), "chats")
}
function projectsRoot(): string {
  return join(app.getPath("userData"), "projects")
}
function webagentRoot(): string {
  return join(app.getPath("userData"), "webagent")
}

function registryFile(kind: RegistryKind): string {
  if (kind === "chats") return join(chatsRoot(), "ChatsList.json")
  if (kind === "webagent") return join(webagentRoot(), "WebAgentList.json")
  return join(projectsRoot(), "ProjectsList.json")
}

function ensureDir(dir: string) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

/** Drop a `.mimocode` marker so the directory is a valid MiMo project. */
export function ensureProjectMarker(dir: string) {
  try {
    ensureDir(join(dir, ".mimocode"))
  } catch {
    /* best-effort */
  }
}

/** Create a fresh isolated sandbox for a new chat. Providers come from the global config. */
export function createChatSandbox(): { id: string; directory: string } {
  ensureDir(chatsRoot())
  const id = randomUUID()
  const directory = join(chatsRoot(), id)
  ensureDir(directory)
  ensureProjectMarker(directory)
  return { id, directory }
}

/** Create a fresh isolated sandbox for a new Web Agent session. */
export function createWebAgentSandbox(): { id: string; directory: string } {
  ensureDir(webagentRoot())
  const id = randomUUID()
  const directory = join(webagentRoot(), id)
  ensureDir(directory)
  ensureProjectMarker(directory)
  return { id, directory }
}

export function getRegistry(kind: RegistryKind): ChatRef[] {
  const file = registryFile(kind)
  const bak = file + ".bak"
  for (const f of [file, bak]) {
    if (!existsSync(f)) continue
    try {
      const data = JSON.parse(readFileSync(f, "utf8"))
      const items = Array.isArray(data?.items) ? (data.items as ChatRef[]) : []
      return items.filter((r) => r && typeof r.sessionID === "string" && typeof r.title === "string")
    } catch {
      // corrupt JSON — try next file (e.g. .bak)
    }
  }
  return []
}

export function saveRegistry(kind: RegistryKind, items: ChatRef[]) {
  const file = registryFile(kind)
  const root = kind === "chats" ? chatsRoot() : kind === "webagent" ? webagentRoot() : projectsRoot()
  ensureDir(root)
  try {
    // Back up previous file before writing the new one.
    if (existsSync(file)) copyFileSync(file, file + ".bak")
    // Atomic write: temp file → rename (crash-safe on same volume).
    const tmp = file + ".tmp"
    writeFileSync(tmp, JSON.stringify({ items }, null, 2))
    renameSync(tmp, file)
  } catch {
    /* best-effort */
  }
}

/**
 * Phase 4 migration: Deduplicate ProjectsList.json from one-entry-per-session
 * to one-entry-per-directory. KEEPS the original sessionID/title values on the
 * surviving entry so the old (pre-rework) version stays compatible — it can
 * still find the session by sessionID and display the title.
 *
 * Runs once on startup. Idempotent — if already 1 entry per directory, no-op.
 * Keeps a .bak backup of the pre-migration file.
 */
export function migrateProjectsList(): void {
  const file = registryFile("cowork")
  if (!existsSync(file)) return
  const bak = file + ".bak"

  let items: ChatRef[]
  try {
    const data = JSON.parse(readFileSync(file, "utf8"))
    items = Array.isArray(data?.items) ? (data.items as ChatRef[]) : []
  } catch {
    return // corrupt or unreadable — skip migration
  }

  // Check if already migrated: if every directory appears at most once, no-op
  const dirs = items.map((r) => r?.directory).filter((d) => typeof d === "string")
  const uniqueDirs = new Set(dirs)
  if (dirs.length === uniqueDirs.size) return // already 1 entry per directory

  // Group by directory, keeping the most recently updated entry (with its
  // original sessionID + title intact — backward compat with old version).
  const byDir = new Map<string, ChatRef>()
  for (const item of items) {
    if (!item || typeof item.directory !== "string") continue
    const existing = byDir.get(item.directory)
    if (!existing || (item.updatedAt ?? 0) > (existing.updatedAt ?? 0)) {
      byDir.set(item.directory, { ...item })
    }
  }

  const migrated = Array.from(byDir.values())

  // Back up the old file before writing the migrated version
  try {
    copyFileSync(file, bak)
  } catch {
    /* best-effort */
  }

  // Atomic write
  const tmp = file + ".tmp"
  writeFileSync(tmp, JSON.stringify({ items: migrated }, null, 2))
  renameSync(tmp, file)
}

const MAX_PREVIEW_BYTES = 512 * 1024 // 512 KB

/** Read a text file for the in-app preview, capped to a sane size. */
export function readFileText(path: string): { content: string; truncated: boolean; error?: string } {
  try {
    const buf = readFileSync(path)
    const truncated = buf.byteLength > MAX_PREVIEW_BYTES
    const slice = truncated ? buf.subarray(0, MAX_PREVIEW_BYTES) : buf
    return { content: slice.toString("utf8"), truncated }
  } catch (e: any) {
    return { content: "", truncated: false, error: String(e?.message ?? e) }
  }
}

/** Delete a chat sandbox directory and its contents. */
export function deleteSandbox(directory: string) {
  if (!existsSync(directory)) return
  try {
    // Retries handle Windows ENOTEMPTY/EBUSY when the server instance for this
    // dir is still writing (e.g. node_modules/.../eventlog). Best-effort: a
    // still-locked file shouldn't crash the cleanup.
    rmSync(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 150 })
  } catch {
    /* best-effort */
  }
}

/**
 * Delete leftover chat-sandbox folders that aren't referenced by the chats
 * registry — i.e. the throwaway sandboxes the AI greeting/suggestion generators
 * create (which are never persisted). Safe to run only at startup, before any
 * generation runs, so nothing in use is removed.
 */
export function sweepOrphanSandboxes() {
  try {
    const root = chatsRoot()
    if (!existsSync(root)) return
    const known = new Set(getRegistry("chats").map((c) => c.id))
    for (const name of readdirSync(root)) {
      if (name === "ChatsList.json" || known.has(name)) continue
      const dir = join(root, name)
      try {
        if (statSync(dir).isDirectory()) deleteSandbox(dir)
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

// Directory names never surfaced as workspace outputs.
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".svn", ".hg", ".cache", ".next", ".turbo", ".venv", "dist", "build", "out", "target",
])

/**
 * List files under `directory` modified at/after `sinceMs`, excluding noise
 * (node_modules, .git, build dirs, dot-entries). This is how the workspace Files
 * panel captures everything the assistant produces — including artifacts created
 * by bash (zips, PDFs, …) that never emit a file.edited event — and how that
 * list persists: the files live on disk, so we just re-derive it on load.
 */
export function listWorkspaceFiles(directory: string, sinceMs = 0): string[] {
  const out: { path: string; mtime: number }[] = []
  let visited = 0
  const walk = (dir: string, depth: number) => {
    if (depth > 8 || visited > 6000 || out.length > 400) return
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return
    }
    for (const name of names) {
      visited++
      if (out.length > 400) return
      if (name.startsWith(".")) continue // skip dot-files and dot-dirs (.mimocode, .git, …)
      const full = join(dir, name)
      let st
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(full, depth + 1)
      } else if (st.isFile() && st.mtimeMs >= sinceMs) {
        out.push({ path: full, mtime: st.mtimeMs })
      }
    }
  }
  if (existsSync(directory)) walk(directory, 0)
  out.sort((a, b) => b.mtime - a.mtime) // most-recently-changed first
  return out.slice(0, 200).map((x) => x.path)
}

/**
 * Strip a provider entry from every per-directory mimocode.json the desktop
 * wrote — all chat sandboxes plus any registered chat/tasker project folders —
 * so a removed provider doesn't linger in seeded configs.
 */
export function removeProviderFromConfigs(providerID: string) {
  const dirs = new Set<string>()
  try {
    const root = chatsRoot()
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        if (name === "ChatsList.json") continue
        dirs.add(join(root, name))
      }
    }
  } catch {
    /* ignore */
  }
  for (const kind of ["chats", "cowork"] as RegistryKind[]) {
    for (const ref of getRegistry(kind)) dirs.add(ref.directory)
  }
  for (const dir of dirs) {
    const file = join(dir, "mimocode.json")
    try {
      if (!existsSync(file)) continue
      const cfg = JSON.parse(readFileSync(file, "utf8"))
      if (cfg?.provider && cfg.provider[providerID]) {
        delete cfg.provider[providerID]
        writeFileSync(file, JSON.stringify(cfg, null, 2))
      }
    } catch {
      /* best-effort */
    }
  }
}
