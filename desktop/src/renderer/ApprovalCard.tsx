import React, { useState } from "react"
import type { Permission, PermissionReply } from "@shared/types"

interface Props {
  permission: Permission
  onReply: (permissionID: string, reply: PermissionReply) => void
}

/**
 * Inline approval prompt for a `permission.asked` request. The user picks one of
 * once / always / reject; the choice is posted (with the active directory) by
 * App.replyPermission. We optimistically disable the buttons on click so the
 * card feels responsive — the card itself is removed when the matching
 * `permission.replied` event arrives (see useConversation reducer).
 */
export function ApprovalCard({ permission, onReply }: Props) {
  const [chosen, setChosen] = useState<PermissionReply | null>(null)

  const reply = (r: PermissionReply) => {
    if (chosen) return
    setChosen(r)
    onReply(permission.id, r)
  }

  return (
    <div className="approval">
      <div className="title">Approval required · {permission.permission}</div>
      <div className="detail">{describe(permission)}</div>
      <div className="actions">
        <button className="approve" disabled={chosen !== null} onClick={() => reply("once")}>
          {chosen === "once" ? "Approved" : "Approve once"}
        </button>
        <button className="always" disabled={chosen !== null} onClick={() => reply("always")}>
          {chosen === "always" ? "Always allowed" : "Always allow"}
        </button>
        <button className="deny" disabled={chosen !== null} onClick={() => reply("reject")}>
          {chosen === "reject" ? "Denied" : "Deny"}
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
