import { app } from "electron"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Tiny JSON-backed settings store (no native deps). Persists to
 * <userData>/settings.json.
 */
class Store {
  private file: string
  private data: Record<string, unknown> = {}

  constructor() {
    const dir = app.getPath("userData")
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.file = join(dir, "settings.json")
    if (existsSync(this.file)) {
      try {
        this.data = JSON.parse(readFileSync(this.file, "utf8"))
      } catch {
        this.data = {}
      }
    }
  }

  get(key: string): unknown {
    return this.data[key]
  }

  set(key: string, value: unknown) {
    this.data[key] = value
    this.persist()
  }

  private persist() {
    try {
      writeFileSync(this.file, JSON.stringify(this.data, null, 2))
    } catch {
      /* best-effort */
    }
  }
}

let store: Store | null = null
export function getStore(): Store {
  if (!store) store = new Store()
  return store
}
