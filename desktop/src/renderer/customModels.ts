import { useEffect, useState } from "react"
import type { CustomModel } from "@shared/types"

/**
 * Tiny renderer-side store for user-defined custom models. Backed by the main
 * process settings store (window.mimo getSetting/setSetting "customModels") and
 * shared across the composer and the settings modal via a subscription.
 */
let cache: CustomModel[] = []
let loaded = false
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

export async function loadCustomModels(): Promise<void> {
  const v = await window.mimo.getSetting("customModels").catch(() => null)
  cache = Array.isArray(v) ? (v as CustomModel[]) : []
  loaded = true
  emit()
}

export function getCustomModels(): CustomModel[] {
  return cache
}

export async function saveCustomModels(next: CustomModel[]): Promise<void> {
  cache = next
  emit()
  await window.mimo.setSetting("customModels", next).catch(() => {})
}

/** React hook: returns the current custom models and keeps the component in sync. */
export function useCustomModels(): CustomModel[] {
  const [, force] = useState(0)
  useEffect(() => {
    const rerender = () => force((n) => n + 1)
    if (!loaded) void loadCustomModels()
    listeners.add(rerender)
    return () => {
      listeners.delete(rerender)
    }
  }, [])
  return cache
}
