import React, { useEffect, useState } from "react"
import type { ServerStatus } from "@shared/types"

interface Props {
  onClose: () => void
}

/**
 * Minimal modal to attach the app to a MiMo Code server the user runs
 * themselves (or revert to the bundled, auto-spawned one). Persists the choice
 * and reconnects live via window.mimo.reconnectServer — no app restart needed.
 */
export function CustomServerModal({ onClose }: Props) {
  const [url, setUrl] = useState("")
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.mimo.getSetting("serverUrl").then((v) => { if (typeof v === "string") setUrl(v) })
    window.mimo.getSetting("serverPassword").then((v) => { if (typeof v === "string") setPassword(v) })
  }, [])

  const apply = async (targetUrl: string | null, targetPassword: string | null) => {
    setBusy(true)
    setError(null)
    try {
      const status: ServerStatus = await window.mimo.reconnectServer(targetUrl, targetPassword)
      if (status.state === "error") {
        setError((status as { message?: string }).message || "Could not connect.")
        return
      }
      onClose()
    } catch (e: any) {
      setError(String(e?.message ?? e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-overlay cs-overlay" onMouseDown={onClose}>
      <div className="cs-modal" onMouseDown={(e) => e.stopPropagation()}>
        <h2 className="cs-title">Connect to a server</h2>
        <p className="cs-sub">
          Point the app at a MiMo Code server you're already running, instead of the bundled one.
        </p>

        <label className="cs-label">Server URL</label>
        <input
          className="cs-input"
          placeholder="http://127.0.0.1:4096"
          value={url}
          autoFocus
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) apply(url, password) }}
        />

        <label className="cs-label">
          Password <span className="cs-opt">(optional)</span>
        </label>
        <input
          className="cs-input"
          type="password"
          placeholder="MIMOCODE_SERVER_PASSWORD"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && url.trim()) apply(url, password) }}
        />

        {error && <div className="cs-error">{error}</div>}

        <div className="cs-actions">
          <button className="cs-ghost" onClick={() => apply(null, null)} disabled={busy} title="Revert to the auto-started bundled server">
            Use bundled server
          </button>
          <div className="cs-spacer" />
          <button className="cs-cancel" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="cs-primary" onClick={() => apply(url, password)} disabled={busy || !url.trim()}>
            {busy ? "Connecting…" : "Connect"}
          </button>
        </div>
      </div>
    </div>
  )
}
