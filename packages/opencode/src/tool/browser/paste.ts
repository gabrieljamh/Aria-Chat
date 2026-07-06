import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  elementId: z.string().describe("The element ID (el-N) of the input field to paste into"),
  text: z.string().describe("The text to paste"),
  clear: z.boolean().default(false).describe("Clear the field before pasting"),
})

export const BrowserPaste = Tool.define(
  "browser.paste",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Paste text into an input field via the clipboard. Use for large text that would be slow with browser.type, or when text contains special characters.",
      parameters: paramSchema,
      execute: ({ elementId, text, clear }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("paste", {
            sessionId: ctx.sessionID,
            elementId,
            text,
            clear,
          })

          return {
            title: `Paste into ${elementId}`,
            output: result.error
              ? `Paste failed: ${result.error}`
              : `Pasted ${text.length} chars into ${elementId}`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
