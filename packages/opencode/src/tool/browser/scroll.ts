import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  dx: z.number().default(0).describe("Horizontal scroll delta (positive = right, negative = left)"),
  dy: z.number().default(0).describe("Vertical scroll delta (positive = down, negative = up). Use dy=600 to scroll down one viewport."),
})

export const BrowserScroll = Tool.define(
  "browser_scroll",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Scroll the page by dx (horizontal) and dy (vertical) pixels. Use dy=600 to scroll down one viewport. After scrolling into new content, re-run browser_getdom to see newly visible elements.",
      parameters: paramSchema,
      execute: ({ dx, dy }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; scrolled?: boolean; error?: string }>("scroll", {
            sessionId: ctx.sessionID,
            dx,
            dy,
          })

          const output = result.error
            ? `Scroll failed: ${result.error}`
            : result.scrolled === false
              ? `Scrolled by (${dx}, ${dy}) but the page did not move — likely already at the ${dy < 0 ? "top" : "bottom"} (or the content isn't scrollable in that direction).`
              : `Scrolled by (${dx}, ${dy})`

          return {
            title: `Scroll (${dx}, ${dy})`,
            output,
            metadata: { ok: result.ok, scrolled: result.scrolled, error: result.error },
          }
        }),
    }
  }),
)
