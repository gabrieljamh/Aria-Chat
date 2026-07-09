import z from "zod"
import { Effect } from "effect"
import type { MessageV2 } from "../session/message-v2"
import type { Permission } from "../permission"
import type { SessionID, MessageID } from "../session/schema"
import * as Truncate from "./truncate"
import { RecoverableError } from "./recoverable"
import { Agent } from "@/agent/agent"

export interface Metadata {
  [key: string]: any
}

// TODO: remove this hack
export type DynamicDescription = (agent: Agent.Info) => Effect.Effect<string>

export type Context<M extends Metadata = Metadata> = {
  sessionID: SessionID
  messageID: MessageID
  agent: string
  actorID?: string
  taskId?: string
  abort: AbortSignal
  callID?: string
  extra?: { [key: string]: unknown }
  messages: MessageV2.WithParts[]
  metadata(input: { title?: string; metadata?: M }): Effect.Effect<void>
  ask(input: Omit<Permission.Request, "id" | "sessionID" | "tool">): Effect.Effect<void>
}

export interface ExecuteResult<M extends Metadata = Metadata> {
  title: string
  metadata: M
  output: string
  attachments?: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[]
}

export interface Def<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  description: string
  parameters: Parameters
  execute(args: z.infer<Parameters>, ctx: Context): Effect.Effect<ExecuteResult<M>>
  formatValidationError?(error: z.ZodError): string
  shell?: {
    description: string
    parse(script: string): Effect.Effect<z.infer<Parameters>[], unknown>
    // Optional recovery for shell-mode calls that arrive shaped like the tool's
    // JSON args (no usable `script`). Returns the tool's parsed JSON shape to be
    // routed to execute, or undefined if rawArgs can't be lifted. Lets shell mode
    // transparently accept a JSON-shape call instead of erroring.
    recover?(rawArgs: unknown): z.infer<Parameters> | undefined
  }
}
export type DefWithoutID<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> = Omit<
  Def<Parameters, M>,
  "id"
>

export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
  id: string
  init: () => Effect.Effect<DefWithoutID<Parameters, M>>
}

type Init<Parameters extends z.ZodType, M extends Metadata> =
  | DefWithoutID<Parameters, M>
  | (() => Effect.Effect<DefWithoutID<Parameters, M>>)

export type InferParameters<T> =
  T extends Info<infer P, any> ? z.infer<P> : T extends Effect.Effect<Info<infer P, any>, any, any> ? z.infer<P> : never
export type InferMetadata<T> =
  T extends Info<any, infer M> ? M : T extends Effect.Effect<Info<any, infer M>, any, any> ? M : never

export type InferDef<T> =
  T extends Info<infer P, infer M>
    ? Def<P, M>
    : T extends Effect.Effect<Info<infer P, infer M>, any, any>
      ? Def<P, M>
      : never

/**
 * Models frequently paste raw JSON where a string parameter is expected —
 * e.g. `write({ content: { "key": … } })` instead of a JSON *string* — because
 * the payload they're working with is itself JSON. Instead of bouncing the
 * call with "expected string, received object" (which they tend to repeat),
 * use zod's own issue report to find exactly which paths got the wrong type
 * and coerce: objects/arrays are stringified (pretty-printed, matching what
 * the model meant to write), numbers/booleans become their string form.
 * Returns the coerced args, or undefined when nothing applied.
 */
export function coerceStringArgs(parameters: z.ZodType, args: unknown): unknown | undefined {
  const res = parameters.safeParse(args)
  if (res.success || !(res.error instanceof z.ZodError)) return undefined
  let changed = false
  let next: unknown
  try {
    next = structuredClone(args)
  } catch {
    return undefined
  }
  for (const issue of res.error.issues) {
    if (issue.code !== "invalid_type" || (issue as { expected?: string }).expected !== "string") continue
    if (!issue.path.length) continue
    let parent: any = next
    for (let i = 0; i < issue.path.length - 1 && parent != null; i++) parent = parent[issue.path[i] as any]
    if (parent == null) continue
    const key = issue.path[issue.path.length - 1] as any
    const val = parent[key]
    if (val !== null && (typeof val === "object" || Array.isArray(val))) {
      parent[key] = JSON.stringify(val, null, 2)
      changed = true
    } else if (typeof val === "number" || typeof val === "boolean") {
      parent[key] = String(val)
      changed = true
    }
  }
  if (!changed) return undefined
  // Only accept the coercion when it actually makes the args valid.
  return parameters.safeParse(next).success ? next : undefined
}

// Builds the agent-facing message for an argument-validation failure. zod v4's
// prettifyError gives a precise, path-annotated breakdown (which field, what was
// expected vs received) — far more actionable than dumping the raw issue JSON —
// so we surface that directly for ZodErrors and keep a generic fallback for
// anything else.
export function validationErrorMessage(id: string, error: unknown): string {
  if (error instanceof z.ZodError) {
    return `Invalid arguments for the ${id} tool:\n${z.prettifyError(error)}`
  }
  return `The ${id} tool was called with invalid arguments: ${error}.\nPlease rewrite the input so it satisfies the expected schema.`
}

function wrap<Parameters extends z.ZodType, Result extends Metadata>(
  id: string,
  init: Init<Parameters, Result>,
  truncate: Truncate.Interface,
  agents: Agent.Interface,
) {
  return () =>
    Effect.gen(function* () {
      const toolInfo = typeof init === "function" ? { ...(yield* init()) } : { ...init }
      const execute = toolInfo.execute
      toolInfo.execute = (args, ctx) => {
        const attrs = {
          "tool.name": id,
          "session.id": ctx.sessionID,
          "message.id": ctx.messageID,
          ...(ctx.callID ? { "tool.call_id": ctx.callID } : {}),
        }
        return Effect.gen(function* () {
          // Salvage "expected string, received object" calls (raw JSON pasted
          // into string params) before validation instead of bouncing them.
          const coerced = coerceStringArgs(toolInfo.parameters, args)
          if (coerced !== undefined) args = coerced as typeof args
          yield* Effect.try({
            try: () => toolInfo.parameters.parse(args),
            catch: (error) => {
              // Bad arguments are always agent-recoverable: the model sees the
              // message and rewrites the call next turn. Mark it so the TUI
              // renders it muted instead of alarming the user with a red block.
              if (error instanceof z.ZodError && toolInfo.formatValidationError) {
                return new RecoverableError(toolInfo.formatValidationError(error), { cause: error })
              }
              return new RecoverableError(validationErrorMessage(id, error), { cause: error })
            },
          })
          const result = yield* execute(args, ctx)
          if (result.metadata.truncated !== undefined) {
            return result
          }
          const agent = yield* agents.get(ctx.agent)
          const truncated = yield* truncate.output(result.output, {}, agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...result.metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }).pipe(Effect.orDie, Effect.withSpan("Tool.execute", { attributes: attrs }))
      }
      return toolInfo
    })
}

export function define<Parameters extends z.ZodType, Result extends Metadata, R, ID extends string = string>(
  id: ID,
  init: Effect.Effect<Init<Parameters, Result>, never, R>,
): Effect.Effect<Info<Parameters, Result>, never, R | Truncate.Service | Agent.Service> & { id: ID } {
  return Object.assign(
    Effect.gen(function* () {
      const resolved = yield* init
      const truncate = yield* Truncate.Service
      const agents = yield* Agent.Service
      return { id, init: wrap(id, resolved, truncate, agents) }
    }),
    { id },
  )
}

export function init<P extends z.ZodType, M extends Metadata>(info: Info<P, M>): Effect.Effect<Def<P, M>> {
  return Effect.gen(function* () {
    const init = yield* info.init()
    return {
      ...init,
      id: info.id,
    }
  })
}
