import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  fullPage: z
    .boolean()
    .default(false)
    .describe("If true, capture the full scrollable page. Otherwise captures only the viewport."),
})

export const BrowserScreenshot = Tool.define(
  "browser.screenshot",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Take a screenshot of the current browser viewport. Returns the screenshot as an image attachment for visual inspection. Use after navigation or clicks to verify the page state.",
      parameters: paramSchema,
      execute: ({ fullPage }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ dataUrl: string; width: number; height: number }>(
            "screenshot",
            { sessionId: ctx.sessionID, fullPage },
          )

          return {
            title: "Screenshot",
            output: `Screenshot captured (${result.width}x${result.height})`,
            metadata: { width: result.width, height: result.height },
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
