import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  keys: z
    .string()
    .describe(
      "Keystrokes to send. Supported: printable characters, 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', arrow keys ('ArrowUp','ArrowDown','ArrowLeft','ArrowRight'), and modifier combos like 'Ctrl+a', 'Shift+End'.",
    ),
})

export const BrowserKeystrokes = Tool.define(
  "browser.keystrokes",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Send keyboard keystrokes to the page. Use for shortcuts (Ctrl+a, Ctrl+c), Enter to submit forms, Tab to move between fields, Escape to close dialogs, etc.",
      parameters: paramSchema,
      execute: ({ keys }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("keystrokes", {
            sessionId: ctx.sessionID,
            keys,
          })

          return {
            title: `Keystrokes: ${keys}`,
            output: result.error ? `Keystrokes failed: ${result.error}` : `Sent keystrokes: ${keys}`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
