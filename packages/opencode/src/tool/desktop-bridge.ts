import { Effect, Layer, Context } from "effect"
import { Log } from "@/util"

const log = Log.create({ service: "desktop-bridge" })

export function getDesktopBridgeUrl(): string | null {
  const url = process.env["MIMOCODE_DESKTOP_BRIDGE"]
  if (!url) return null
  return url.endsWith("/") ? url : url + "/"
}

export interface DesktopBridgeInterface {
  readonly post: <T = unknown>(path: string, body: Record<string, unknown>) => Effect.Effect<T>
}

export class DesktopBridge extends Context.Service<DesktopBridge, DesktopBridgeInterface>()(
  "@opencode/DesktopBridge",
) {}

export const DesktopBridgeLive = Layer.effect(
  DesktopBridge,
  Effect.gen(function* () {
    if (!getDesktopBridgeUrl()) {
      log.warn("MIMOCODE_DESKTOP_BRIDGE env var not set — app-launch tools will fail")
    }

    return DesktopBridge.of({
      post: <T = unknown>(path: string, body: Record<string, unknown>) =>
        Effect.gen(function* () {
          const url = getDesktopBridgeUrl()
          if (!url) {
            yield* Effect.die(
              new Error(
                "Desktop bridge not configured (MIMOCODE_DESKTOP_BRIDGE env var not set). The desktop app hosts app-launch routes.",
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
            catch: (e) =>
              new Error(`Failed to reach desktop bridge at ${fullUrl}: ${e instanceof Error ? e.message : String(e)}`),
          }).pipe(Effect.orDie)

          if (!response.ok) {
            const text = yield* Effect.tryPromise({
              try: () => response.text(),
              catch: () => "unknown error",
            }).pipe(Effect.orDie)
            yield* Effect.die(new Error(`Desktop bridge returned ${response.status}: ${text}`))
          }

          const json = yield* Effect.tryPromise({
            try: () => response.json() as Promise<T>,
            catch: (e) => new Error(`Failed to parse desktop bridge response: ${e instanceof Error ? e.message : String(e)}`),
          }).pipe(Effect.orDie)

          return json
        }),
    })
  }),
)
