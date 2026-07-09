import z from "zod"
import { Effect } from "effect"
import * as Tool from "../tool"
import { DesktopBridge } from "../desktop-bridge"

interface AppInfo {
  id: string
  name: string
  binary: string
  autoAllow: boolean
}

export const ListApps = Tool.define(
  "list_apps",
  Effect.gen(function* () {
    const bridge = yield* DesktopBridge

    return {
      description:
        "List the applications and scripts the user has registered as launchable (Settings → Applications). Use this to discover what run_app can target before launching — the model can ONLY launch apps that appear here.",
      parameters: z.object({}),
      execute: (_params: {}, _ctx) =>
        Effect.gen(function* () {
          const result = yield* bridge.post<{ apps: AppInfo[] }>("list-apps", {})
          const apps = result.apps ?? []
          const lines = apps.map(
            (a) => `- ${a.name} (${a.binary})${a.autoAllow ? "" : " — asks before launching"}`,
          )
          return {
            title: `Registered apps (${apps.length})`,
            output: apps.length
              ? `Registered applications:\n${lines.join("\n")}`
              : "No applications are registered. The user can add them in Settings → Applications.",
            metadata: { apps },
          }
        }),
    }
  }),
)
