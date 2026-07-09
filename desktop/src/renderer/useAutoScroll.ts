import { useEffect, useRef, useState } from "react"

/**
 * Stick-to-bottom auto-scroll with a persisted on/off toggle.
 *
 * Behavior:
 * - When enabled AND the user is at (or near) the bottom, new content keeps
 *   the view pinned to the bottom.
 * - When the user scrolls up to read history, auto-scroll pauses — it resumes
 *   automatically once they scroll back to the bottom.
 * - When disabled via the toggle, the view never moves on its own.
 * - The preference persists across sessions ("autoScroll" setting, default on).
 *
 * `deps` is the list of values whose change means "new content arrived".
 * `opts.resetKey` identifies the conversation (e.g. sessionID): when it
 * changes, the next load opens scrolled to the bottom regardless of the
 * toggle or previous scroll position. `opts.loading` marks history fetch
 * in progress so the initial bottom-pin holds until content has settled.
 */
export function useAutoScroll(deps: unknown[], opts?: { resetKey?: string | null; loading?: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [enabled, setEnabled] = useState(true)
  const enabledRef = useRef(true)
  enabledRef.current = enabled
  // Whether the view is currently near the bottom. Starts true so a freshly
  // opened conversation pins to the newest message.
  const atBottomRef = useRef(true)
  // Force-scroll to bottom while a conversation is (re)loading, so chats open
  // at the newest message instead of the top. Independent of the toggle.
  const pendingInitialRef = useRef(true)
  // Guards the end of the force phase: on a session switch the first render
  // still carries loading=false from the PREVIOUS state (the reset dispatch
  // lands an effect-pass later), so clearing on "loading === false" alone
  // ended the phase before the new chat's messages ever arrived — the view
  // then fell through to the at-bottom rule and stayed at the top.
  const sawLoadingRef = useRef(false)
  const lastKeyRef = useRef<string | null | undefined>(opts?.resetKey)
  if (lastKeyRef.current !== opts?.resetKey) {
    lastKeyRef.current = opts?.resetKey
    pendingInitialRef.current = true
    sawLoadingRef.current = false
  }

  // Load the persisted preference once.
  useEffect(() => {
    window.mimo
      .getSetting("autoScroll")
      .then((v) => {
        if (v === false) setEnabled(false)
      })
      .catch(() => {})
  }, [])

  // Track whether the user is at the bottom. The scroll container renders
  // conditionally (hidden for empty chats), so re-attach on every render
  // rather than trying to guess when the ref becomes live.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    }
    onScroll()
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  })

  // Pin to the bottom until scrollHeight stops moving. A single
  // `scrollTop = scrollHeight` is not enough: messages use
  // content-visibility, so the initial scrollHeight is based on placeholder
  // estimates — as real messages render in, the height shifts and a one-shot
  // pin lands the view back at the top of the conversation.
  const pinRafRef = useRef(0)
  const pinToBottom = () => {
    if (pinRafRef.current) cancelAnimationFrame(pinRafRef.current)
    let lastH = -1
    let tries = 0
    const step = () => {
      pinRafRef.current = 0
      const el = scrollRef.current
      if (!el) return
      el.scrollTop = el.scrollHeight
      atBottomRef.current = true
      if (el.scrollHeight !== lastH && tries < 60) {
        lastH = el.scrollHeight
        tries++
        pinRafRef.current = requestAnimationFrame(step)
      }
    }
    step()
  }
  useEffect(() => () => cancelAnimationFrame(pinRafRef.current), [])

  // Pin to bottom on new content — only if enabled and already at the bottom.
  // Exception: while a conversation is loading (or just finished loading), we
  // always land at the bottom, so chats open at the newest message.
  useEffect(() => {
    if (pendingInitialRef.current) {
      if (opts?.loading) sawLoadingRef.current = true
      pinToBottom()
      // End the force phase only after a full load cycle (true -> false) has
      // been observed for THIS session; content arriving afterwards flows
      // through the normal stick-to-bottom rules.
      if (opts?.loading === undefined || (opts.loading === false && sawLoadingRef.current)) {
        pendingInitialRef.current = false
      }
      return
    }
    if (!enabledRef.current || !atBottomRef.current) return
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, opts?.resetKey, opts?.loading])

  const toggle = () => {
    setEnabled((prev) => {
      const next = !prev
      window.mimo.setSetting("autoScroll", next).catch(() => {})
      // Turning it on = "take me back to the live tail" (stabilized pin —
      // jumping across unrendered content-visibility regions shifts heights).
      if (next) pinToBottom()
      return next
    })
  }

  return { scrollRef, enabled, toggle }
}
