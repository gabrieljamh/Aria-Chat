import type { ProvidersResponse } from "@shared/types"

export interface ModelOption {
  providerID: string
  modelID: string
  label: string
}

/**
 * Build the flat list of selectable (providerID, modelID, label) entries
 * shown by ModelSearchSelect on the home screens and composer footer.
 * Connected providers take priority; if none are marked connected, all
 * providers' models are listed. Custom user-defined models are appended
 * last (deduped by `providerID/modelID`).
 */
export function buildModelOptions(
  providers: ProvidersResponse | null,
  custom: { providerID: string; modelID: string; label: string }[],
): ModelOption[] {
  const out: ModelOption[] = []
  const seen = new Set<string>()
  const push = (o: ModelOption) => {
    const key = `${o.providerID}/${o.modelID}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(o)
  }
  if (providers) {
    const connected = new Set(providers.connected ?? [])
    for (const p of providers.all ?? []) {
      if (connected.size > 0 && !connected.has(p.id)) continue
      for (const m of Object.values(p.models ?? {})) {
        push({ providerID: p.id, modelID: m.id, label: `${p.name} · ${m.name}` })
      }
    }
  }
  for (const c of custom) push({ providerID: c.providerID, modelID: c.modelID, label: c.label || `${c.providerID} · ${c.modelID}` })
  return out
}
