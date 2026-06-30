import React, { useState } from "react"
import { ansiToHtml } from "./ansi"
import { DiffView } from "./DiffView"
import { WriteView } from "./WriteView"
import { ReadView } from "./ReadView"
import type { Part } from "@shared/types"
import type { ConvMessage } from "./useConversation"
import { IconCheck, IconFile, IconRefresh, IconEdit, IconTrash, IconFork, IconChevronDown, IconChevronRight } from "./Icons"
import { Markdown } from "./Markdown"

function CollapsibleReasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <div className="reasoning-header" onClick={() => setOpen(!open)}>
        {open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}
        <span>Thinking</span>
      </div>
      <div className="reasoning-content" style={{ maxHeight: open ? "none" : 0, opacity: open ? 1 : 0 }}>
        <Markdown>{text}</Markdown>
      </div>
    </div>
  )
}

function ToolView({ part }: { part: Extract<Part, { type: "tool" }> }) {
  const [open, setOpen] = useState(false)
  const status = part.state.status
  const titleRaw = part.state.title || part.tool
  const toolPrefix = part.tool === "edit" ? "← Edit " : part.tool === "write" ? "# Wrote " : part.tool === "read" ? "→ Read " : part.tool === "grep" ? "✱ Grep " : part.tool === "glob" ? "✱ Glob " : ""
  const title = toolPrefix + titleRaw
  const input = part.state.input
  const metadata = part.state.metadata
  const diff = metadata?.diff as string | undefined
  const files = metadata?.files as Array<{ filePath?: string; patch?: string; relativePath?: string }> | undefined
  const isEditDiff = diff && (part.tool === "edit")
  const isApplyPatch = files && part.tool === "apply_patch"
  const writeContent = (typeof input?.content === "string" && (typeof input?.filePath === "string" || typeof input?.file_path === "string")) ? input.content : undefined
  const isWrite = !isEditDiff && !isApplyPatch && !!writeContent
  const isRead = part.tool === "read" && typeof part.state.output === "string"
  const detail =
    status === "error"
      ? part.state.error
      : part.state.output ?? (input ? JSON.stringify(input, null, 2) : "")
  return (
    <div className="tool">
      <div className="tool-head" onClick={() => setOpen((o) => !o)} style={{ cursor: "pointer" }}>
        <span className="tool-name">{title}</span>
        <span className={`tool-status ${status}`}>{status}</span>
      </div>
      {open && isEditDiff && <DiffView diff={diff} filePath={input?.filePath as string | undefined} />}
      {open && isApplyPatch && files.map((f, i) => f.patch ? <DiffView key={i} diff={f.patch} filePath={f.filePath || f.relativePath} /> : null)}
      {open && isWrite && writeContent && <WriteView content={writeContent} filePath={title} />}
      {open && isRead && <ReadView output={part.state.output as string} filePath={title} />}
      {open && !isEditDiff && !isApplyPatch && !isWrite && !isRead && detail && <pre className="ansi" dangerouslySetInnerHTML={{ __html: ansiToHtml(String(detail)).slice(0, 32000) }} />}
    </div>
  )
}

function PartView({ part }: { part: Part }) {
  switch (part.type) {
    case "text":
      return (part as any).text ? (
        <div className="text">
          <Markdown>{(part as any).text}</Markdown>
        </div>
      ) : null
    case "reasoning":
      return (part as any).text ? (
        <CollapsibleReasoning text={(part as any).text} />
      ) : null
    case "tool":
      return <ToolView part={part as Extract<Part, { type: "tool" }>} />
    case "file":
      return (
        <div className="file-item">
          <span className="dot" /> {(part as any).filename ?? (part as any).url}
        </div>
      )
    case "compaction":
      return (
        <div className="compaction-marker">
          {(part as any).auto ? "🔁 Auto-compacted" : "📋 Compacted"} — context has been summarized
        </div>
      )
    default:
      return null
  }
}

interface MsgActions {
  onDelete?: (messageID: string) => void
  onRegen?: (messageID: string) => void
  onContinueFrom?: (messageID: string) => void
  onEdit?: (messageID: string, newText: string) => void
}

function getUserText(msg: ConvMessage): string {
  return msg.parts
    .filter((p) => p.type === "text" && (p as any).text && !(p as any).synthetic)
    .map((p) => (p as any).text)
    .join("\n")
}

function extractErrorMessage(info: ConvMessage["info"]): string | null {
  if (!info) return null
  const err = (info as any).error
  if (!err) return null
  if (typeof err === "string") return err
  if (err && typeof err === "object") {
    if (err.data && typeof err.data === "object" && err.data.message) {
      return String(err.data.message)
    }
    if (err.message) return String(err.message)
    try {
      return JSON.stringify(err)
    } catch {
      return String(err)
    }
  }
  return null
}

function MsgFooter({ msg, editMode, onStartEdit, onSaveEdit, onCancelEdit, actions, busy }: {
  msg: ConvMessage
  editMode: boolean
  onStartEdit: () => void
  onSaveEdit: (text: string) => void
  onCancelEdit: () => void
  actions: MsgActions
  busy?: boolean
}) {
  const { onDelete, onRegen, onContinueFrom } = actions
  const id = msg.info.id
  const isUser = msg.info.role === "user"
  const [text, setText] = useState("")
  const taRef = React.useRef<HTMLTextAreaElement>(null)
  const timestamp = msg.info.time?.created ? new Date(msg.info.time.created).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : null

  React.useEffect(() => {
    if (editMode && !text) setText(getUserText(msg))
  }, [editMode])

  if (editMode) {
    return (
      <div className="msg-edit">
        <textarea
          ref={taRef}
          className="msg-edit-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              onSaveEdit(text)
            }
            if (e.key === "Escape") onCancelEdit()
          }}
        />
        <div className="msg-edit-btns">
          <button className="msg-act msg-act-apply" onClick={() => onSaveEdit(text)} disabled={!text.trim()}>Apply</button>
          <button className="msg-act msg-act-cancel" onClick={onCancelEdit}>Cancel</button>
        </div>
      </div>
    )
  }

  return (
    <div className={`msg-footer ${isUser ? "user" : "assistant"}`}>
      {isUser ? (
        busy ? (
          <span className="msg-role-badge">You</span>
        ) : (
          <>
            <span className="msg-role-badge">You</span>
            <button className="msg-act" title="Edit message" onClick={onStartEdit}><IconEdit size={13} /> Edit</button>
            <button className="msg-act" title="Delete from here" onClick={() => onDelete?.(id)}><IconTrash size={13} /> Delete</button>
            <button className="msg-act" title="Return to this message" onClick={() => onContinueFrom?.(id)}><IconFork size={13} /> Return</button>
          </>
        )
      ) : (
        busy ? (
          <span className="msg-role-badge">Aria</span>
        ) : (
          <>
            <button className="msg-act" title="Regenerate" onClick={() => onRegen?.(id)}><IconRefresh size={13} /> Regen</button>
            <button className="msg-act" title="Return to this message" onClick={() => onContinueFrom?.(id)}><IconFork size={13} /> Return</button>
            <button className="msg-act" title="Delete message" onClick={() => onDelete?.(id)}><IconTrash size={13} /> Delete</button>
            <span className="msg-role-badge">Aria</span>
          </>
        )
      )}
      {timestamp && <span className="msg-timestamp">{timestamp}</span>}
    </div>
  )
}

export function MessageView({ message, showDots, busy, ...actions }: MsgActions & { message: ConvMessage; showDots?: boolean; busy?: boolean }) {
  const role = message.info.role
  const isUser = role === "user"
  const textParts = message.parts.filter((p) => p.type === "text" && (p as any).text && !(p as any).synthetic)
  const hasContent = message.parts.some(
    (p) => (p.type === "text" || p.type === "reasoning") && (p as any).text || p.type === "tool" || p.type === "file",
  )
  const [editMode, setEditMode] = useState(false)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const saveEdit = (newText: string) => {
    if (!newText.trim()) return
    actions.onEdit?.(message.info.id, newText)
    setEditMode(false)
  }

  if (isUser) {
    const compactionPart = message.parts.find((p) => p.type === "compaction")
    const fileParts = message.parts.filter((p) => p.type === "file")
    const body = textParts.map((p) => (p as any).text).join("\n")
    if (compactionPart && !body && fileParts.length === 0) {
      return (
        <div className="msg user">
          <PartView part={compactionPart} />
        </div>
      )
      // Don't show footers for compaction-only messages — they're system-generated.
    }
    return (
      <>
        <div className="msg user">
          {fileParts.length > 0 && (
            <div className="msg-attachments">
              {fileParts.map((p) => {
                const mime = String((p as any).mime)
                if (mime.startsWith("image/")) {
                  return (
                    <img
                      key={p.id}
                      className="msg-attach-img"
                      src={(p as any).url}
                      alt={(p as any).filename ?? "image"}
                      title={(p as any).filename}
                      onClick={() => setPreviewUrl((p as any).url)}
                    />
                  )
                }
                if (mime.startsWith("audio/")) {
                  return <audio key={p.id} className="msg-attach-audio" controls src={(p as any).url} />
                }
                if (mime.startsWith("video/")) {
                  return <video key={p.id} className="msg-attach-video" controls src={(p as any).url} />
                }
                return (
                  <span key={p.id} className="msg-attach-file" title={(p as any).filename}>
                    <IconFile size={13} /> {(p as any).filename ?? "file"}
                  </span>
                )
              })}
            </div>
          )}
          {body && <div className="bubble"><Markdown>{body}</Markdown></div>}
        </div>
<MsgFooter msg={message} actions={actions} editMode={editMode} busy={busy} onStartEdit={() => setEditMode(true)} onSaveEdit={saveEdit} onCancelEdit={() => setEditMode(false)} />
        {previewUrl && (
          <div className="attach-preview-overlay" onClick={() => setPreviewUrl(null)}>
            <div className="attach-preview-box">
              <img src={previewUrl} alt="preview" className="attach-preview-img" />
              <button className="attach-preview-close" onClick={() => setPreviewUrl(null)}>×</button>
            </div>
          </div>
        )}
      </>
    )
  }

  return (
    <>
      <div className="msg assistant">
        <div className="role">Aria</div>
        {!hasContent ? (
          extractErrorMessage(message.info) ? (
            <div className="error-message">
              {extractErrorMessage(message.info)}
            </div>
          ) : showDots ? (
            <div className="dots">
              <span />
              <span />
              <span />
            </div>
          ) : (
            <div className="aborted" style={{ color: "var(--muted)", fontSize: "0.85em" }}>Stopped</div>
          )
        ) : (
          <>
            {message.parts.map((p) => <PartView key={p.id} part={p} />)}
            {extractErrorMessage(message.info) && (
              <div className="error-message">
                {extractErrorMessage(message.info)}
              </div>
            )}
          </>
        )}
      </div>
      <MsgFooter msg={message} actions={actions} editMode={editMode} busy={busy} onStartEdit={() => setEditMode(true)} onSaveEdit={saveEdit} onCancelEdit={() => setEditMode(false)} />
      {previewUrl && (
        <div className="attach-preview-overlay" onClick={() => setPreviewUrl(null)}>
          <div className="attach-preview-box">
            <img src={previewUrl} alt="preview" className="attach-preview-img" />
            <button className="attach-preview-close" onClick={() => setPreviewUrl(null)}>×</button>
          </div>
        </div>
      )}
    </>
  )
}

export function CompletedBadge() {
  return (
    <span style={{ color: "var(--good)", display: "inline-flex", gap: 4, alignItems: "center" }}>
      <IconCheck size={13} /> done
    </span>
  )
}