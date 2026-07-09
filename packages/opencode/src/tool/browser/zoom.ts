import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  factor: z
    .number()
    .optional()
    .describe("Absolute zoom factor, e.g. 1 = 100%, 1.5 = 150%, 0.75 = 75%. Range 0.25–5. Takes priority over direction."),
  direction: z
    .enum(["in", "out", "reset"])
    .optional()
    .describe("Relative zoom: 'in'/'out' step by 10%, 'reset' returns to 100%. Used when factor is omitted."),
})

export const BrowserZoom = Tool.define(
  "browser_zoom",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Set the page zoom for the current session (persists across navigation). Provide an absolute factor (1 = 100%) or a direction ('in'/'out'/'reset'). Use it to make small targets readable before a screenshot, or to fit more of a page in view. Coordinates from browser_getdom and browser_screenshot stay correct at any zoom.",
      parameters: paramSchema,
      execute: ({ factor, direction }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; factor?: number; error?: string }>("zoom", {
            sessionId: ctx.sessionID,
            factor,
            direction,
          })

          return {
            title: `Zoom ${result.factor != null ? Math.round(result.factor * 100) + "%" : (direction ?? factor ?? "")}`,
            output: result.error
              ? `Zoom failed: ${result.error}`
              : `Zoom set to ${Math.round((result.factor ?? 1) * 100)}%`,
            metadata: { ok: result.ok, factor: result.factor, error: result.error },
          }
        }),
    }
  }),
)
