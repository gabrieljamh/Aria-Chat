import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  fromElementId: z.string().optional().describe("Start element ID (el-N) from browser_getdom. Alternative to fromX/fromY."),
  fromX: z.number().optional().describe("Start X coordinate from a browser_screenshot. Provide with fromY."),
  fromY: z.number().optional().describe("Start Y coordinate from a browser_screenshot. Provide with fromX."),
  toElementId: z.string().optional().describe("End element ID (el-N) from browser_getdom. Alternative to toX/toY."),
  toX: z.number().optional().describe("End X coordinate from a browser_screenshot. Provide with toY."),
  toY: z.number().optional().describe("End Y coordinate from a browser_screenshot. Provide with toX."),
  duration: z
    .number()
    .default(500)
    .describe("Duration of the drag in milliseconds (default 500ms)"),
})

export const BrowserDrag = Tool.define(
  "browser_drag",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Drag from one point to another with interpolated mouse moves (sliders, drag-and-drop, drawing). Each endpoint can be a DOM element (fromElementId/toElementId from browser_getdom) or x,y coordinates read from a browser_screenshot — mix and match. Give each endpoint as an element id OR a coordinate pair.",
      parameters: paramSchema,
      execute: (
        { fromElementId, fromX, fromY, toElementId, toX, toY, duration }: z.infer<typeof paramSchema>,
        ctx,
      ) =>
        Effect.gen(function* () {
          const from = fromElementId ?? `(${fromX},${fromY})`
          const to = toElementId ?? `(${toX},${toY})`
          const result = yield* bridge.post<{ ok: boolean; error?: string }>("drag", {
            sessionId: ctx.sessionID,
            fromElementId,
            fromX,
            fromY,
            toElementId,
            toX,
            toY,
            duration,
          })

          return {
            title: `Drag ${from} → ${to}`,
            output: result.error ? `Drag failed: ${result.error}` : `Dragged from ${from} to ${to}`,
            metadata: { ok: result.ok, error: result.error },
          }
        }),
    }
  }),
)
