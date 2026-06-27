import React, { useEffect, useState } from "react"
import type { ServerStatus } from "@shared/types"
import ariaLogo from "@shared/img/aria-logo.png"
import ariaText from "@shared/img/aria-text.png"

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
        : "Starting Aria Chat…"

  return (
    <div className={"splash" + (ready ? " splash-hide" : "") + (isError ? " splash-error" : "")}>
      <div className="splash-inner">
        <div className="splash-logos">
          <img className="splash-logo" src={ariaLogo} alt="Aria" />
          <img className="splash-logo splash-logo-aria-text" src={ariaText} alt="Aria Chat" />
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
