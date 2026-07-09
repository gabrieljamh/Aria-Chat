import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { BrowserBridge } from "../browser-bridge"

const paramSchema = z.object({
  maxElements: z
    .number()
    .default(500)
    .describe("Maximum number of elements to extract. Keep low for faster results."),
})

interface DomElement {
  id: string
  tag: string
  role?: string
  text?: string
  href?: string
  type?: string
  name?: string
  placeholder?: string
  x: number
  y: number
  w: number
  h: number
}

interface DomResult {
  url: string
  title: string
  elementCount: number
  elements: DomElement[]
}

export const BrowserGetDom = Tool.define(
  "browser.getdom",
  Effect.gen(function* () {
    const bridge = yield* BrowserBridge

    return {
      description:
        "Extract the DOM structure of the current page. Returns a list of visible elements with IDs (el-N), tag, role, text, href, type, name, placeholder, and bounding box coordinates. Always call this after navigation to get precise element IDs for clicks and typing.",
      parameters: paramSchema,
      execute: ({ maxElements }: z.infer<typeof paramSchema>, ctx) =>
        Effect.gen(function* () {
          const raw = yield* bridge.post<unknown>("getdom", { sessionId: ctx.sessionID, maxElements })

          // Guard: validate the response shape before using it.
          // The bridge may return null or a malformed object if the browser page
          // is in a restricted state (about:blank, CSP error, early navigation, etc.).
          if (!raw || typeof raw !== "object" || !Array.isArray((raw as Record<string, unknown>).elements)) {
            const repr = JSON.stringify(raw)
            return {
              title: "DOM extraction failed",
              output: "browser.getdom: bridge returned an unexpected response (raw=" + repr + "). " +
                "This usually means the page has not finished loading, " +
                "or the browser is on a restricted page (about:blank, error page, etc.). " +
                "Try navigating to a valid URL first, then retry browser.getdom.",
              metadata: { url: "", title: "", elementCount: 0 },
            }
          }

          const result = raw as DomResult

          const lines = result.elements.map((e) => {
            const parts = [e.id, e.tag]
            if (e.role) parts.push("role=" + e.role)
            if (e.text) parts.push('text="' + e.text + '"')
            if (e.href) parts.push('href="' + e.href + '"')
            if (e.type) parts.push("type=" + e.type)
            if (e.name) parts.push("name=" + e.name)
            if (e.placeholder) parts.push('placeholder="' + e.placeholder + '"')
            parts.push("@" + e.x + "," + e.y + "," + e.w + "x" + e.h)
            return parts.join(" ")
          })

          const summary = "Page: " + result.url + "\nTitle: " + result.title + "\nElements: " + result.elementCount + "\n\n" + lines.join("\n")

          return {
            title: "DOM at " + result.url,
            output: summary,
            metadata: {
              url: result.url,
              title: result.title,
              elementCount: result.elementCount,
            },
          }
        }),
    }
  }),
)