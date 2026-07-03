import React, { useEffect, useState, useRef, useMemo } from "react"
import type { SessionInfoFull, FileDiff } from "@shared/types"

interface Props {
  sessions: SessionInfoFull[]
  activeSessionId?: string | null
  onSelectSession?: (sessionID: string) => void
  maxItems?: number
  getDiffs?: (sessionID: string) => Promise<FileDiff[]>
}

function diffColor(d: { additions: number; deletions: number; status?: string }): string {
  if (d.additions > 0 && d.deletions > 0) return "var(--diff-modified, #f0883e)"
  if (d.additions > 0) return "#3fb950"
  if (d.deletions > 0) return "#f85149"
  if (d.status === "modified") return "var(--diff-modified, #f0883e)"
  if (d.status === "added") return "#3fb950"
  if (d.status === "deleted") return "#f85149"
  return "var(--bg-elevated)"
}

function intensity(total: number): number {
  if (total === 0) return 0.3
  if (total < 5) return 0.45
  if (total < 20) return 0.65
  if (total < 100) return 0.8
  return 1
}

interface AggregatedFile {
  file: string
  additions: number
  deletions: number
  status?: string
  sessions: number
}

export function DiffGrid(props: Props) {
  const [diffsMap, setDiffsMap] = useState<Record<string, FileDiff[]>>({})
  const fetching = useRef<Set<string>>(new Set())

  const sessions = props.sessions
    .filter((s) => s.summary || (s.time?.updated ?? 0) > 0)
    .slice(0, props.maxItems ?? 50)

  useEffect(() => {
    if (!props.getDiffs) return
    for (const s of sessions) {
      const id = s.id
      if (diffsMap[id] || fetching.current.has(id)) continue
      const hasDiffs = s.summary?.diffs && s.summary.diffs.length > 0
      const hasCounts = (s.summary?.additions ?? 0) > 0 || (s.summary?.deletions ?? 0) > 0
      if (hasDiffs) continue
      if (!hasCounts) continue
      fetching.current.add(id)
      props.getDiffs(id).then((d) => {
        fetching.current.delete(id)
        if (d.length > 0) setDiffsMap((prev) => ({ ...prev, [id]: d }))
      }).catch(() => { fetching.current.delete(id) })
    }
  })

  const aggregated = useMemo(() => {
    const map = new Map<string, AggregatedFile>()
    for (const s of sessions) {
      const inline = s.summary?.diffs ?? []
      const fetched = diffsMap[s.id] ?? []
      const diffs = inline.length > 0 ? inline : fetched
      for (const d of diffs) {
        const existing = map.get(d.file)
        if (existing) {
          existing.additions += d.additions
          existing.deletions += d.deletions
          existing.sessions++
          if (d.status && !existing.status) existing.status = d.status
        } else {
          map.set(d.file, {
            file: d.file,
            additions: d.additions,
            deletions: d.deletions,
            status: d.status,
            sessions: 1,
          })
        }
      }
    }
    return [...map.values()].sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
  }, [sessions, diffsMap])

  const totalAdditions = aggregated.reduce((s, f) => s + f.additions, 0)
  const totalDeletions = aggregated.reduce((s, f) => s + f.deletions, 0)
  const totalFiles = aggregated.length
  const totalSessions = sessions.filter((s) => (s.summary?.additions ?? 0) > 0 || (s.summary?.deletions ?? 0) > 0).length

  if (totalFiles === 0 && totalAdditions === 0 && totalDeletions === 0) return null

  return (
    <div className="diff-grid-global">
      <div className="diff-grid-header">
        <span className="diff-grid-title">Project Changes</span>
        <div className="diff-grid-totals">
          <span className="diff-total add">+{totalAdditions}</span>
          <span className="diff-total del">-{totalDeletions}</span>
          <span className="diff-total files">{totalFiles} files</span>
          <span className="diff-total sessions">{totalSessions} sessions</span>
        </div>
      </div>
      <div className="diff-squares-grid">
        {aggregated.length > 0 ? (
          aggregated.slice(0, 256).map((f, i) => (
            <div
              key={i}
              className="diff-square"
              style={{
                background: diffColor(f),
                opacity: intensity(f.additions + f.deletions),
              }}
              title={`${f.file}: +${f.additions} -${f.deletions} (${f.sessions} session${f.sessions > 1 ? "s" : ""})`}
            />
          ))
        ) : (
          <span className="diff-grid-empty">No file changes recorded</span>
        )}
      </div>
      {(totalAdditions > 0 || totalDeletions > 0) && (
        <div className="diff-grid-legend">
          <span className="diff-square-legend" style={{ background: "#3fb950" }} />
          <span>Added</span>
          <span className="diff-square-legend" style={{ background: "#f85149" }} />
          <span>Removed</span>
          <span className="diff-square-legend" style={{ background: "var(--diff-modified, #f0883e)" }} />
          <span>Modified</span>
        </div>
      )}
    </div>
  )
}
