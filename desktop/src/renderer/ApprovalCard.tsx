import React, { useState } from "react"
import type { Permission, PermissionReply } from "@shared/types"

interface Props {
  permission: Permission
  // May be sync or async. When it returns a promise we await it so a failed
  // reply re-enables the buttons instead of freezing the card.
  onReply: (permissionID: string, reply: PermissionReply) => void | Promise<void>
}

/**
 * Inline approval prompt for a `permission.asked` request.
 *
 * Recovery model (this used to be the freeze bug): the card is normally removed
 * when its `permission.replied` event arrives (see useConversation reducer). But
 * a reply can fail to produce that event — the POST errors, or it lands as a
 * no-op on the server (request already resolved/aborted, or routed to the wrong
 * instance). Previously the first click latched the buttons disabled with no way
 * back, so the card sat there dead forever. Now:
 *   - We AWAIT the reply. On failure we re-enable the buttons and show the error.
 *   - On success we also self-dismiss optimistically, so a no-op-but-200 reply
 *     (which emits no event) still clears the card.
 *   - A Dismiss escape hatch is always available: it best-effort rejects (to
 *     unblock the backend if the request IS still pending) and hides the card,
 *     so an orphaned card can never trap the user.
 */
export function ApprovalCard({ permission, onReply }: Props) {
  const [chosen, setChosen] = useState<PermissionReply | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reply = async (r: PermissionReply) => {
    if (chosen) return
    setChosen(r)
    setError(null)
    try {
      await onReply(permission.id, r)
      // Optimistic removal: covers a successful-but-no-event reply so the card
      // doesn't linger waiting for a `permission.replied` that never comes.
      setDismissed(true)
    } catch (e: any) {
      // Reply didn't go through — un-latch so the user can retry or dismiss.
      setChosen(null)
      setError(e?.message ?? String(e))
    }
  }

  // Escape hatch for an orphaned card. Best-effort reject unblocks the backend
  // if the request is somehow still pending; either way the card goes away.
  const dismiss = () => {
    setDismissed(true)
    try {
      const p = onReply(permission.id, "reject")
      if (p && typeof (p as Promise<void>).catch === "function") (p as Promise<void>).catch(() => {})
    } catch {}
  }

  if (dismissed) return null

  return (
    <div className="approval">
      <div className="title">Approval required · {permission.permission}</div>
      <div className="detail">{describe(permission)}</div>
      {error && <div className="approval-error">Reply failed: {error}. Try again or dismiss.</div>}
      <div className="actions">
        <button className="approve" disabled={chosen !== null} onClick={() => reply("once")}>
          {chosen === "once" ? "Approving…" : "Approve once"}
        </button>
        <button className="always" disabled={chosen !== null} onClick={() => reply("always")}>
          {chosen === "always" ? "Allowing…" : "Always allow"}
        </button>
        <button className="deny" disabled={chosen !== null} onClick={() => reply("reject")}>
          {chosen === "reject" ? "Denying…" : "Deny"}
        </button>
        <button className="dismiss" onClick={dismiss} title="Clear this request">
          Dismiss
        </button>
      </div>
    </div>
  )
}

/** Best-effort human-readable summary of what's being approved. */
function describe(p: Permission): string {
  const meta = p.metadata ?? {}
  const metaStr = (k: string) => (typeof meta[k] === "string" ? (meta[k] as string) : "")
  return (
    metaStr("command") ||
    metaStr("filePath") ||
    metaStr("path") ||
    metaStr("url") ||
    p.patterns.filter(Boolean).join(", ") ||
    (p.always.length ? `Always: ${p.always.join(", ")}` : "Allow this action?")
  )
}
