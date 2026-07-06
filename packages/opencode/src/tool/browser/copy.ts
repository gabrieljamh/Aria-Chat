import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  elementId: z
    .string()
    .optional()
    .describe("The element ID (el-N) to copy text from. If omitted, copies the current selection."),
})

export const BrowserCopy = Tool.define(
  "browser.copy",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Copy text from an element or the current selection. Returns the copied text for use in subsequent tool calls.",
      parameters: paramSchema,
      execute: ({ elementId }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ text: string; error?: string }>("copy", {
            sessionId: ctx.sessionID,
            elementId,
          })

          return {
            title: `Copy ${elementId ?? "selection"}`,
            output: result.error ? `Copy failed: ${result.error}` : `Copied text: ${result.text}`,
            metadata: { text: result.text, error: result.error },
          }
        }),
    }
  }),
)
