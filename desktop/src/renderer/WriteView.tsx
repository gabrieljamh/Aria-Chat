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

export function WriteView({ content, filePath }: { content: string; filePath?: string }) {
  const lang = guessLang(filePath)
  const lines = content.split("\n")
  const digits = String(lines.length).length

  return (
    <div className="write-view">
      {filePath && <div className="write-file">{filePath}</div>}
      <table className="write-table">
        <tbody>
          {lines.map((line, i) => (
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