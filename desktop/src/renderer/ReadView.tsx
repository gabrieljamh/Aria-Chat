import React from "react"
import { highlightCode } from "./Markdown"

function guessLang(filePath?: string): string {
  if (!filePath) return ""
  const ext = filePath.split(".").pop()?.toLowerCase() ?? ""
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    json: "json", css: "css", html: "html", md: "markdown", py: "python",
    rs: "rust", go: "go", java: "java", c: "c", cpp: "cpp", h: "c",
    sh: "bash", bash: "bash", ps1: "powershell", sql: "sql", yaml: "yaml",
    yml: "yaml", xml: "xml", toml: "ini", rb: "ruby", swift: "swift",
    kt: "kotlin", dart: "dart", lua: "lua", r: "r", scala: "scala",
    dockerfile: "dockerfile", makefile: "makefile",
  }
  return map[ext] || map[filePath.toLowerCase()] || ""
}

function CodeLine({ line, lang }: { line: string; lang: string }) {
  const html = React.useMemo(() => (lang ? highlightCode(line, lang) : line), [line, lang])
  return <td className="write-text" dangerouslySetInnerHTML={{ __html: html }} />
}

interface ReadData {
  type: "file"
  content: string[]
  path: string
}
interface DirData {
  type: "dir"
  entries: string[]
  path: string
}

function parse(text: string): ReadData | DirData | null {
  const pathMatch = text.match(/<path>(.+?)<\/path>/)
  const path = pathMatch?.[1] ?? ""
  const type = text.match(/<type>(.+?)<\/type>/)?.[1]

  if (type === "directory") {
    const entriesMatch = text.match(/<entries>\n?([\s\S]*?)<\/entries>/)
    const entries = entriesMatch?.[1]?.split("\n").filter(Boolean) ?? []
    return { type: "dir", entries, path }
  }

  const contentMatch = text.match(/<content>\n([\s\S]*?)<\/content>/)
  if (contentMatch) {
    const lines = contentMatch[1].split("\n").map((l) => l.replace(/^\d+: /, ""))
    return { type: "file", content: lines, path }
  }

  return null
}

export function ReadView({ output, filePath }: { output: string; filePath?: string }) {
  const data = React.useMemo(() => parse(output), [output])
  if (!data) return <pre className="ansi">{output.slice(0, 32000)}</pre>

  const label = filePath || data.path

  if (data.type === "dir") {
    return (
      <div className="write-view">
        {label && <div className="write-file">📁 {label}/</div>}
        <table className="write-table">
          <tbody>
            {data.entries.map((entry, i) => (
              <tr key={i} className="write-line">
                <td className="write-text" style={{ paddingLeft: 16 }}>{entry.endsWith("/") ? <><span style={{ color: "var(--accent)" }}>📁</span> {entry}</> : <><span style={{ color: "var(--text-faint)" }}>📄</span> {entry}</>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  const digits = String(data.content.length).length
  const lang = guessLang(label)

  return (
    <div className="write-view">
      {label && <div className="write-file">{label}</div>}
      <table className="write-table">
        <tbody>
          {data.content.map((line, i) => (
            <tr key={i} className="write-line">
              <td className="write-ln">{String(i + 1).padStart(digits)}</td>
              <CodeLine line={line} lang={lang} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}