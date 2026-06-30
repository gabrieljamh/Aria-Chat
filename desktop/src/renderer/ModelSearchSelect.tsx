import React, { useState, useRef, useEffect, useMemo } from "react"

interface Props {
  value: string
  options: { value: string; label: string }[]
  onChange: (value: string) => void
  placeholder?: string
  id?: string
}

export function ModelSearchSelect({ value, options, onChange, placeholder, id }: Props) {
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState("")
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedLabel = useMemo(() => {
    const match = options.find((o) => o.value === value)
    return match ? match.label : value
  }, [value, options])

  const filtered = useMemo(() => {
    if (!input) return options
    const q = input.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q))
  }, [input, options])

  useEffect(() => {
    if (open) {
      setInput("")
      inputRef.current?.focus()
    }
  }, [open])

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  const select = (val: string) => {
    onChange(val)
    setOpen(false)
    setInput("")
  }

  return (
    <div ref={ref} className="model-search-select" style={{ position: "relative" }}>
      <input
        id={id}
        ref={inputRef}
        className="model-search-input"
        type="text"
        value={open ? input : selectedLabel}
        placeholder={placeholder || "Select model..."}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setInput(e.target.value); if (!open) setOpen(true) }}
        onKeyDown={(e) => {
          if (e.key === "Escape") { setOpen(false); (e.target as HTMLInputElement).blur() }
          if (e.key === "Enter" && filtered.length === 1) { select(filtered[0].value); e.preventDefault() }
        }}
      />
      {open && (
        <div className="model-search-dropdown">
          {filtered.length === 0 && <div className="model-search-empty">{input ? "No models match" : "No models available"}</div>}
          {filtered.map((o) => (
            <div
              key={o.value}
              className={`model-search-option${o.value === value ? " selected" : ""}`}
              onClick={() => select(o.value)}
              onMouseDown={(e) => e.preventDefault()}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}