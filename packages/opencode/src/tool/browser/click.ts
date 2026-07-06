import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  elementId: z.string().optional().describe("The element ID (el-N) from browser.getdom to click"),
  x: z.number().optional().describe("X coordinate to click (use if elementId not available)"),
  y: z.number().optional().describe("Y coordinate to click (use if elementId not available)"),
  button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
})

export const BrowserClick = Tool.define(
  "browser.click",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Click an element on the page. Prefer elementId (from browser.getdom) over (x,y) coordinates — coordinates drift. After a click that may navigate, re-run browser.getdom to refresh element IDs.",
      parameters: paramSchema,
      execute: (params: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          if (!params.elementId && (params.x === undefined || params.y === undefined)) {
            throw new Error("Either elementId or both x and y must be provided")
          }

          const result = yield* bridge.post<{ ok: boolean; navigated?: boolean; error?: string }>(
            "click",
            {
              sessionId: ctx.sessionID,
              elementId: params.elementId,
              x: params.x,
              y: params.y,
              button: params.button,
            },
          )

          return {
            title: `Click ${params.elementId ?? `(${params.x},${params.y})`}`,
            output: result.error
              ? `Click failed: ${result.error}`
              : `Clicked ${params.elementId ?? `(${params.x},${params.y})`}${result.navigated ? " — page navigated" : ""}`,
            metadata: { ok: result.ok, navigated: result.navigated, error: result.error },
          }
        }),
    }
  }),
)
