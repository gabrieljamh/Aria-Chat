import React, { useCallback, useEffect, useRef, useState } from "react"
import type { ChatRef, ProjectInfo, SessionInfoFull } from "@shared/types"
import { IconChat, IconChevronDown, IconChevronRight, IconFolder, IconPlus, IconRefresh } from "./Icons"

interface Props {
  projects: ProjectInfo[]
  sessionsByDir: Map<string, SessionInfoFull[]>
  activeSessionId: string | null
  activeProjectDir: string | null
  onSelectSession: (sessionID: string, directory: string) => void
  onSelectProject: (dir: string) => void
  onNewTask: () => void
  onRefreshProject: (directory: string) => void
  onAddProject: () => void
  onDeleteSession?: (sessionID: string, directory: string) => void
  onRenameSession?: (sessionID: string, title: string, directory: string) => void
  onRenameProject?: (projectID: string, name: string) => void
  onPinProject?: (directory: string) => void
  onHideProject?: (directory: string) => void
  pinnedDirs: Set<string>
  collapsed: boolean
  onToggleCollapse: () => void
  onOpenSettings: () => void
  loadingDirs: Set<string>
  registryDirs: string[]
  // Per-session "still running" busy dot — optional for back-compat.
  isSessionBusy?: (sid: string | null) => boolean
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function TaskerSidebar(props: Props) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [refreshing, setRefreshing] = useState<Set<string>>(new Set())
  const [renameTarget, setRenameTarget] = useState<{ projectID: string; name: string } | null>(null)
  const [projMenu, setProjMenu] = useState<{ dir: string; name: string; x: number; y: number } | null>(null)
  const [sessionMenu, setSessionMenu] = useState<{ sessionID: string; directory: string; title: string; x: number; y: number } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState<{ sessionID: string; directory: string; title: string } | null>(null)
  const [confirmHide, setConfirmHide] = useState<{ dir: string; name: string } | null>(null)
  const [renameSession, setRenameSession] = useState<{ sessionID: string; directory: string; title: string } | null>(null)
  const renameSessionInput = useRef<HTMLInputElement>(null)
  const renameInput = useRef<HTMLInputElement>(null)
  const projMenuRef = useRef<HTMLDivElement>(null)
  const sessionMenuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (renameTarget) setTimeout(() => renameInput.current?.focus(), 10)
  }, [renameTarget?.projectID])

  useEffect(() => {
    if (renameSession) setTimeout(() => renameSessionInput.current?.focus(), 10)
  }, [renameSession?.sessionID])

  useEffect(() => {
    if (!projMenu) return
    const handler = (e: MouseEvent) => {
      if (projMenuRef.current && !projMenuRef.current.contains(e.target as Node)) setProjMenu(null)
    }
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0)
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handler) }
  }, [projMenu])

  useEffect(() => {
    if (!sessionMenu) return
    const handler = (e: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(e.target as Node)) setSessionMenu(null)
    }
    const t = setTimeout(() => document.addEventListener("mousedown", handler), 0)
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handler) }
  }, [sessionMenu])

  const toggleExpand = useCallback((dir: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(dir)) next.delete(dir)
      else next.add(dir)
      return next
    })
  }, [])

  const refreshProject = useCallback(async (dir: string) => {
    setRefreshing((prev) => new Set(prev).add(dir))
    props.onRefreshProject(dir)
    setTimeout(() => {
      setRefreshing((prev) => {
        const n = new Set(prev)
        n.delete(dir)
        return n
      })
    }, 800)
  }, [props])

  const submitRename = () => {
    if (renameTarget && renameTarget.name.trim() && props.onRenameProject) {
      props.onRenameProject(renameTarget.projectID, renameTarget.name.trim())
    }
    setRenameTarget(null)
  }

  // Build a merged list: server projects + registry dirs not in server list
  const serverDirs = new Set(props.projects.map((p) => p.worktree))
  const extraDirs = props.registryDirs.filter((d) => !serverDirs.has(d))
  const allProjects = [...props.projects]
  for (const dir of extraDirs) {
    allProjects.push({
      id: "registry:" + dir,
      worktree: dir,
      time: { created: 0, updated: 0 },
    } as ProjectInfo)
  }

  // Split into pinned + unpinned
  const pinnedProjects = allProjects.filter((p) => props.pinnedDirs.has(p.worktree))
  const unpinnedProjects = allProjects.filter((p) => !props.pinnedDirs.has(p.worktree))

  const renderProjectNode = (proj: ProjectInfo) => {
    const dir = proj.worktree
    const name = proj.name || basename(dir)
    const isExpanded = expanded.has(dir)
    const sessions = props.sessionsByDir.get(dir) ?? []
    const isLoading = props.loadingDirs.has(dir)
    const isRefreshing = refreshing.has(dir)
    const isActiveProject = props.activeProjectDir === dir
    const isPinned = props.pinnedDirs.has(dir)
    const canRename = props.onRenameProject && !proj.id.startsWith("registry:")

    return (
      <div key={proj.id} className={"project-node" + (isActiveProject ? " active-project" : "")}>
        <div className={"project-header" + (isActiveProject ? " active" : "")}>
          <button
            className="project-expand-btn"
            onClick={() => toggleExpand(dir)}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            {isExpanded ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
          </button>
          <button
            className="project-name"
            onClick={() => props.onSelectProject(dir)}
            title={`${name} — ${basename(dir)}`}
            onDoubleClick={() => {
              if (canRename) setRenameTarget({ projectID: proj.id, name })
            }}
          >
            <IconFolder size={13} />
            <span className="project-name-text">{name}</span>
          </button>
          <button
            className="project-refresh-btn"
            onClick={(e) => { e.stopPropagation(); refreshProject(dir) }}
            title="Refresh sessions"
          >
            <IconRefresh size={12} className={isRefreshing ? "spin" : ""} />
          </button>
          <button
            className="project-dots-btn"
            onClick={(e) => {
              e.stopPropagation()
              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
              setProjMenu({ dir, name, x: rect.left - 170, y: rect.bottom + 4 })
            }}
            title="Project options"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <circle cx="12" cy="5" r="1.5" />
              <circle cx="12" cy="12" r="1.5" />
              <circle cx="12" cy="19" r="1.5" />
            </svg>
          </button>
        </div>

        {isExpanded && (
          <div className="project-sessions">
            {isLoading && (
              <div className="project-session loading">
                <div className="mini-spinner" />
                <span>Loading…</span>
              </div>
            )}
            {!isLoading && sessions.length === 0 && (
              <div className="project-session empty">No sessions</div>
            )}
            {!isLoading && sessions.map((s) => {
              const isActive = s.id === props.activeSessionId
              return (
                <div key={s.id} className={"project-session-wrap" + (isActive ? " active" : "")}>
                  <button
                    className="project-session"
                    onClick={() => props.onSelectSession(s.id, dir)}
                    title={s.title || "Untitled"}
                  >
                    <IconChat size={12} />
                    <span className="project-session-title">{s.title || "Untitled"}</span>
                    {props.isSessionBusy?.(s.id) && <span className="session-busy-dot" aria-hidden="true" />}
                  </button>
                  {props.onDeleteSession && (
                    <button
                      className="session-dots"
                      onClick={(e) => {
                        e.stopPropagation()
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                        setSessionMenu({ sessionID: s.id, directory: dir, title: s.title || "Untitled", x: rect.left - 170, y: rect.bottom + 4 })
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="1.5" />
                        <circle cx="12" cy="12" r="1.5" />
                        <circle cx="12" cy="19" r="1.5" />
                      </svg>
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {renameTarget?.projectID === proj.id && (
          <div className="project-rename">
            <input
              ref={renameInput}
              value={renameTarget.name}
              onChange={(e) => setRenameTarget({ ...renameTarget, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename()
                if (e.key === "Escape") setRenameTarget(null)
              }}
              autoFocus
            />
            <button onClick={submitRename}>✓</button>
            <button onClick={() => setRenameTarget(null)}>✕</button>
          </div>
        )}
      </div>
    )
  }

  if (props.collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon-btn" title="Expand sidebar" onClick={props.onToggleCollapse}>
          »
        </button>
        <button className="icon-btn" title="New task" onClick={props.onNewTask}>
          <IconPlus size={16} />
        </button>
        <div className="sidebar-spacer" />
        <button className="icon-btn" title="Settings" onClick={props.onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
        </button>
      </aside>
    )
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="new-btn" onClick={props.onNewTask}>
          <IconPlus size={15} /> New task
        </button>
        <button className="icon-btn collapse-btn" title="Collapse sidebar" onClick={props.onToggleCollapse}>
          «
        </button>
      </div>

      <div className="sidebar-scroll">
        {allProjects.length === 0 && (
          <div className="recent" style={{ color: "var(--text-faint)", padding: "12px 10px" }}>
            No projects yet. Click "New task" or add a project.
          </div>
        )}
        {pinnedProjects.length > 0 && (
          <>
            <div className="section-label">Favorites</div>
            {pinnedProjects.map(renderProjectNode)}
            <div className="sidebar-divider" />
          </>
        )}
        {unpinnedProjects.length > 0 && (
          <>
            {pinnedProjects.length > 0 && <div className="section-label">Projects</div>}
            {unpinnedProjects.map(renderProjectNode)}
          </>
        )}
      </div>

      <div className="sidebar-footer">
        <button className="sidebar-settings-btn" onClick={props.onOpenSettings}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H23a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z" />
          </svg>
          Settings
        </button>
      </div>

      {/* Project context menu (3-dot) */}
      {projMenu && (
        <>
          <div className="ctx-overlay no-blur" onClick={() => setProjMenu(null)} />
          <div ref={projMenuRef} className="ctx-menu" style={{ left: projMenu.x, top: projMenu.y }}>
            {props.onRenameProject && !projMenu.dir.startsWith("registry:") && (
              <button onClick={() => {
                const proj = allProjects.find((p) => p.worktree === projMenu.dir)
                if (proj) setRenameTarget({ projectID: proj.id, name: proj.name || basename(projMenu.dir) })
                setProjMenu(null)
              }}>
                Rename
              </button>
            )}
            {props.onPinProject && (
              <button onClick={() => {
                props.onPinProject?.(projMenu.dir)
                setProjMenu(null)
              }}>
                {props.pinnedDirs.has(projMenu.dir) ? "Unpin" : "Pin to Favorites"}
              </button>
            )}
            {props.onHideProject && (
              <button className="danger" onClick={() => {
                setConfirmHide({ dir: projMenu.dir, name: projMenu.name })
                setProjMenu(null)
              }}>
                Hide Project
              </button>
            )}
          </div>
        </>
      )}

      {/* Session context menu (3-dot) */}
      {sessionMenu && (
        <>
          <div className="ctx-overlay no-blur" onClick={() => setSessionMenu(null)} />
          <div ref={sessionMenuRef} className="ctx-menu" style={{ left: sessionMenu.x, top: sessionMenu.y }}>
            {props.onRenameSession && (
              <button onClick={() => {
                setRenameSession(sessionMenu)
                setSessionMenu(null)
              }}>
                Rename
              </button>
            )}
            <button className="danger" onClick={() => {
              setConfirmDelete(sessionMenu)
              setSessionMenu(null)
            }}>
              Delete
            </button>
          </div>
        </>
      )}

      {/* Delete session confirmation */}
      {confirmDelete && (
        <>
          <div className="ctx-overlay" onClick={() => setConfirmDelete(null)} />
          <div className="ctx-menu confirm-delete">
            <h3>Delete "{confirmDelete.title}"</h3>
            <div className="confirm-text">This will permanently delete the session from the server. Project files will not be affected.</div>
            <div className="confirm-actions">
              <button className="danger" onClick={() => {
                props.onDeleteSession?.(confirmDelete.sessionID, confirmDelete.directory)
                setConfirmDelete(null)
              }}>
                Delete
              </button>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* Hide project confirmation */}
      {confirmHide && (
        <>
          <div className="ctx-overlay" onClick={() => setConfirmHide(null)} />
          <div className="ctx-menu confirm-delete">
            <h3>Hide "{confirmHide.name}"</h3>
            <div className="confirm-text">This removes the project from your sidebar list. Project files and all sessions on the server remain intact.</div>
            <div className="confirm-actions">
              <button className="danger" onClick={() => {
                props.onHideProject?.(confirmHide.dir)
                setConfirmHide(null)
              }}>
                Hide
              </button>
              <button onClick={() => setConfirmHide(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}

      {/* Session rename dialog */}
      {renameSession && (
        <>
          <div className="ctx-overlay no-blur" onClick={() => setRenameSession(null)} />
          <div className="ctx-menu confirm-delete" style={{ minWidth: 340 }}>
            <h3>Rename session</h3>
            <input
              ref={renameSessionInput}
              className="rename-session-input"
              value={renameSession.title}
              onChange={(e) => setRenameSession({ ...renameSession, title: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  if (renameSession.title.trim()) {
                    props.onRenameSession?.(renameSession.sessionID, renameSession.title.trim(), renameSession.directory)
                  }
                  setRenameSession(null)
                }
                if (e.key === "Escape") setRenameSession(null)
              }}
              autoFocus
            />
            <div className="confirm-actions">
              <button onClick={() => {
                if (renameSession.title.trim()) {
                  props.onRenameSession?.(renameSession.sessionID, renameSession.title.trim(), renameSession.directory)
                }
                setRenameSession(null)
              }}>
                Save
              </button>
              <button onClick={() => setRenameSession(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </aside>
  )
}
