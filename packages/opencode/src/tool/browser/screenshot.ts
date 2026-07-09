import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({})

export const BrowserScreenshot = Tool.define(
  "browser_screenshot",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Take a screenshot of the current browser viewport. Returns the screenshot as an image attachment. The image's pixel grid maps 1:1 to browser_click / browser_drag coordinates, so you can read an (x, y) directly off the screenshot and pass it to those tools — ideal for canvas/visual pages with no useful DOM. Coordinates are viewport-relative; use browser_scroll to bring off-screen content into view, then re-screenshot. Use after navigation or clicks to verify page state.",
      parameters: paramSchema,
      execute: (_params: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ dataUrl: string; width: number; height: number; dpr?: number }>(
            "screenshot",
            { sessionId: ctx.sessionID },
          )

          return {
            title: "Screenshot",
            output: `Screenshot captured (${result.width}x${result.height}). Coordinates read off this image map directly to browser_click/browser_drag x,y.`,
            metadata: { width: result.width, height: result.height, dpr: result.dpr },
            attachments: [
              {
                type: "file" as const,
                mime: "image/png",
                url: result.dataUrl,
              },
            ],
          }
        }),
    }
  }),
)
