import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { DesktopBridge } from "../desktop-bridge"

const paramSchema = z.object({
  app: z
    .string()
    .describe("Name or binary of a registered app to launch (fuzzy-matched). Call list_apps to see the options."),
  args: z
    .string()
    .optional()
    .describe("Optional extra arguments, appended to the app's configured default args."),
})

export const RunApp = Tool.define(
  "run_app",
  Effect.gen(function* () {
    const bridge = yield* DesktopBridge

    return {
      description:
        "Launch one of the user's registered applications or scripts by name (e.g. when the user says 'run X'). Only apps the user added in Settings → Applications can be launched — nothing else. Apps not marked auto-allow prompt the user for confirmation before launching. If the name doesn't match, call list_apps and pick from the list.",
      parameters: paramSchema,
      execute: ({ app, args }: z.infer<typeof paramSchema>, _ctx) =>
        Effect.gen(function* () {
          const r = yield* bridge.post<{
            ok: boolean
            notFound?: boolean
            declined?: boolean
            available?: string[]
            pid?: number
            error?: string
            app?: { id: string; name: string }
          }>("run-app", { query: app, extraArgs: args })

          const name = r.app?.name ?? app
          const meta = (m: {
            ok: boolean
            notFound?: boolean
            declined?: boolean
            pid?: number
            error?: string
          }) => ({ ok: m.ok, notFound: m.notFound ?? false, declined: m.declined ?? false, pid: m.pid, error: m.error })

          if (r.notFound) {
            const avail = r.available?.length ? ` Available: ${r.available.join(", ")}.` : ""
            return {
              title: "App not found",
              output: `No registered app matches "${app}".${avail} Add it in Settings → Applications, or call list_apps.`,
              metadata: meta({ ok: false, notFound: true }),
            }
          }

          if (r.declined) {
            return {
              title: `Launch of ${name} declined`,
              output: `The user declined to launch "${name}".`,
              metadata: meta({ ok: false, declined: true }),
            }
          }

          return {
            title: `Run ${name}`,
            output: r.ok
              ? `Launched ${name}${r.pid ? ` (pid ${r.pid})` : ""}.`
              : `Failed to launch ${name}: ${r.error ?? "unknown error"}`,
            metadata: meta({ ok: r.ok, pid: r.pid, error: r.error }),
          }
        }),
    }
  }),
)
