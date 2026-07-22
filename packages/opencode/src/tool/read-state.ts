import fs from "fs"
import path from "path"
import type * as Tool from "./tool"
import { SessionCwd } from "./session-cwd"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { RecoverableError } from "./recoverable"
import type { SessionID } from "../session/schema"

// Same normalization both sides of the comparison go through so a Read on
// a relative path lines up with an Edit on the absolute one.
function canon(sessionID: SessionID, p: string): string {
  const abs = path.isAbsolute(p) ? p : path.resolve(SessionCwd.get(sessionID), p)
  if (process.platform === "win32") return AppFileSystem.normalizePath(abs).toLowerCase()
  return abs
}

// Tools whose successful completion means the model has seen (or produced)
// the file's current contents. Used to establish the "last known" timestamp
// for staleness detection.
const CONTENT_AWARE_TOOLS = new Set(["read", "edit", "write", "multiedit", "notebook_edit"])

/**
 * Throws RecoverableError if the given file was not previously read by the
 * `read` tool in this conversation, OR if the file has been modified on disk
 * since the model last saw its contents (external edit — e.g. the user changed
 * the file in their editor). Writes/edits to existing files must operate on
 * current contents — this turns the usage note in edit.txt into actual
 * enforcement.
 *
 * Staleness is judged against the most recent completed read/edit/write tool
 * call targeting this file: the model's own edits refresh the timestamp, so
 * only changes made outside the conversation trip the check.
 *
 * RecoverableError is intentional: the failure is surfaced to the agent as a
 * tool result it can act on (call Read, then retry) rather than as a hard
 * system fault.
 */
export function assertFileRead(ctx: Tool.Context, targetPath: string, toolId: string): void {
  const target = canon(ctx.sessionID, targetPath)

  let wasRead = false
  let lastKnown = 0

  for (const msg of ctx.messages) {
    for (const part of msg.parts) {
      if (part.type !== "tool") continue
      if (!CONTENT_AWARE_TOOLS.has(part.tool)) continue
      if (part.state.status !== "completed") continue
      const input = part.state.input as { file_path?: unknown; notebook_path?: unknown } | undefined
      const fp = input?.file_path ?? input?.notebook_path
      if (typeof fp !== "string") continue
      if (canon(ctx.sessionID, fp) !== target) continue
      if (part.tool === "read") wasRead = true
      const end = part.state.time?.end
      if (typeof end === "number" && end > lastKnown) lastKnown = end
    }
  }

  if (!wasRead) {
    throw new RecoverableError(
      `${toolId}: ${targetPath} has not been read in this conversation. Call the read tool on this file first, then retry.`,
    )
  }

  if (lastKnown > 0) {
    const abs = path.isAbsolute(targetPath) ? targetPath : path.resolve(SessionCwd.get(ctx.sessionID), targetPath)
    const stat = fs.statSync(abs, { throwIfNoEntry: false })
    if (stat && stat.mtimeMs > lastKnown) {
      throw new RecoverableError(
        `${toolId}: ${targetPath} has been modified on disk since it was last read in this conversation (likely an external change by the user or another process). The contents in your context are stale — do NOT assume they are current and do NOT overwrite the external change. Call the read tool on this file to see its current state, then retry with edits based on the fresh contents.`,
      )
    }
  }
}
