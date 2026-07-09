import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  keys: z
    .string()
    .describe(
      "Key to hold down, optionally with modifiers, e.g. 'ArrowRight', ' ' (space), 'w', 'Shift+ArrowUp'. Same key names as browser_keystrokes.",
    ),
  durationMs: z
    .number()
    .default(1000)
    .describe("How long to hold the key down, in milliseconds (default 1000ms, max 30000ms)."),
})

export const BrowserHoldKey = Tool.define(
  "browser_hold_key",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Press and HOLD a key for a set duration, then release — with auto-repeat while held. Use for games and controls that respond to sustained key presses (e.g. hold ArrowRight to keep moving, hold space to charge). For a single tap use browser_keystrokes instead.",
      parameters: paramSchema,
      execute: ({ keys, durationMs }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("holdkey", {
            sessionId: ctx.sessionID,
            keys,
            durationMs,
          })

          return {
            title: `Hold ${keys} (${durationMs}ms)`,
            output: result.error ? `Hold key failed: ${result.error}` : `Held ${keys} for ${durationMs}ms`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
