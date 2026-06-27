import React from "react"
import { IconCode } from "./Icons"

export function CodeTab({ directory }: { directory: string | null }) {
  return (
    <main className="main">
      <div className="code-stub">
        <IconCode size={40} />
        <div className="big">Code</div>
        <div style={{ maxWidth: 420, textAlign: "center", lineHeight: 1.5 }}>
          A built-in editor / diff view is planned here. For now, use the Tasker tab to drive
          file edits — changes appear in the workspace file tree on the right.
        </div>
        {directory && <div style={{ fontSize: 12.5, color: "var(--text-faint)" }}>Workspace: {directory}</div>}
      </div>
    </main>
  )
}
