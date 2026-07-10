import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { Session } from "../session"
import { Instance } from "../project/instance"

/**
 * Working-directory awareness for the model.
 *
 * "Complementary working directories" are seeded by the desktop as session
 * permission rules: `{ permission: "external_directory", pattern: "<dir>/*",
 * action: "allow" }` (a later "ask" rule for the same pattern revokes — rule
 * evaluation is findLast). That ruleset is therefore the single source of
 * truth; this module derives the effective extra-dir list from it for both
 * the `workdirs` tool and the system-prompt block injected each turn.
 */

type RuleLike = { permission: string; pattern: string; action: string }

/** Effective additional working directories from a session permission ruleset. */
export function extraWorkdirs(ruleset: readonly RuleLike[] | undefined): string[] {
  const dirs = new Map<string, string>()
  for (const rule of ruleset ?? []) {
    if (rule.permission !== "external_directory") continue
    const m = /^(.+)[\\/]\*$/.exec(rule.pattern)
    if (!m) continue
    // Last rule for the same dir wins, mirroring Permission.evaluate findLast.
    dirs.set(m[1], rule.action)
  }
  return [...dirs.entries()].filter(([, action]) => action === "allow").map(([dir]) => dir)
}

/** System-prompt section advertising the workspace layout to the model. */
export function workdirsSystemBlock(main: string, extras: string[]): string {
  return [
    "<working_directories>",
    `Main project (default working directory): ${main}`,
    "The user has ALSO approved these additional working directories. They are part of your workspace: read, edit, create files and run commands in them directly — no permission prompt will appear and you must not ask the user for access:",
    ...extras.map((d) => `- ${d}`),
    "The main project stays the default for relative paths; use absolute paths when working in the additional directories. Call the `workdirs` tool to re-check this list.",
    "</working_directories>",
  ].join("\n")
}

const DESCRIPTION = [
  "List this session's working directories: the main project directory plus any additional working directories the user has approved.",
  "",
  "All listed directories are fully accessible — read, edit, create files and run commands in them without permission prompts.",
  "Use this when unsure whether a directory outside the main project is part of the workspace.",
].join("\n")

export const WorkdirsTool = Tool.define(
  "workdirs",
  Effect.gen(function* () {
    const sessions = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: z.object({}),
      execute: (_params: {}, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const info = yield* sessions.get(ctx.sessionID)
          const main = Instance.directory
          const extras = extraWorkdirs(info.permission)
          const output = [
            `Main project directory (default cwd): ${main}`,
            extras.length
              ? `Additional approved working directories (full access, no permission prompts):\n${extras.map((d) => `- ${d}`).join("\n")}`
              : "No additional working directories are configured for this session.",
          ].join("\n\n")
          return {
            title: "Working directories",
            output,
            metadata: { main, extras },
          }
        }),
    }
  }),
)
