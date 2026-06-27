import { useEffect, useState } from "react"
import type { ModelRef, ProvidersResponse } from "@shared/types"
import type { ConvMessage, State } from "./types-internal"

const CHARS_PER_TOKEN = 4
const fmt = new Intl.NumberFormat("en-US")
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })

interface Props {
  state: State
  providers: ProvidersResponse | null
  model: ModelRef | null
  // Global auto-compaction token threshold (from settings), or null when unset.
  compactThreshold?: number | null
}

const clamp = (n: number) => Math.max(0, Math.min(100, n))

/**
 * Live session stats, mirroring the MiMo CLI sidebar: context tokens + percent
 * of the model's window (as a bar), streaming tokens/sec (only while a turn is
 * generating), and cumulative cost. When an auto-compaction threshold is set, a
 * second bar shows how close the context is to forcing a compaction.
 */
export function StatsPanel({ state, providers, model, compactThreshold }: Props) {
  // Re-render once a second while streaming so the t/s readout ticks between deltas.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!state.busy) return
    const h = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(h)
  }, [state.busy])

  const assistant = state.order
    .map((id) => state.messages[id])
    .filter((m): m is ConvMessage => !!m && m.info.role === "assistant")

  const cost = assistant.reduce((s, m) => {
    const c = (m.info as { cost?: unknown }).cost
    return s + (typeof c === "number" ? c : 0)
  }, 0)

  // Context size = the last assistant message that reported output tokens.
  let tokens = 0
  let percent: number | null = null
  for (let i = assistant.length - 1; i >= 0; i--) {
    const info = assistant[i].info as {
      tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
      providerID?: string
      modelID?: string
    }
    const t = info.tokens
    if (t && (t.output ?? 0) > 0) {
      tokens = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
      // Resolve the context window from the message's model, falling back to the
      // currently-selected model when the message doesn't carry provider/model ids.
      const pid = info.providerID ?? model?.providerID
      const mid = info.modelID ?? model?.modelID
      const ctx = providers?.all.find((p) => p.id === pid)?.models?.[mid ?? ""]?.limit?.context
      percent = ctx ? (tokens / ctx) * 100 : null
      break
    }
  }

  // Streaming tokens/sec from the in-flight assistant message (text + reasoning).
  let tps: number | null = null
  if (state.busy && assistant.length) {
    const last = assistant[assistant.length - 1]
    const time = (last.info as { time?: { created?: number; completed?: number } }).time
    if (!time?.completed) {
      const text = last.parts
        .filter((p) => p.type === "text" || p.type === "reasoning")
        .map((p) => (p as { text?: string }).text ?? "")
        .join("")
      const est = Math.max(0, Math.round(text.length / CHARS_PER_TOKEN))
      if (est > 0 && time?.created) {
        const elapsed = (Date.now() - time.created) / 1000
        if (elapsed >= 0.5) tps = est / elapsed
      }
    }
  }
  const tpsLabel = tps == null ? null : tps < 1 ? "<1 t/s" : `${Math.round(tps)} t/s`

  const thr = compactThreshold && compactThreshold > 0 ? compactThreshold : null
  const thrPercent = thr ? (tokens / thr) * 100 : null
  const remaining = thr ? Math.max(0, thr - tokens) : null

  return (
    <div className="panel-section stats-section">
      <h3>Stats</h3>

      <div className="stat-row">
        <span className="stat-label">Context</span>
        <span className="stat-val">{fmt.format(tokens)} tokens</span>
      </div>
      {percent != null && (
        <div className="stat-bar-wrap">
          <div className="stat-bar">
            <div
              className={"stat-bar-fill" + (percent >= 90 ? " danger" : percent >= 75 ? " warn" : "")}
              style={{ width: clamp(percent) + "%" }}
            />
          </div>
          <span className="stat-bar-cap">{Math.round(percent)}% of context window</span>
        </div>
      )}

      {tpsLabel && (
        <div className="stat-row">
          <span className="stat-label">Speed</span>
          <span className="stat-val">{tpsLabel}</span>
        </div>
      )}

      <div className="stat-row">
        <span className="stat-label">Cost</span>
        <span className="stat-val">{money.format(cost)}</span>
      </div>

      {thr != null && thrPercent != null && remaining != null && (
        <div className="stat-bar-wrap compact-bar">
          <div className="stat-bar-cap top">
            <span>Auto-compaction</span>
            <span>{Math.round(thrPercent)}%</span>
          </div>
          <div className="stat-bar">
            <div
              className={"stat-bar-fill" + (thrPercent >= 90 ? " danger" : " warn")}
              style={{ width: clamp(thrPercent) + "%" }}
            />
          </div>
          <span className="stat-bar-cap">{fmt.format(remaining)} tokens left until it fires</span>
        </div>
      )}
    </div>
  )
}
