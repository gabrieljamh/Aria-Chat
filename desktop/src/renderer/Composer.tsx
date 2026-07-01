import React, { useEffect, useRef, useState } from "react"
import type { AgentInfo, CommandInfo, FileAttachment, ModelRef, ProvidersResponse, SkillInfo } from "@shared/types"
import { IconPlus, IconSend, IconMic, IconFile, IconSkill, IconPlug, IconGlobe, IconCheck, IconSettings } from "./Icons"
import { useCustomModels } from "./customModels"
import { ModelSearchSelect } from "./ModelSearchSelect"

interface ModelOption {
  providerID: string
  modelID: string
  label: string
}

function buildModelOptions(
  providers: ProvidersResponse | null,
  custom: { providerID: string; modelID: string; label: string }[],
): ModelOption[] {
  const out: ModelOption[] = []
  const seen = new Set<string>()
  const push = (o: ModelOption) => {
    const key = `${o.providerID}/${o.modelID}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(o)
  }
  if (providers) {
    const connected = new Set(providers.connected ?? [])
    for (const p of providers.all ?? []) {
      if (connected.size > 0 && !connected.has(p.id)) continue
      for (const m of Object.values(p.models ?? {})) {
        push({ providerID: p.id, modelID: m.id, label: `${p.name} · ${m.name}` })
      }
    }
  }
  for (const c of custom) push({ providerID: c.providerID, modelID: c.modelID, label: c.label || `${c.providerID} · ${c.modelID}` })
  return out
}

interface SlashItem {
  name: string
  description?: string
  type: "command" | "skill"
}

interface Props {
  placeholder?: string
  busy: boolean
  providers: ProvidersResponse | null
  agents: AgentInfo[]
  model: ModelRef | null
  onModelChange: (m: ModelRef) => void
  showMode?: boolean
  agentName: string | null
  onAgentChange?: (name: string) => void
  webSearch: boolean
  onWebSearchToggle: (v: boolean) => void
  onSend: (text: string, files?: FileAttachment[]) => void
  onAbort: () => void
  directory?: string | null
  // Bump `n` to push `text` into the textarea (used by suggestion chips).
  prefill?: { text: string; n: number }
  // Opens Settings on the Skills page (from the skills dropdown).
  onManageSkills?: () => void
  // Opens Settings on the Connectors page (from the connectors button).
  onManageConnectors?: () => void
  // Session-level actions served as client-side slash commands (not from the server).
  sessionID?: string | null
  onCompact?: () => void
  onClear?: () => void
}

export function Composer(props: Props) {
  const [text, setText] = useState("")
  const [interruptCount, setInterruptCount] = useState(0)
  const interruptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [slashItems, setSlashItems] = useState<SlashItem[]>([])
  const [skillsOpen, setSkillsOpen] = useState(false)
  const [skillList, setSkillList] = useState<SkillInfo[]>([])
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [attachments, setAttachments] = useState<FileAttachment[]>([])
  const [attachError, setAttachError] = useState<string | null>(null)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const dragCounterRef = useRef(0)
  const [recording, setRecording] = useState(false)
  const [recSeconds, setRecSeconds] = useState(0)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const recChunksRef = useRef<Blob[]>([])
  const recStreamRef = useRef<MediaStream | null>(null)
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const slashRef = useRef<HTMLDivElement>(null)
  const customModels = useCustomModels()

  const prefillN = props.prefill?.n ?? 0
  useEffect(() => {
    if (!prefillN) return
    setText(props.prefill?.text ?? "")
    const ta = taRef.current
    if (ta) {
      ta.focus()
      // move caret to end on next tick after the value applies
      requestAnimationFrame(() => ta.setSelectionRange(ta.value.length, ta.value.length))
    }
  }, [prefillN])

  useEffect(() => {
    return () => {
      if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!props.busy) setInterruptCount(0)
  }, [props.busy])

  const modelOptions = buildModelOptions(props.providers, customModels)

  const slashMatch = text.match(/(^|\n)\/(\S*)$/)
  const slashActive = slashMatch !== null
  const slashFilter = slashMatch ? slashMatch[2].toLowerCase() : ""

  const filteredItems = slashActive
    ? slashItems
        .filter((c) => c.name.toLowerCase().includes(slashFilter))
        .slice(0, 10)
    : []

  useEffect(() => {
    if (!slashActive) return
    const builtin: SlashItem[] = []
    if (props.sessionID && props.onCompact && props.model) {
      builtin.push({
        name: "compact",
        description: "Summarize this session to free up context",
        type: "command",
      })
    }
    if (props.onClear) {
      builtin.push({
        name: "clear",
        description: "Start a fresh session",
        type: "command",
      })
    }
    Promise.all([
      window.mimo.getCommands(props.directory ?? undefined).catch(() => [] as CommandInfo[]),
      window.mimo.getSkills(props.directory ?? undefined).catch(() => [] as SkillInfo[]),
    ]).then(([cmds, skills]) => {
      const items: SlashItem[] = [
        ...builtin,
        ...cmds.map((c) => ({ name: c.name, description: c.description, type: "command" as const })),
        ...skills
          .filter((s) => !s.hidden)
          .map((s) => ({ name: s.name, description: s.description, type: "skill" as const })),
      ]
      setSlashItems(items)
    })
  }, [slashActive, props.directory, props.sessionID, props.onCompact, props.onClear, props.model])

  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = "auto"
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px"
  }, [text])

  useEffect(() => {
    if (!menuOpen && !skillsOpen) return
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setSkillsOpen(false)
      }
    }
    document.addEventListener("mousedown", onClick)
    return () => document.removeEventListener("mousedown", onClick)
  }, [menuOpen, skillsOpen])

  // Lazily load installed skills when the Skills dropdown opens.
  useEffect(() => {
    if (!skillsOpen) return
    setSkillsLoading(true)
    window.mimo
      .getSkills(props.directory ?? undefined)
      .then((list) => setSkillList(list.filter((sk) => !sk.hidden)))
      .catch(() => setSkillList([]))
      .finally(() => setSkillsLoading(false))
  }, [skillsOpen, props.directory])

  useEffect(
    () => () => {
      if (recTimerRef.current) clearInterval(recTimerRef.current)
      recStreamRef.current?.getTracks().forEach((t) => t.stop())
    },
    [],
  )

  // Insert text at the caret (used by the Skills submenu).
  const insertAtCursor = (snippet: string) => {
    const ta = taRef.current
    const pos = ta ? ta.selectionStart : text.length
    const before = text.slice(0, pos)
    const lead = before.length > 0 && !/\s$/.test(before) ? " " : ""
    const piece = lead + snippet
    const next = before + piece + text.slice(pos)
    setText(next)
    requestAnimationFrame(() => {
      if (ta) {
        ta.focus()
        const caret = pos + piece.length
        ta.setSelectionRange(caret, caret)
      }
    })
  }

  const addFiles = async () => {
    setMenuOpen(false)
    setAttachError(null)
    const picked = await window.mimo.pickAttachments().catch(() => [])
    const ok = picked.filter((p) => !p.error && p.url)
    const bad = picked.filter((p) => p.error)
    if (ok.length) {
      setAttachments((a) => [...a, ...ok.map((p) => ({ filename: p.filename, mime: p.mime, url: p.url }))])
    }
    if (bad.length) setAttachError(bad.map((b) => `${b.filename}: ${b.error}`).join("  ·  "))
  }

  const removeAttachment = (idx: number) => setAttachments((a) => a.filter((_, i) => i !== idx))

  const blobToDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(r.result as string)
      r.onerror = () => reject(new Error("read failed"))
      r.readAsDataURL(blob)
    })

  const stopRecording = () => {
    if (recTimerRef.current) {
      clearInterval(recTimerRef.current)
      recTimerRef.current = null
    }
    setRecording(false)
    mediaRecorderRef.current?.stop()
  }

  const startRecording = async () => {
    setAttachError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recStreamRef.current = stream
      recChunksRef.current = []
      const preferred = ["audio/webm", "audio/ogg", "audio/mp4"].find((m) => MediaRecorder.isTypeSupported(m))
      const mr = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      mediaRecorderRef.current = mr
      mr.ondataavailable = (e) => {
        if (e.data.size) recChunksRef.current.push(e.data)
      }
      mr.onstop = async () => {
        const type = (mr.mimeType || "audio/webm").split(";")[0]
        const blob = new Blob(recChunksRef.current, { type })
        recStreamRef.current?.getTracks().forEach((t) => t.stop())
        recStreamRef.current = null
        if (!blob.size) return
        try {
          const url = await blobToDataUrl(blob)
          const ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"
          setAttachments((a) => [...a, { filename: `recording-${Date.now()}.${ext}`, mime: type, url }])
        } catch {
          setAttachError("Could not process the recording.")
        }
      }
      mr.start()
      setRecording(true)
      setRecSeconds(0)
      recTimerRef.current = setInterval(() => setRecSeconds((sec) => sec + 1), 1000)
    } catch (e: any) {
      setAttachError("Microphone unavailable: " + String(e?.message ?? e))
    }
  }

  const toggleRecord = () => (recording ? stopRecording() : startRecording())

  const fileToAttachment = (file: File) =>
    new Promise<FileAttachment>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve({ filename: file.name, mime: file.type || "application/octet-stream", url: r.result as string })
      r.onerror = () => reject(new Error("read failed"))
      r.readAsDataURL(file)
    })

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }

  const onDragEnter = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current++
    setDragOver(true)
  }

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) setDragOver(false)
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    dragCounterRef.current = 0
    setAttachError(null)
    const files = Array.from(e.dataTransfer.files ?? [])
    const results = await Promise.allSettled(files.map(fileToAttachment))
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<FileAttachment>).value)
    const bad = results.filter((r) => r.status === "rejected")
    if (ok.length) setAttachments((a) => [...a, ...ok])
    if (bad.length) setAttachError(`${bad.length} file(s) could not be read.`)
  }

  const send = () => {
    const t = text.trim()
    if ((!t && attachments.length === 0) || props.busy) return
    props.onSend(t, attachments.length ? attachments : undefined)
    setText("")
    setAttachments([])
    setAttachError(null)
  }

  const acceptItem = (item: SlashItem) => {
    const s = taRef.current!.selectionStart
    const beforeCursor = text.slice(0, s)
    const afterCursor = text.slice(s)
    const idx = beforeCursor.lastIndexOf("/")
    if (idx === -1) return
    if (item.name === "compact") {
      setText(beforeCursor.slice(0, idx))
      props.onCompact?.()
      return
    }
    if (item.name === "clear") {
      setText(beforeCursor.slice(0, idx))
      props.onClear?.()
      return
    }
    if (item.type === "skill") {
      setText(beforeCursor.slice(0, idx) + "Use the " + item.name + " skill: " + afterCursor)
    } else {
      setText(beforeCursor.slice(0, idx) + "/" + item.name + " " + afterCursor)
    }
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items ?? [])
    const fileItems = items.filter((it) => it.kind === "file" && it.type)
    if (!fileItems.length) return
    e.preventDefault()
    setAttachError(null)
    const files: File[] = []
    for (const it of fileItems) {
      const f = it.getAsFile()
      if (f) files.push(f)
    }
    const results = await Promise.allSettled(files.map(fileToAttachment))
    const ok = results.filter((r) => r.status === "fulfilled").map((r) => (r as PromiseFulfilledResult<FileAttachment>).value)
    const bad = results.filter((r) => r.status === "rejected")
    if (ok.length) setAttachments((a) => [...a, ...ok])
    if (bad.length) setAttachError(`${bad.length} pasted file(s) could not be read.`)
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      if (slashActive) {
        setText(text.slice(0, text.lastIndexOf("/")) + slashFilter)
        return
      }
      if (props.busy) {
        if (interruptTimerRef.current) clearTimeout(interruptTimerRef.current)
        const next = interruptCount + 1
        setInterruptCount(next)
        interruptTimerRef.current = setTimeout(() => setInterruptCount(0), 5000)
        if (next >= 2) {
          props.onAbort()
          setInterruptCount(0)
        }
      }
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      if (props.busy) return
      if (slashActive && filteredItems.length > 0) {
        e.preventDefault()
        acceptItem(filteredItems[0])
        return
      }
      e.preventDefault()
      send()
    }
    if (e.key === "Tab" && slashActive && filteredItems.length > 0) {
      e.preventDefault()
      acceptItem(filteredItems[0])
    }
  }

  const primaryAgents = props.agents.filter((a) => a.mode === "primary" || a.mode === "all")

  const composerClass = "composer" + (dragOver ? " drag-over" : "")

  return (
    <div className={composerClass} onDragOver={onDragOver} onDragEnter={onDragEnter} onDragLeave={onDragLeave} onDrop={onDrop}>
      {(attachments.length > 0 || attachError) && (
        <div className="composer-attachments">
          {attachments.map((a, i) => {
            const isImage = a.mime.startsWith("image/")
            return (
              <span className={"attach-chip" + (isImage ? " attach-chip-img" : "")} key={a.filename + i} title={a.filename}>
                {isImage ? (
                  <img
                    className="attach-thumb"
                    src={a.url}
                    alt={a.filename}
                    onClick={() => setPreviewUrl(a.url)}
                  />
                ) : (
                  <IconFile size={13} />
                )}
                <span className="attach-name">{a.filename}</span>
                <button className="attach-remove" title="Remove" onClick={() => removeAttachment(i)}>
                  ×
                </button>
              </span>
            )
          })}
          {attachError && <span className="attach-error">{attachError}</span>}
        </div>
      )}
      {previewUrl && (
        <div className="attach-preview-overlay" onClick={() => setPreviewUrl(null)}>
          <div className="attach-preview-box">
            <img src={previewUrl} alt="preview" className="attach-preview-img" />
            <button className="attach-preview-close" onClick={() => setPreviewUrl(null)}>×</button>
          </div>
        </div>
      )}
      <textarea
        ref={taRef}
        rows={1}
        placeholder={props.placeholder ?? "How can I help you today?"}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      {slashActive && filteredItems.length > 0 && (
        <div className="slash-pop" ref={slashRef}>
          {filteredItems.map((item) => (
            <button
              key={item.name + item.type}
              className="slash-item"
              onClick={() => acceptItem(item)}
            >
              <span className="slash-name">/{item.name}</span>
              {item.description && <span className="slash-desc">{item.description}</span>}
              <span className={"slash-tag " + item.type}>{item.type}</span>
            </button>
          ))}
        </div>
      )}
      <div className="composer-footer">
        <div className="menu" ref={menuRef}>
          <button className="foot-btn round" title="Add" onClick={() => setMenuOpen((o) => !o)}>
            <IconPlus size={18} />
          </button>
          {menuOpen && (
            <div className="menu-pop">
              <button className="menu-row" onClick={addFiles}>
                <IconFile size={16} />
                <span>
                  Add files<div className="desc">Attach files from your computer</div>
                </span>
              </button>
              <button className="menu-row" onClick={() => { setMenuOpen(false); setSkillsOpen(true) }}>
                <IconSkill size={16} />
                <span>
                  Skills<div className="desc">Insert a skill's slash command</div>
                </span>
              </button>
              <button className="menu-row" onClick={() => { setMenuOpen(false); props.onManageConnectors?.() }}>
                <IconPlug size={16} />
                <span>
                  Connectors<div className="desc">MCP tools & integrations</div>
                </span>
              </button>
              <button
                className="menu-row"
                onClick={() => {
                  props.onWebSearchToggle(!props.webSearch)
                }}
              >
                <IconGlobe size={16} />
                <span>
                  Web search<div className="desc">Let the model browse the web</div>
                </span>
                <span className={"toggle" + (props.webSearch ? " on" : "")}>
                  <span className="knob" />
                </span>
              </button>
            </div>
          )}
          {skillsOpen && (
            <div className="menu-pop skills-pop">
              <button
                className="skills-pop-back"
                onClick={() => { setSkillsOpen(false); setMenuOpen(true) }}
              >
                <span className="skills-pop-back-arrow">‹</span> Skills
              </button>
              <div className="skills-pop-list">
                {skillsLoading ? (
                  <div className="menu-sub-empty">Loading…</div>
                ) : skillList.length === 0 ? (
                  <div className="menu-sub-empty">No skills installed.</div>
                ) : (
                  skillList.map((sk) => (
                    <button
                      key={sk.name}
                      className="skills-pop-row"
                      title={sk.description || sk.name}
                      onClick={() => { insertAtCursor(`/${sk.name} `); setSkillsOpen(false) }}
                    >
                      {sk.name}
                    </button>
                  ))
                )}
              </div>
              <button
                className="skills-pop-manage"
                onClick={() => { setSkillsOpen(false); props.onManageSkills?.() }}
              >
                <IconSettings size={14} /> Manage skills
              </button>
            </div>
          )}
        </div>

        {props.webSearch && (
          <span className="foot-btn" title="Web search on">
            <IconCheck size={14} /> Web
          </span>
        )}

        <div className="spacer" />

        {props.showMode && primaryAgents.length > 0 && (
          <select
            className="select"
            value={props.agentName ?? ""}
            onChange={(e) => props.onAgentChange?.(e.target.value)}
            title="Autonomy / mode"
          >
            {primaryAgents.map((a) => (
              <option key={a.name} value={a.name}>
                {modeLabel(a.name)}
              </option>
            ))}
          </select>
        )}

        {modelOptions.length > 0 && (
          <div className="model-search-select-wrapper" style={{ display: "inline-block", verticalAlign: "middle" }}>
            <ModelSearchSelect
              value={props.model ? `${props.model.providerID}/${props.model.modelID}` : ""}
              options={modelOptions.map((o) => ({ value: `${o.providerID}/${o.modelID}`, label: o.label }))}
              onChange={(v) => {
                const [providerID, ...rest] = v.split("/")
                props.onModelChange({ providerID, modelID: rest.join("/") })
              }}
              placeholder="Model"
            />
          </div>
        )}

        {recording && <span className="rec-timer">{formatDuration(recSeconds)}</span>}
        <button
          className={"foot-btn round" + (recording ? " recording" : "")}
          title={recording ? "Stop recording" : "Record audio"}
          onClick={toggleRecord}
        >
          {recording ? <span className="rec-dot" /> : <IconMic size={16} />}
        </button>

        {props.busy ? (
          <button className="send-btn" title={interruptCount > 0 ? "Esc again to interrupt" : "Esc to interrupt"} onClick={props.onAbort} style={{ background: "var(--danger)" }}>
            <span style={{ width: 11, height: 11, background: "#fff", borderRadius: 2, display: "block" }} />
          </button>
        ) : (
          <button className="send-btn" title="Send" disabled={!text.trim() && attachments.length === 0} onClick={send}>
            <IconSend size={16} />
          </button>
        )}
      </div>
    </div>
  )
}

function formatDuration(total: number): string {
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${sec.toString().padStart(2, "0")}`
}

function modeLabel(name: string): string {
  const map: Record<string, string> = {
    build: "Agent",
    plan: "Plan",
    yolo: "Yolo",
    general: "Agent",
  }
  return map[name] ?? name.charAt(0).toUpperCase() + name.slice(1)
}