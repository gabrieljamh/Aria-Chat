import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  points: z
    .array(z.object({ x: z.number(), y: z.number() }))
    .min(2)
    .describe(
      "Ordered path of {x, y} points in browser_screenshot coordinate space. The mouse presses at the first point, glides smoothly through every point, and releases at the last — one continuous stroke.",
    ),
  duration: z
    .number()
    .default(800)
    .describe("Total time to trace the whole path, in milliseconds (default 800ms). Lower = faster stroke."),
})

export const BrowserDraw = Tool.define(
  "browser_draw",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Draw a freehand path in ONE continuous mouse gesture: press at the first point, move smoothly through all points, release at the last. Use for tasks that need a single uninterrupted stroke — e.g. drawing a clean circle or signature — where chained browser_drag calls would break the stroke. Get coordinates from a browser_screenshot; for a circle, pass ~24+ points sampled around the ring and keep the duration short if the page is timed.",
      parameters: paramSchema,
      execute: ({ points, duration }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; points?: number; error?: string }>("draw", {
            sessionId: ctx.sessionID,
            points,
            duration,
          })

          return {
            title: `Draw (${points.length} pts)`,
            output: result.error ? `Draw failed: ${result.error}` : `Drew a ${points.length}-point path`,
            metadata: { ok: result.ok, points: result.points, error: result.error },
          }
        }),
    }
  }),
)
