import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  dx: z.number().default(0).describe("Horizontal scroll delta (positive = right, negative = left)"),
  dy: z.number().default(0).describe("Vertical scroll delta (positive = down, negative = up). Use dy=600 to scroll down one viewport."),
})

export const BrowserScroll = Tool.define(
  "browser.scroll",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Scroll the page by dx (horizontal) and dy (vertical) pixels. Use dy=600 to scroll down one viewport. After scrolling into new content, re-run browser.getdom to see newly visible elements.",
      parameters: paramSchema,
      execute: ({ dx, dy }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("scroll", {
            sessionId: ctx.sessionID,
            dx,
            dy,
          })

          return {
            title: `Scroll (${dx}, ${dy})`,
            output: result.error ? `Scroll failed: ${result.error}` : `Scrolled by (${dx}, ${dy})`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
