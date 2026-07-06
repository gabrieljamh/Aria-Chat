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
          const result = yield* bridge.post<{
            url: string
            title: string
            elementCount: number
            elements: Array<{
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
            }>
          }>("getdom", { sessionId: ctx.sessionID, maxElements })

          const lines = result.elements.map((e) => {
            const parts = [e.id, e.tag]
            if (e.role) parts.push(`role=${e.role}`)
            if (e.text) parts.push(`text="${e.text}"`)
            if (e.href) parts.push(`href="${e.href}"`)
            if (e.type) parts.push(`type=${e.type}`)
            if (e.name) parts.push(`name=${e.name}`)
            if (e.placeholder) parts.push(`placeholder="${e.placeholder}"`)
            parts.push(`@(${e.x},${e.y},${e.w}x${e.h})`)
            return parts.join(" ")
          })

          const summary = `Page: ${result.url}\nTitle: ${result.title}\nElements: ${result.elementCount}\n\n${lines.join("\n")}`

          return {
            title: `DOM at ${result.url}`,
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
