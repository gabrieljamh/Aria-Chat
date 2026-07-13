import { Context, Effect, Layer } from "effect"
import { Database, and, eq, isNull, or, gt, inArray, type SQL } from "@/storage"
import { Bus } from "../bus"
import { Config } from "../config"
import type { SessionID } from "../session/schema"
import { TaskTable, TaskEventTable } from "./task.sql"
import type { Task, TaskEvent } from "./schema"
import { Created as TaskCreated, Updated as TaskUpdated, type UpdatedKind } from "./events"
import { RecoverableError } from "@/tool/recoverable"

const DAY_MS = 24 * 60 * 60 * 1000

const TERMINAL_STATUSES = ["done", "abandoned"] as const

const notFoundMessage = (id: string) =>
  `Task ${id} not found. Use \`task list\` to see valid task IDs, or \`task create\` to add one.`

type TaskRow = typeof TaskTable.$inferSelect
type TaskEventRow = typeof TaskEventTable.$inferSelect

function fromTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    session_id: row.session_id as SessionID,
    parent_task_id: row.parent_task_id ?? undefined,
    status: row.status,
    summary: row.summary,
    owner: row.owner ?? undefined,
    created_at: row.created_at,
    last_event_at: row.last_event_at,
    ended_at: row.ended_at ?? undefined,
    cleanup_after: row.cleanup_after ?? undefined,
  }
}

function fromEventRow(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    task_id: row.task_id,
    at: row.at,
    kind: row.kind as TaskEvent["kind"],
    summary: row.summary ?? undefined,
  }
}

function nextChildId(parentId: string | undefined, siblings: string[]): string {
  const prefix = parentId ? `${parentId}.` : "T"
  const used = siblings
    .filter((s) => (parentId ? s.startsWith(prefix) : /^T\d+$/.test(s)))
    .map((s) => {
      const tail = s.slice(prefix.length)
      return /^\d+$/.test(tail) ? Number(tail) : 0
    })
  const next = used.length > 0 ? Math.max(...used) + 1 : 1
  return `${prefix}${next}`
}

export interface Interface {
  readonly create: (input: {
    session_id: SessionID
    summary: string
    parent_id?: string
    owner?: string
  }) => Effect.Effect<Task>

  readonly list: (input: {
    session_id?: SessionID
    status?: Task["status"]
    statuses?: readonly Task["status"][]
    owner?: string
    include_terminal?: boolean
    include_archived?: boolean
  }) => Effect.Effect<Task[]>

  readonly get: (input: { session_id: SessionID; id: string }) => Effect.Effect<Task | undefined>

  readonly block: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly unblock: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly done: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly abandon: (input: { session_id: SessionID; id: string; event_summary?: string }) => Effect.Effect<Task>
  readonly rename: (input: { session_id: SessionID; id: string; summary: string }) => Effect.Effect<Task>

  readonly start: (input: { session_id: SessionID; id: string; owner?: string; event_summary?: string }) => Effect.Effect<Task>

  readonly events: (input: { session_id: SessionID; task_id: string }) => Effect.Effect<TaskEvent[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TaskRegistry") {}

export const layer: Layer.Layer<Service, never, Bus.Service | Config.Service> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const config = yield* Config.Service

    const cleanupAfterDays = Effect.fn("TaskRegistry.cleanupAfterDays")(function* () {
      const cfg = yield* config.get()
      return cfg.checkpoint?.task_archive_days ?? cfg.checkpoint?.task_cleanup_days ?? 7
    })

    const publishCreated = (task: Task) =>
      Effect.runFork(bus.publish(TaskCreated, { sessionID: task.session_id, task }))

    const publishUpdated = (task: Task, kind: UpdatedKind) =>
      Effect.runFork(bus.publish(TaskUpdated, { sessionID: task.session_id, task, kind }))

    const taskWhere = (session_id: SessionID, id: string) =>
      and(eq(TaskTable.session_id, session_id), eq(TaskTable.id, id))

    const create = Effect.fn("TaskRegistry.create")(function* (input: {
      session_id: SessionID
      summary: string
      parent_id?: string
      owner?: string
    }) {
      const now = Date.now()
      const id = Database.use((db) => {
        const siblings = db
          .select({ id: TaskTable.id })
          .from(TaskTable)
          .where(
            and(
              eq(TaskTable.session_id, input.session_id),
              input.parent_id ? eq(TaskTable.parent_task_id, input.parent_id) : isNull(TaskTable.parent_task_id),
            ),
          )
          .all()
        const next = nextChildId(input.parent_id, siblings.map((s) => s.id))
        const row: TaskRow = {
          id: next,
          session_id: input.session_id,
          parent_task_id: input.parent_id ?? null,
          status: "open",
          summary: input.summary,
          owner: input.owner ?? null,
          created_at: now,
          last_event_at: now,
          ended_at: null,
          cleanup_after: null,
        }
        db.transaction(() => {
          db.insert(TaskTable).values(row).run()
          db.insert(TaskEventTable)
            .values({ session_id: input.session_id, task_id: next, at: now, kind: "created", summary: null })
            .run()
        })
        return next
      })
      const task = fromTaskRow({
        id,
        session_id: input.session_id,
        parent_task_id: input.parent_id ?? null,
        status: "open",
        summary: input.summary,
        owner: input.owner ?? null,
        created_at: now,
        last_event_at: now,
        ended_at: null,
        cleanup_after: null,
      })
      publishCreated(task)
      return task
    })

    const list = Effect.fn("TaskRegistry.list")(function* (input: {
      session_id?: SessionID
      status?: Task["status"]
      statuses?: readonly Task["status"][]
      owner?: string
      include_terminal?: boolean
      include_archived?: boolean
    }) {
      const now = Date.now()
      const conds: SQL[] = []
      if (input.session_id) conds.push(eq(TaskTable.session_id, input.session_id))
      if (input.status) conds.push(eq(TaskTable.status, input.status))
      if (input.statuses && input.statuses.length > 0) conds.push(inArray(TaskTable.status, input.statuses as Task["status"][]))
      if (input.owner) conds.push(eq(TaskTable.owner, input.owner))
      if (!input.include_terminal && !input.status && !input.statuses) {
        const nonTerminal = or(
          eq(TaskTable.status, "open"),
          eq(TaskTable.status, "in_progress"),
          eq(TaskTable.status, "blocked"),
        )
        if (nonTerminal) conds.push(nonTerminal)
      }
      if (!input.include_archived) {
        const notArchived = or(isNull(TaskTable.cleanup_after), gt(TaskTable.cleanup_after, now))
        if (notArchived) conds.push(notArchived)
      }
      const where = conds.length > 0 ? and(...conds) : undefined
      const rows = Database.use((db) =>
        db.select().from(TaskTable).where(where).orderBy(TaskTable.created_at).all(),
      )
      return rows.map(fromTaskRow)
    })

    const get = Effect.fn("TaskRegistry.get")(function* (input: { session_id: SessionID; id: string }) {
      const row = Database.use((db) =>
        db
          .select()
          .from(TaskTable)
          .where(and(eq(TaskTable.session_id, input.session_id), eq(TaskTable.id, input.id)))
          .get(),
      )
      return row ? fromTaskRow(row) : undefined
    })

    const events = Effect.fn("TaskRegistry.events")(function* (input: { session_id: SessionID; task_id: string }) {
      const rows = Database.use((db) =>
        db
          .select()
          .from(TaskEventTable)
          .where(and(eq(TaskEventTable.session_id, input.session_id), eq(TaskEventTable.task_id, input.task_id)))
          .orderBy(TaskEventTable.at)
          .all(),
      )
      return rows.map(fromEventRow)
    })

    type MutateResult =
      | { kind: "ok"; task: Task }
      | { kind: "not_found" }
      | { kind: "terminal"; task: Task }
    const mutate = (
      session_id: SessionID,
      id: string,
      set: Partial<TaskRow>,
      eventKind: TaskEvent["kind"],
      eventSummary: string | undefined,
      now: number,
      guardTerminal?: boolean,
    ): MutateResult =>
      Database.use((db) =>
        db.transaction(() => {
          if (guardTerminal) {
            const current = db.select().from(TaskTable).where(taskWhere(session_id, id)).get() as TaskRow | undefined
            if (!current) return { kind: "not_found" }
            if (TERMINAL_STATUSES.includes(current.status as (typeof TERMINAL_STATUSES)[number]))
              return { kind: "terminal", task: fromTaskRow(current) }
          }
          const row = db
            .update(TaskTable)
            .set(set)
            .where(taskWhere(session_id, id))
            .returning()
            .get() as TaskRow | undefined
          if (!row) return { kind: "not_found" }
          db.insert(TaskEventTable)
            .values({ session_id, task_id: id, at: now, kind: eventKind, summary: eventSummary ?? null })
            .run()
          return { kind: "ok" as const, task: fromTaskRow(row) }
        }),
      )

    const block = Effect.fn("TaskRegistry.block")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const result = mutate(input.session_id, input.id, { status: "blocked", last_event_at: now }, "blocked", input.event_summary, now, true)
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") {
        yield* Effect.logWarning(`refusing to block terminal task ${input.id} (status=${result.task.status})`)
        return result.task
      }
      publishUpdated(result.task, "blocked")
      return result.task
    })

    const unblock = Effect.fn("TaskRegistry.unblock")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const result = mutate(input.session_id, input.id, { status: "open", last_event_at: now }, "unblocked", input.event_summary, now, true)
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") {
        yield* Effect.logWarning(`refusing to unblock terminal task ${input.id} (status=${result.task.status})`)
        return result.task
      }
      publishUpdated(result.task, "unblocked")
      return result.task
    })

    const start = Effect.fn("TaskRegistry.start")(function* (input: {
      session_id: SessionID
      id: string
      owner?: string
      event_summary?: string
    }) {
      const now = Date.now()
      const existing = yield* get({ session_id: input.session_id, id: input.id })
      if (!existing) return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))

      if (existing.status === "done" || existing.status === "abandoned") {
        yield* Effect.logWarning(`refusing to start terminal task ${input.id} (status=${existing.status})`)
        return existing
      }

      const owner = input.owner ?? existing.owner
      if (existing.status === "in_progress" && owner === existing.owner) return existing

      const result = mutate(
        input.session_id,
        input.id,
        { status: "in_progress", owner: owner ?? null, last_event_at: now },
        "started",
        input.event_summary,
        now,
        true,
      )
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") return result.task
      publishUpdated(result.task, "started")
      return result.task
    })

    const done = Effect.fn("TaskRegistry.done")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const days = yield* cleanupAfterDays()
      const result = mutate(
        input.session_id,
        input.id,
        { status: "done", ended_at: now, cleanup_after: now + days * DAY_MS, last_event_at: now },
        "done",
        input.event_summary,
        now,
        true,
      )
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") {
        yield* Effect.logWarning(`task ${input.id} already terminal (status=${result.task.status}), returning as-is`)
        return result.task
      }
      publishUpdated(result.task, "done")
      return result.task
    })

    const abandon = Effect.fn("TaskRegistry.abandon")(function* (input: {
      session_id: SessionID
      id: string
      event_summary?: string
    }) {
      const now = Date.now()
      const days = yield* cleanupAfterDays()
      const result = mutate(
        input.session_id,
        input.id,
        { status: "abandoned", ended_at: now, cleanup_after: now + days * DAY_MS, last_event_at: now },
        "abandoned",
        input.event_summary,
        now,
        true,
      )
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") {
        yield* Effect.logWarning(`task ${input.id} already terminal (status=${result.task.status}), returning as-is`)
        return result.task
      }
      publishUpdated(result.task, "abandoned")
      return result.task
    })

    const rename = Effect.fn("TaskRegistry.rename")(function* (input: {
      session_id: SessionID
      id: string
      summary: string
    }) {
      const now = Date.now()
      const result = mutate(input.session_id, input.id, { summary: input.summary, last_event_at: now }, "renamed", input.summary, now, true)
      if (result.kind === "not_found") return yield* Effect.die(new RecoverableError(notFoundMessage(input.id)))
      if (result.kind === "terminal") {
        yield* Effect.logWarning(`refusing to rename terminal task ${input.id} (status=${result.task.status})`)
        return result.task
      }
      publishUpdated(result.task, "renamed")
      return result.task
    })

    return Service.of({
      create,
      list,
      get,
      events,
      block,
      unblock,
      done,
      abandon,
      rename,
      start,
    })
  }),
)

export const defaultLayer = Layer.suspend(() => layer.pipe(Layer.provide(Bus.layer), Layer.provide(Config.defaultLayer)))

export * as TaskRegistry from "./registry"
