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

function DiffLineCell({ content, lang }: { content: string; lang: string }) {
  const html = React.useMemo(() => (lang ? highlightCode(content, lang) : content), [content, lang])
  return <td className="diff-text" dangerouslySetInnerHTML={{ __html: html }} />
}

interface DiffLine {
  type: "add" | "del" | "ctx"
  content: string
  oldNum: string
  newNum: string
}

/**
 * Parses a unified diff string into structured lines for rendering.
 * Supports single-file unified diffs (---/+++ header + @@ hunks).
 */
function parseDiff(diff: string): { oldFile: string; newFile: string; lines: DiffLine[] } {
  const lines: DiffLine[] = []
  let oldFile = ""
  let newFile = ""
  let oldLine = 0
  let newLine = 0

  for (const raw of diff.split("\n")) {
    const line = raw.replace(/\r$/, "")
    if (line.startsWith("--- ")) {
      oldFile = line.slice(4)
      continue
    }
    if (line.startsWith("+++ ")) {
      newFile = line.slice(4)
      continue
    }
    const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunkMatch) {
      oldLine = Number(hunkMatch[1])
      newLine = Number(hunkMatch[2])
      lines.push({ type: "ctx", content: line, oldNum: "", newNum: "" })
      continue
    }
    if (line.startsWith("+")) {
      lines.push({ type: "add", content: line, oldNum: "", newNum: String(newLine) })
      newLine++
    } else if (line.startsWith("-")) {
      lines.push({ type: "del", content: line, oldNum: String(oldLine), newNum: "" })
      oldLine++
    } else {
      lines.push({ type: "ctx", content: line, oldNum: String(oldLine), newNum: String(newLine) })
      oldLine++
      newLine++
    }
  }

  return { oldFile, newFile, lines }
}

export function DiffView({ diff, filePath }: { diff: string; filePath?: string }) {
  const { oldFile, newFile, lines } = React.useMemo(() => parseDiff(diff), [diff])
  const fileLabel = filePath || newFile || oldFile
  const lang = guessLang(filePath || newFile || oldFile)

  return (
    <div className="diff-view">
      {fileLabel && <div className="diff-file">{fileLabel}</div>}
      <table className="diff-table">
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className={`diff-line diff-line-${l.type}`}>
              <td className="diff-ln diff-ln-old">{l.oldNum}</td>
              <td className="diff-ln diff-ln-new">{l.newNum}</td>
              <td className="diff-sign">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</td>
              <DiffLineCell content={l.content.slice(1)} lang={lang} />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}