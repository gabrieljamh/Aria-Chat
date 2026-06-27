import React, { useMemo, useState } from "react"
import type { QuestionState } from "./useConversation"

interface Props {
  question: QuestionState
  onReply: (requestID: string, answers: string[][]) => void
  onReject: (requestID: string) => void
}

type Q = QuestionState["questions"][number]

/** Custom free-text answers are allowed unless the server explicitly sets it false. */
function customAllowed(q: Q): boolean {
  return q.custom !== false
}

/**
 * Inline multiple-choice prompt for a `question.asked` request (the AskUserQuestion
 * tool). State is kept structured — one list of selected option labels plus an
 * optional custom string per question — so labels are never round-tripped through
 * a comma-joined string. On submit we build `string[][]`, one entry per question,
 * each holding the chosen labels (+ custom text), matching the server's reply
 * schema. The directory is attached upstream in App.questionReply.
 */
export function QuestionCard({ question, onReply, onReject }: Props) {
  const qs = question.questions
  const [selected, setSelected] = useState<string[][]>(() => qs.map(() => []))
  const [custom, setCustom] = useState<string[]>(() => qs.map(() => ""))
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleOption = (qi: number, label: string) => {
    setSelected((prev) => {
      const next = prev.map((row) => [...row])
      const row = next[qi]
      const at = row.indexOf(label)
      if (at >= 0) {
        row.splice(at, 1) // deselect
      } else if (qs[qi].multiple) {
        row.push(label) // add to multi-select
      } else {
        next[qi] = [label] // single-select: replace
      }
      return next
    })
  }

  const setCustomAt = (qi: number, value: string) => {
    setCustom((prev) => prev.map((c, i) => (i === qi ? value : c)))
  }

  // Build one answer array per question: selected labels followed by custom text.
  const answers = useMemo<string[][]>(
    () =>
      qs.map((_, i) => {
        const c = custom[i].trim()
        return c ? [...selected[i], c] : [...selected[i]]
      }),
    [qs, selected, custom],
  )

  // Every question must have at least one selection or a custom answer.
  const canSubmit = answers.every((a) => a.length > 0)

  const submit = async () => {
    if (submitting || !canSubmit) return
    setSubmitting(true)
    setError(null)
    try {
      await onReply(question.id, answers)
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSubmitting(false)
    }
  }

  const dismiss = async () => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await onReject(question.id)
    } catch (e: any) {
      setError(e?.message ?? String(e))
      setSubmitting(false)
    }
  }

  return (
    <div className="question-card">
      {qs.map((q, qi) => (
        <div key={qi} className="question-item">
          <div className="question-header">
            <span className="question-question">{q.question}</span>
            {q.header && <span className="question-header-label">{q.header}</span>}
          </div>

          {q.options.length > 0 ? (
            <div className="question-options">
              {q.options.map((opt) => (
                <button
                  key={opt.label}
                  className={"question-option" + (selected[qi].includes(opt.label) ? " selected" : "")}
                  onClick={() => toggleOption(qi, opt.label)}
                  disabled={submitting}
                >
                  <span className="question-option-label">{opt.label}</span>
                  {opt.description && <span className="question-option-desc">{opt.description}</span>}
                </button>
              ))}
              {customAllowed(q) && (
                <div className="question-custom">
                  <input
                    placeholder="Or type your own…"
                    value={custom[qi]}
                    onChange={(e) => setCustomAt(qi, e.target.value)}
                    disabled={submitting}
                  />
                </div>
              )}
            </div>
          ) : (
            <div className="question-custom">
              <input
                placeholder="Type your answer…"
                value={custom[qi]}
                onChange={(e) => setCustomAt(qi, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSubmit) submit()
                }}
                disabled={submitting}
              />
            </div>
          )}
        </div>
      ))}

      {error && <div className="question-error">{error}</div>}

      <div className="question-actions">
        <button className="primary" onClick={submit} disabled={!canSubmit || submitting}>
          {submitting ? "Submitting…" : "Submit"}
        </button>
        <button className="secondary" onClick={dismiss} disabled={submitting}>
          Dismiss
        </button>
      </div>
    </div>
  )
}
