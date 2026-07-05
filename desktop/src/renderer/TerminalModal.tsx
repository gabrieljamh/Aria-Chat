import { useEffect, useRef } from "react"
import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import type { BashInteractiveRequest, PtyInfo } from "@shared/types"

interface Props {
  request: BashInteractiveRequest
  ptyInfo: PtyInfo
  onAbort: (ptyId: string) => void
  onSendClose: (ptyId: string) => void
  onClose: () => void
}

export function TerminalModal({ request, ptyInfo, onAbort, onSendClose, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Fira Code', 'Consolas', monospace",
      fontSize: 13,
      theme: {
        background: "#0e1013",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
        selectionBackground: "#264f78",
      },
      cursorBlink: true,
      allowProposedApi: true,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()

    termRef.current = term
    fitRef.current = fit

    // Keystrokes → main process → WS
    const dataDisposable = term.onData((data) => {
      window.mimo.ptyInput(ptyInfo.id, data)
    })

    // Resize → server PTY
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      window.mimo.ptyResize(ptyInfo.id, cols, rows)
    })

    // Output from main process → xterm
    const outputDisposable = window.mimo.onPtyOutput((payload) => {
      if (payload.id === ptyInfo.id) {
        term.write(payload.data)
      }
    })

    // PTY exit → auto close
    const exitDisposable = window.mimo.onPtyExit((payload) => {
      if (payload.id === ptyInfo.id) {
        onClose()
      }
    })

    // Handle window resize
    const resizeObserver = new ResizeObserver(() => {
      if (fitRef.current) {
        try {
          fitRef.current.fit()
        } catch {
          // container might not be visible yet
        }
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      dataDisposable.dispose()
      resizeDisposable.dispose()
      outputDisposable()
      exitDisposable()
      resizeObserver.disconnect()
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [ptyInfo.id])

  return (
    <div className="terminal-modal-overlay" onMouseDown={onClose}>
      <div className="terminal-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="terminal-header">
          <div className="terminal-title">{request.description}</div>
          <div className="terminal-actions">
            <button className="terminal-btn abort" onClick={() => onAbort(ptyInfo.id)}>Abort</button>
            <button className="terminal-btn send" onClick={() => onSendClose(ptyInfo.id)}>Send & Close</button>
            <button className="terminal-btn close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="terminal-command" title={request.cwd}>{request.command}</div>
        <div className="terminal-body" ref={containerRef} />
      </div>
    </div>
  )
}
