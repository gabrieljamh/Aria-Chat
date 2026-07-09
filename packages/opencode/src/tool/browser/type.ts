import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  elementId: z.string().describe("The element ID (el-N) of the input field to type into"),
  text: z.string().describe("The text to type"),
  clear: z.boolean().default(true).describe("Clear the field before typing"),
})

export const BrowserType = Tool.define(
  "browser_type",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Type text into an input field. Uses real keyboard events (triggers SPAs, React/Vue controlled inputs). Set clear=true to clear the field first.",
      parameters: paramSchema,
      execute: ({ elementId, text, clear }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("type", {
            sessionId: ctx.sessionID,
            elementId,
            text,
            clear,
          })

          return {
            title: `Type into ${elementId}`,
            output: result.error
              ? `Type failed: ${result.error}`
              : `Typed "${text}" into ${elementId}`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
