import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  url: z.string().describe("The URL to navigate to (must start with http:// or https://)"),
})

export const BrowserNavigate = Tool.define(
  "browser.navigate",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Navigate the browser to a URL. Only http:// and https:// schemes are allowed. The page will load and this tool returns when navigation completes or times out.",
      parameters: paramSchema,
      execute: ({ url }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          if (!url.startsWith("http://") && !url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          const result = yield* bridge.post<{ url: string; title: string; loading: boolean; error?: string }>(
            "navigate",
            { sessionId: ctx.sessionID, url },
          )

          return {
            title: `Navigate to ${url}`,
            output: result.error
              ? `Navigation failed: ${result.error}`
              : `Navigated to ${result.url}. Title: ${result.title}`,
            metadata: { url: result.url, title: result.title, loading: result.loading },
          }
        }),
    }
  }),
)
