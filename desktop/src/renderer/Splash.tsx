import React, { useEffect, useState } from "react"
import type { ServerStatus } from "@shared/types"
import xiaomiLogo from "@shared/img/xiaomi-logo.png"
import mimoLogo from "@shared/img/mimo-logo.png"

interface Props {
  status: ServerStatus
  // True once the server is ready AND the initial chats/providers have loaded.
  ready: boolean
  onCustomServer: () => void
}

/**
 * Full-window loading screen shown until the server is ready and the first data
 * has loaded, then it fades out and unmounts. On an error it explains what went
 * wrong and offers to connect to a custom server instead.
 */
export function Splash({ status, ready, onCustomServer }: Props) {
  // Stay mounted briefly after `ready` so the fade-out can play, then unmount.
  const [done, setDone] = useState(false)
  useEffect(() => {
    if (!ready) {
      setDone(false)
      return
    }
    const t = setTimeout(() => setDone(true), 480)
    return () => clearTimeout(t)
  }, [ready])

  if (done) return null

  const isError = status.state === "error"
  const message = isError
    ? (status as { message?: string }).message || "The server could not be reached."
    : status.state === "ready"
      ? "Loading your chats…"
      : status.state === "stopped"
        ? "Connecting…"
        : "Starting MiMo Tasker…"

  return (
    <div className={"splash" + (ready ? " splash-hide" : "") + (isError ? " splash-error" : "")}>
      <div className="splash-inner">
        <div className="splash-logos">
          <img className="splash-logo" src={xiaomiLogo} alt="Xiaomi" />
          <img className="splash-logo splash-logo-mimo" src={mimoLogo} alt="MiMo Tasker" />
        </div>
        {!isError && <div className="splash-spinner" aria-hidden />}
        <div className={"splash-message" + (isError ? " err" : "")}>{message}</div>
        <button className="splash-link" onClick={onCustomServer}>
          {isError ? "Connect to a custom server" : "Use a custom server"}
        </button>
      </div>
    </div>
  )
}
