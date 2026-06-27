import React, { useEffect, useState } from "react"
import { Markdown } from "./Markdown"

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

type Kind = "html" | "svg" | "markdown" | "other"
function kindOf(p: string): Kind {
  if (/\.(html?|htm)$/i.test(p)) return "html"
  if (/\.svg$/i.test(p)) return "svg"
  if (/\.(md|markdown|mdx)$/i.test(p)) return "markdown"
  return "other"
}

interface Props {
  path: string
  onClose: () => void
}

export function FileViewer({ path, onClose }: Props) {
  const [content, setContent] = useState<string>("")
  const [truncated, setTruncated] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)

  const kind = kindOf(path)
  const previewable = kind !== "other"
  // Default to the rendered preview for previewable files; raw code otherwise.
  const [mode, setMode] = useState<"preview" | "code">("preview")

  useEffect(() => {
    const k = kindOf(path)
    setMode(k !== "other" ? "preview" : "code")
    // HTML/SVG load by URL so sibling assets (relative paths) resolve; markdown
    // renders from text. Fall back to inline srcDoc if the URL can't be made.
    if (k === "html" || k === "svg") {
      let cancelled = false
      setPreviewUrl(null)
      window.mimo.getPreviewUrl(path).then((u) => { if (!cancelled) setPreviewUrl(u) }).catch(() => {})
      return () => { cancelled = true }
    }
    setPreviewUrl(null)
  }, [path])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    window.mimo
      .readFileText(path)
      .then((r) => {
        if (cancelled) return
        setContent(r.content)
        setTruncated(r.truncated)
        setError(r.error ?? null)
      })
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [path])

  const renderBody = () => {
    if (loading) return <div className="empty-note">Loading…</div>
    if (error) return <div className="form-msg err">{error}</div>
    if (previewable && mode === "preview") {
      if (kind === "markdown") return <Markdown>{content}</Markdown>
      // HTML and SVG render in a sandboxed iframe so their own styling shows.
      // The agent authors these files, so we allow scripts + same-origin so
      // richer pages (external resources, fetch, forms) work as written.
      return (
        <iframe
          className="file-viewer-frame"
          title={basename(path)}
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-modals"
          {...(previewUrl ? { src: previewUrl } : { srcDoc: content })}
        />
      )
    }
    return <pre className="file-viewer-pre">{content}</pre>
  }

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div className="modal file-viewer" onMouseDown={(e) => e.stopPropagation()}>
        <div className="file-viewer-head">
          <div className="file-viewer-title" title={path}>
            {basename(path)}
          </div>
          <div className="file-viewer-actions">
            {previewable && (
              <div className="file-viewer-tabs">
                <button className={mode === "preview" ? "active" : ""} onClick={() => setMode("preview")}>
                  Preview
                </button>
                <button className={mode === "code" ? "active" : ""} onClick={() => setMode("code")}>
                  Code
                </button>
              </div>
            )}
            <button onClick={() => window.mimo.openPath(path)}>Open externally</button>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="file-viewer-path">{path}</div>
        <div className="file-viewer-body">
          {renderBody()}
          {truncated && (
            <div className="hint">Preview truncated (file is large). Use “Open externally” for the full file.</div>
          )}
        </div>
      </div>
    </div>
  )
}
