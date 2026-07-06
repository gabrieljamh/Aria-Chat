import { Effect, Layer, Context } from "effect"
import { Log } from "@/util"

const log = Log.create({ service: "browser-bridge" })

export function getBridgeUrl(): string | null {
  const url = process.env["MIMOCODE_WEB_AGENT_BRIDGE"]
  if (!url) return null
  return url.endsWith("/") ? url : url + "/"
}

export interface BrowserBridgeInterface {
  readonly post: <T = unknown>(
    path: string,
    body: Record<string, unknown>,
  ) => Effect.Effect<T>
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
            yield* Effect.die(
              new Error(
                "Web Agent bridge not configured (MIMOCODE_WEB_AGENT_BRIDGE env var not set). The desktop app must enable Web Agent mode.",
              ),
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
            catch: (e) => new Error(`Failed to reach browser bridge at ${fullUrl}: ${e instanceof Error ? e.message : String(e)}`),
          }).pipe(Effect.orDie)

          if (!response.ok) {
            const text = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => "unknown error",
            }).pipe(Effect.orDie)
            yield* Effect.die(new Error(`Browser bridge returned ${response.status}: ${text}`))
          }

          const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<T>,
            catch: (e) => new Error(`Failed to parse browser bridge response: ${e instanceof Error ? e.message : String(e)}`),
          }).pipe(Effect.orDie)

          return json
        }),
    })
  }),
)
