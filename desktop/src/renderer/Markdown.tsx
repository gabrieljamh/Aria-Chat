import React, { useState, useRef, useEffect } from "react"
import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import stripAnsi from "strip-ansi"
import hljs from "highlight.js/lib/common"

export function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    return hljs.highlight(stripAnsi(code), { language: lang }).value
  }
  return ansiToHtml(stripAnsi(code))
}

import "highlight.js/styles/github-dark.min.css"
import { ansiToHtml } from "./ansi"

function CodeBlock({ lang, raw }: { lang: string; raw: string }) {
  const [folded, setFolded] = useState(false)
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout>>()
  const highlighted = lang && hljs.getLanguage(lang)
    ? hljs.highlight(stripAnsi(raw), { language: lang }).value
    : ansiToHtml(stripAnsi(raw))

  const doCopy = () => {
    navigator.clipboard.writeText(raw).catch(() => {})
    if (timerRef.current) clearTimeout(timerRef.current)
    setCopied(true)
    timerRef.current = setTimeout(() => setCopied(false), 2000)
  }

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <div className={"md-codeblock" + (folded ? " folded" : "")}>
      <div className="codeblock-bar">
        <span className="codeblock-lang">{lang || "text"}</span>
        <div className="codeblock-actions">
          <button className="codeblock-btn" onClick={doCopy} title="Copy">
            {copied ? "✓ Copied" : "Copy"}
          </button>
          <button className="codeblock-btn" onClick={() => setFolded((f) => !f)} title={folded ? "Expand" : "Collapse"}>
            {folded ? "▸ Expand" : "▾ Collapse"}
          </button>
        </div>
      </div>
      {!folded && (
        <pre><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
      )}
    </div>
  )
}

/**
 * Renders markdown with GFM, syntax-highlighted collapsible codeblocks with copy buttons.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[[remarkGfm, { breaks: true }]]}
        components={{
          a: ({ node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
          code: ({ node, className, children: codeChildren, ...props }) => {
            const isBlock = typeof className === "string" && className.includes("language-")
            const raw = Array.isArray(codeChildren) ? codeChildren.join("") : String(codeChildren ?? "")
            if (isBlock) {
              const lang = className!.replace("language-", "")
              return <CodeBlock lang={lang} raw={raw} />
            }
            return (
              <code className="md-inline" {...props}>
                {raw}
              </code>
            )
          },
        }}
      >
        {stripAnsi(children)}
      </ReactMarkdown>
    </div>
  )
}
