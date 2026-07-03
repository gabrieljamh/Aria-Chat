import React, { useEffect, useRef, useState } from "react"
import type { ProjectInfo } from "@shared/types"
import { IconChevronDown, IconFolder, IconPlus } from "./Icons"

interface Props {
  projects: ProjectInfo[]
  selectedDir: string | null
  onSelect: (dir: string) => void
  onAddProject: () => void
  loading?: boolean
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

export function ProjectDropdown(props: Props) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0 })

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    const deferred = () => setTimeout(() => document.addEventListener("mousedown", handler), 0)
    const t = deferred()
    return () => { clearTimeout(t); document.removeEventListener("mousedown", handler) }
  }, [open])

  const measureAndOpen = () => {
    if (wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect()
      setMenuPos({ top: rect.bottom + 4, left: rect.left })
    }
    setOpen(true)
  }

  const selectedProject = props.projects.find((p) => p.worktree === props.selectedDir)

  return (
    <div className="project-dropdown-wrap" ref={wrapRef}>
      <button className="project-dropdown-btn" onClick={() => (open ? setOpen(false) : measureAndOpen())}>
        <IconFolder size={15} />
        <span className="project-dropdown-label">
          {selectedProject?.name || (props.selectedDir ? basename(props.selectedDir) : "Choose a project")}
        </span>
        <IconChevronDown size={13} />
      </button>

      {open && (
        <div className="project-dropdown-menu" style={{ top: menuPos.top, left: menuPos.left }}>
          {props.loading && <div className="project-dropdown-section">Loading…</div>}
          {!props.loading && props.projects.length === 0 && (
            <div className="project-dropdown-empty">No projects yet — add one below</div>
          )}
          {props.projects.map((p) => {
            const name = p.name || basename(p.worktree)
            const active = p.worktree === props.selectedDir
            return (
              <button
                key={p.id}
                className={"project-dropdown-item" + (active ? " active" : "")}
                onClick={() => {
                  props.onSelect(p.worktree)
                  setOpen(false)
                }}
                title={p.worktree}
              >
                <IconFolder size={14} />
                <span className="project-dropdown-item-name">{name}</span>
                {active && <span className="project-dropdown-check">✓</span>}
              </button>
            )
          })}
          <div className="project-dropdown-divider" />
          <button className="project-dropdown-item add-project" onClick={() => { setOpen(false); props.onAddProject() }}>
            <IconPlus size={14} />
            <span>Add new project…</span>
          </button>
        </div>
      )}
    </div>
  )
}
