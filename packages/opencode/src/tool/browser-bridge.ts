import { Effect, Layer, Context, Data } from "effect"
import { Log } from "@/util"

const log = Log.create({ service: "browser-bridge" })

export class BrowserBridgeError extends Data.TaggedError("BrowserBridgeError")<{
  readonly message: string
}> {}

export function getBridgeUrl(): string | null {
  const url = process.env["MIMOCODE_WEB_AGENT_BRIDGE"]
  if (!url) return null
  return url.endsWith("/") ? url : url + "/"
}

export interface BrowserBridgeInterface {
  readonly post: <T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ) => Effect.Effect<T, BrowserBridgeError>
}

export class BrowserBridge extends Context.Service<BrowserBridge, BrowserBridgeInterface>()("@opencode/BrowserBridge") {}

export const BrowserBridgeLive = Layer.effect(
  BrowserBridge,
  Effect.gen(function* () {
    const baseUrl = getBridgeUrl()
    if (!baseUrl) {
      log.warn("MIMOCODE_WEB_AGENT_BRIDGE env var not set — browser tools will fail")
    }

    return BrowserBridge.of({
      post: <T = unknown>(path: string, body: Record<string, unknown>) =>
        Effect.gen(function* () {
          const url = getBridgeUrl()
          if (!url) {
            return yield* Effect.fail(
              new BrowserBridgeError({
                message:
                  "Web Agent bridge not configured (MIMOCODE_WEB_AGENT_BRIDGE env var not set). The desktop app must enable Web Agent mode.",
              }),
            )
          }

          const fullUrl = url + path.replace(/^\//, "")

          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(fullUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
              }),
            catch: (e) =>
              new BrowserBridgeError({
                message: `Failed to reach browser bridge at ${fullUrl}: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })

          if (!response.ok) {
            const text = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () =>
                new BrowserBridgeError({
                  message: `Browser bridge returned ${response.status} (failed to read response body)`,
                }),
            }).pipe(
              Effect.catchTag("BrowserBridgeError", (e) => Effect.succeed(e.message)),
            )
            return yield* Effect.fail(
              new BrowserBridgeError({
                message: `Browser bridge returned ${response.status}: ${text}`,
              }),
            )
          }

          const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<T>,
            catch: (e) =>
              new BrowserBridgeError({
                message: `Failed to parse browser bridge response: ${e instanceof Error ? e.message : String(e)}`,
              }),
          })

          return json
        }),
    })
  }),
)
