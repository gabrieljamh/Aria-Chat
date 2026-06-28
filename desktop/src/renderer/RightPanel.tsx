import React from "react"
import type { TaskInfo } from "@shared/types"
import { IconCheck } from "./Icons"

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}
function ext(p: string): string {
  const name = basename(p)
  const i = name.lastIndexOf(".")
  return i > 0 ? name.slice(i + 1).toLowerCase() : ""
}

function taskDepth(id: string): number {
  return id.split(".").length - 1
}

function sortTasksById(tasks: TaskInfo[]): TaskInfo[] {
  return [...tasks].sort((a, b) => {
    const numA = a.id.split(".").map(Number)
    const numB = b.id.split(".").map(Number)
    for (let i = 0; i < Math.max(numA.length, numB.length); i++) {
      const aVal = numA[i] ?? 0
      const bVal = numB[i] ?? 0
      if (aVal !== bVal) return aVal - bVal
    }
    return 0
  })
}

type FileCategory = "code" | "web" | "style" | "data" | "doc" | "image" | "archive" | "file"

const CATEGORY: Record<string, FileCategory> = {}
const add = (cat: FileCategory, exts: string[]) => exts.forEach((e) => (CATEGORY[e] = cat))
add("code", ["ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rs", "rb", "java", "kt", "c", "h", "cpp", "cc", "cs", "php", "swift", "sh", "bash", "zsh", "lua", "r"])
add("web", ["html", "htm", "xml", "vue", "svelte", "astro"])
add("style", ["css", "scss", "sass", "less"])
add("data", ["json", "jsonc", "yaml", "yml", "toml", "ini", "env", "csv", "tsv", "sql"])
add("doc", ["md", "markdown", "mdx", "txt", "rst", "pdf", "doc", "docx", "rtf"])
add("image", ["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"])
add("archive", ["zip", "tar", "gz", "tgz", "rar", "7z", "bz2"])

const COLOR: Record<FileCategory, string> = {
  code: "#7fb2e6",
  web: "var(--accent)",
  style: "#c98bd9",
  data: "var(--good)",
  doc: "#d8c08a",
  image: "#6fc2c2",
  archive: "#d0a96a",
  file: "var(--text-faint)",
}

const PATHS: Record<FileCategory, React.ReactNode> = {
  code: <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />,
  web: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
    </>
  ),
  style: <path d="M12 3s6 5.5 6 10a6 6 0 0 1-12 0c0-4.5 6-10 6-10z" />,
  data: <path d="M8 4a3 3 0 0 0-3 3v2a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2a3 3 0 0 0 3 3M16 4a3 3 0 0 1 3 3v2a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2a3 3 0 0 1-3 3" />,
  doc: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m3 17 5-4 4 3 3-2 6 4" />
    </>
  ),
  archive: (
    <>
      <path d="M3 7l9-4 9 4v10l-9 4-9-4z" />
      <path d="M3 7l9 4 9-4M12 11v10" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
}

function FileIcon({ path }: { path: string }) {
  const cat = CATEGORY[ext(path)] ?? "file"
  return (
    <span className="file-card-icon" style={{ color: COLOR[cat] }}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        {PATHS[cat]}
      </svg>
    </span>
  )
}

interface Props {
  collapsed: boolean
  onToggleCollapse: () => void
  tasks: TaskInfo[]
  files: string[]
  onOpenFile: (path: string) => void
  // Show the Tasks section. Off in Chat mode (Tasker-only).
  showProgress?: boolean
  // Optional Stats section (context/tokens/cost/compaction), rendered on top.
  stats?: React.ReactNode
}

/**
 * Right-hand workspace panel shared by Chat and Tasker: a Progress checklist
 * (from todo.updated) and the files the assistant has created/edited (from
 * file.edited). Clicking a file opens it in the in-app viewer. Collapsible like
 * the left sidebar — defaults differ per tab (collapsed in Chat, open in Tasker).
 */
export function RightPanel({ collapsed, onToggleCollapse, tasks, files, onOpenFile, showProgress = true, stats }: Props) {
  if (collapsed) {
    return (
      <aside className="right-panel collapsed">
        <button className="icon-btn" title="Show tasks & files" onClick={onToggleCollapse}>
          «
        </button>
        {files.length > 0 && <span className="right-collapsed-badge">{files.length}</span>}
      </aside>
    )
  }

  const sortedTasks = sortTasksById(tasks)

  return (
    <aside className="right-panel">
      <div className="right-panel-head">
        <span className="right-panel-title">Workspace</span>
        <button className="icon-btn collapse-btn" title="Hide panel" onClick={onToggleCollapse}>
          »
        </button>
      </div>

      {stats}

      {showProgress && tasks.length > 0 && (
        <div className="panel-section">
          <div className="panel-section-head">
            <h3>Tasks</h3>
            <span className="progress-count">
              {tasks.filter((t) => t.status === "done").length}/{tasks.length}
            </span>
          </div>
          <div className="todo-list">
            {sortedTasks.map((t) => (
              <div key={t.id} className={"todo-item " + t.status} style={{ paddingLeft: taskDepth(t.id) * 16 }}>
                <span className="todo-marker">
                  {t.status === "done"
                    ? <IconCheck size={11} />
                    : t.status === "blocked"
                    ? <span className="todo-dot" style={{ background: "var(--danger)" }} />
                    : t.status === "in_progress"
                    ? <span className="todo-dot" style={{ animation: "todo-pulse 1.2s ease-in-out infinite" }} />
                    : <span className="todo-dot" />}
                </span>
                <span className="label">
                  <span className="task-id">{t.id} </span>
                  {t.summary}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="panel-section">
        <h3>Files</h3>
        {files.length === 0 ? (
          <div className="panel-empty">Files the assistant creates or edits appear here.</div>
        ) : (
          <div className="file-cards">
            {files.map((f) => (
              <button key={f} className="file-card" title={f} onClick={() => onOpenFile(f)}>
                <FileIcon path={f} />
                <span className="file-card-name">{basename(f)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
