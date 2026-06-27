import React, { useRef, useState } from "react"
import type { ChatRef } from "@shared/types"
import { IconChat } from "./Icons"

interface Props {
  favoriteIds: Set<string>
  newLabel: string
  items: ChatRef[]
  activeId: string | null
  onSelect: (ref: ChatRef) => void
  onNew: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  emptyText?: string
  onOpenSettings: () => void
  onPin: (id: string) => void
  onRename: (id: string, title: string) => void
  onDelete: (ref: ChatRef) => void
  deleteMessage: string
  showPin?: boolean
}

export function Sidebar(props: Props) {
  const [menuRef, setMenuRef] = useState<ChatRef | null>(null)
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 })
  const [renameId, setRenameId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<ChatRef | null>(null)
  const renameInput = useRef<HTMLInputElement>(null)
  const contextRef = useRef<HTMLDivElement>(null)

  const startRename = (ref: ChatRef) => {
    setRenameId(ref.id)
    setRenameValue(ref.title)
    setMenuRef(null)
    setTimeout(() => renameInput.current?.select(), 10)
  }

  const submitRename = () => {
    if (renameId && renameValue.trim()) props.onRename(renameId, renameValue.trim())
    setRenameId(null)
  }

  const favorites = props.items.filter((r) => props.favoriteIds.has(r.id))
  const recents = props.items.filter((r) => !props.favoriteIds.has(r.id))

  if (props.collapsed) {
    return (
      <aside className="sidebar collapsed">
        <button className="icon-btn" title="Expand sidebar" onClick={props.onToggleCollapse}>
          »
        </button>
        <button className="icon-btn" title={props.newLabel} onClick={props.onNew}>
          <IconChat size={16} />
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
        <button className="new-btn" onClick={props.onNew}>
          <IconChat size={15} /> {props.newLabel}
        </button>
        <button className="icon-btn collapse-btn" title="Collapse sidebar" onClick={props.onToggleCollapse}>
          «
        </button>
      </div>

      <div className="sidebar-scroll">
      {favorites.length > 0 && (
        <>
          <div className="section-label">Favorites</div>
          {favorites.map((ref) => renderItem(ref))}
        </>
      )}

      <div className="section-label">Recents</div>
      {recents.length === 0 && favorites.length === 0 && (
        <div className="recent" style={{ color: "var(--text-faint)" }}>
          {props.emptyText ?? "Nothing yet"}
        </div>
      )}
      {recents.map((ref) => renderItem(ref))}
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

      {/* 3-dot context menu */}
      {menuRef && (
        <>
          <div className="ctx-overlay no-blur" onClick={() => setMenuRef(null)} />
          <div ref={contextRef} className="ctx-menu" style={{ left: menuPos.x, top: menuPos.y }}>
            {props.showPin !== false && (
              <button onClick={() => { props.onPin(menuRef.id); setMenuRef(null) }}>
                {props.favoriteIds.has(menuRef.id) ? "Unpin" : "Pin to Favorites"}
              </button>
            )}
            <button onClick={() => startRename(menuRef)}>Rename</button>
            <button className="danger" onClick={() => { setConfirmDelete(menuRef); setMenuRef(null) }}>
              Delete
            </button>
          </div>
        </>
      )}

      {/* Rename inline */}
      {renameId && (
        <div className="rename-overlay" onClick={() => setRenameId(null)} />
      )}
      {renameId && (
        <div className="rename-popup">
          <input
            ref={renameInput}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitRename(); if (e.key === "Escape") setRenameId(null) }}
          />
          <div className="rename-actions">
            <button onClick={submitRename}>Save</button>
            <button onClick={() => setRenameId(null)}>Cancel</button>
          </div>
        </div>
      )}

      {/* Confirm delete */}
      {confirmDelete && (
        <>
          <div className="ctx-overlay" onClick={() => setConfirmDelete(null)} />
          <div className="ctx-menu confirm-delete">
            <h3>Delete "{confirmDelete.title}"</h3>
            <div className="confirm-text">{props.deleteMessage}</div>
            <div className="confirm-actions">
              <button className="danger" onClick={() => { props.onDelete(confirmDelete); setConfirmDelete(null) }}>
                Delete
              </button>
              <button onClick={() => setConfirmDelete(null)}>Cancel</button>
            </div>
          </div>
        </>
      )}
    </aside>
  )

  function renderItem(ref: ChatRef) {
    if (renameId === ref.id) return null
    return (
      <div
        key={ref.id}
        className={"recent-wrap" + (ref.id === props.activeId ? " active" : "")}
      >
        <button
          className="recent"
          onClick={() => props.onSelect(ref)}
          title={ref.directory}
        >
          {ref.title || "Untitled"}
        </button>
        <button
          className="recent-dots"
          onClick={(e) => {
            e.stopPropagation()
            const rect = e.currentTarget.getBoundingClientRect()
            setMenuPos({ x: rect.left - 170, y: rect.bottom + 4 })
            setMenuRef(ref)
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="6" r="1.5" />
            <circle cx="12" cy="12" r="1.5" />
            <circle cx="12" cy="18" r="1.5" />
          </svg>
        </button>
      </div>
    )
  }
}