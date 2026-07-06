import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  fromX: z.number().describe("Start X coordinate"),
  fromY: z.number().describe("Start Y coordinate"),
  toX: z.number().describe("End X coordinate"),
  toY: z.number().describe("End Y coordinate"),
  duration: z
    .number()
    .default(500)
    .describe("Duration of the drag in milliseconds (default 500ms)"),
})

export const BrowserDrag = Tool.define(
  "browser.drag",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Drag from one coordinate to another with interpolated mouse moves. Use for sliders, drag-and-drop elements, or drawing.",
      parameters: paramSchema,
      execute: ({ fromX, fromY, toX, toY, duration }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("drag", {
            sessionId: ctx.sessionID,
            fromX,
            fromY,
            toX,
            toY,
            duration,
          })

          return {
            title: `Drag (${fromX},${fromY}) → (${toX},${toY})`,
            output: result.error
              ? `Drag failed: ${result.error}`
              : `Dragged from (${fromX},${fromY}) to (${toX},${toY})`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
