import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  elementId: z.string().optional().describe("Element ID (el-N) from browser_getdom. Best for structured pages."),
  x: z.number().optional().describe("X coordinate from a browser_screenshot. Best for visual/canvas pages. Provide with y."),
  y: z.number().optional().describe("Y coordinate from a browser_screenshot. Provide with x."),
  button: z.enum(["left", "right", "middle"]).default("left").describe("Mouse button"),
})

export const BrowserClick = Tool.define(
  "browser_click",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Click on the page. Two ways to target, pick whichever fits: (1) elementId from browser_getdom — best when the page has meaningful DOM; or (2) x,y coordinates read from a browser_screenshot — best for canvas/visual pages, where the screenshot's pixels map 1:1 to these coordinates. Provide elementId OR both x and y. Coordinates are viewport-relative, so take a fresh browser_screenshot right before using them (don't reuse stale coordinates after scrolling/navigation). After a click that may navigate, re-run browser_getdom or browser_screenshot to refresh. A red crosshair marker is painted at the click location and persists until the next browser_screenshot — so the next screenshot shows where the click landed, letting you verify coordinate accuracy and self-diagnose misfired clicks.",
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
