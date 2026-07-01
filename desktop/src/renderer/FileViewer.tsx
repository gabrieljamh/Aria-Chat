import React, { useEffect, useState } from "react"
import { Markdown } from "./Markdown"

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

type Kind = "html" | "svg" | "markdown" | "image" | "audio" | "video" | "other"
function kindOf(p: string): Kind {
  if (/\.(html?|htm)$/i.test(p)) return "html"
  if (/\.svg$/i.test(p)) return "svg"
  if (/\.(md|markdown|mdx)$/i.test(p)) return "markdown"
  if (/\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?)$/i.test(p)) return "image"
  if (/\.(mp3|wav|ogg|flac|aac|m4a|wma|opus)$/i.test(p)) return "audio"
  if (/\.(mp4|webm|mkv|avi|mov|wmv|flv|m4v|ogv)$/i.test(p)) return "video"
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
  const isMedia = kind === "image" || kind === "audio" || kind === "video"
  const [mode, setMode] = useState<"preview" | "code">("preview")

  useEffect(() => {
    const k = kindOf(path)
    setMode(k !== "other" ? "preview" : "code")
    if (k === "html" || k === "svg" || k === "image" || k === "audio" || k === "video") {
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
      if (kind === "image") {
        return previewUrl
          ? <img className="file-viewer-media" src={previewUrl} alt={basename(path)} />
          : <div className="empty-note">Image preview unavailable</div>
      }
      if (kind === "audio") {
        return previewUrl
          ? <audio className="file-viewer-media" controls src={previewUrl} />
          : <div className="empty-note">Audio preview unavailable</div>
      }
      if (kind === "video") {
        return previewUrl
          ? <video className="file-viewer-media" controls src={previewUrl} />
          : <div className="empty-note">Video preview unavailable</div>
      }
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
            <button onClick={() => window.mimo.showItemInFolder(path)}>Show in folder</button>
            <button onClick={() => window.mimo.openPath(path)}>Open externally</button>
            <button onClick={onClose}>Close</button>
          </div>
        </div>
        <div className="file-viewer-path">{path}</div>
        <div className="file-viewer-body">
          {renderBody()}
          {truncated && (
            <div className="hint">Preview truncated (file is large). Use "Open externally" for the full file.</div>
          )}
        </div>
      </div>
    </div>
  )
}
