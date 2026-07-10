import React, { useEffect, useRef, useState } from "react"
import type { AgentInfo, CommandInfo, FileAttachment, ModelRef, ProvidersResponse, SkillInfo } from "@shared/types"
import { IconPlus, IconSend, IconMic, IconFile, IconSkill, IconPlug, IconGlobe, IconCheck, IconSettings } from "./Icons"
import { useCustomModels } from "./customModels"
import { ModelSearchSelect } from "./ModelSearchSelect"
import { buildModelOptions } from "./modelOptions"

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
  // Local STT (Whisper): per-attachment transcript state, keyed by filename.
  // Mic recordings auto-transcribe when the setting is on; audio FILES get a
  // manual button (people attach music as music — auto-transcribing it would
  // mostly exercise Whisper's hallucination modes).
  const [transcripts, setTranscripts] = useState<
    Record<string, { status: "working" | "done" | "no-speech" | "error"; text?: string }>
  >({})
  const [sttEnabled, setSttEnabled] = useState(false)
  useEffect(() => {
    window.mimo.getSetting("sttEnabled").then((v) => setSttEnabled(v === true)).catch(() => {})
  }, [])

  const runTranscription = async (filename: string, data: Blob | ArrayBuffer) => {
    setTranscripts((t) => ({ ...t, [filename]: { status: "working" } }))
    try {
      const buf = data instanceof Blob ? await data.arrayBuffer() : data
      const { transcribeAudio } = await import("./stt")
      const size = await window.mimo.getSetting("sttModel").catch(() => null)
      const model = size === "tiny" || size === "small" ? size : "base"
      const out = await transcribeAudio(buf, model)
      setTranscripts((t) => ({
        ...t,
        [filename]: out.status === "ok" ? { status: "done", text: out.text } : { status: "no-speech", text: out.text },
      }))
    } catch {
      setTranscripts((t) => ({ ...t, [filename]: { status: "error" } }))
    }
  }
  // Duration mirror readable from the MediaRecorder onstop closure (state
  // there would be stale) — gates the WAV re-encode for very long takes.
  const recSecondsRef = useRef(0)
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
    if (bad.length) setAttachError(bad.map((b) => `${b.filename}: ${b.error}`).join("  Â·  "))
  }

  const removeAttachment = (idx: number) =>
    setAttachments((a) => {
      const removed = a[idx]
      if (removed) {
        setTranscripts((t) => {
          const { [removed.filename]: _, ...rest } = t
          return rest
        })
      }
      return a.filter((_, i) => i !== idx)
    })

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

  // Re-encode a recording to 16kHz mono 16-bit PCM WAV — the most universally
  // accepted format for speech/ASR-capable models (webm/opus support is
  // spotty). 16kHz mono is the standard ASR rate, keeping size reasonable
  // (~1.9MB/min).
  const blobToWav = async (blob: Blob): Promise<Blob> => {
    const raw = await blob.arrayBuffer()
    const probe = new AudioContext()
    const decoded = await probe.decodeAudioData(raw).finally(() => probe.close())
    const rate = 16000
    const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
    const src = offline.createBufferSource()
    src.buffer = decoded // multi-channel input downmixes into the mono destination
    src.connect(offline.destination)
    src.start()
    const rendered = await offline.startRendering()
    const samples = rendered.getChannelData(0)
    const buf = new ArrayBuffer(44 + samples.length * 2)
    const view = new DataView(buf)
    const writeStr = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i))
    }
    writeStr(0, "RIFF")
    view.setUint32(4, 36 + samples.length * 2, true)
    writeStr(8, "WAVE")
    writeStr(12, "fmt ")
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, 1, true) // mono
    view.setUint32(24, rate, true)
    view.setUint32(28, rate * 2, true) // byte rate
    view.setUint16(32, 2, true) // block align
    view.setUint16(34, 16, true) // bits per sample
    writeStr(36, "data")
    view.setUint32(40, samples.length * 2, true)
    let o = 44
    for (let i = 0; i < samples.length; i++, o += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]))
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
    }
    return new Blob([buf], { type: "audio/wav" })
  }

  const startRecording = async () => {
    setAttachError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      recStreamRef.current = stream
      recChunksRef.current = []
      // codecs=opus variants probe more reliably on Chromium than bare types.
      const preferred = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"].find(
        (m) => MediaRecorder.isTypeSupported(m),
      )
      const mr = new MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined)
      mediaRecorderRef.current = mr
      mr.ondataavailable = (e) => {
        if (e.data.size) recChunksRef.current.push(e.data)
      }
      mr.onstop = async () => {
        // Chromium quirk: an audio-only MediaRecorder can still report a
        // "video/webm" container. Never let a video/* mime escape — it broke
        // the audio-model redirect (audio/* check), server modality routing,
        // and confused audio-capable models into treating speech as video.
        const container = (mr.mimeType || "audio/webm").split(";")[0]
        const type = container.startsWith("video/") ? container.replace(/^video\//, "audio/") : container
        const blob = new Blob(recChunksRef.current, { type })
        recStreamRef.current?.getTracks().forEach((t) => t.stop())
        recStreamRef.current = null
        if (!blob.size) return
        try {
          // Prefer WAV for maximum model compatibility; keep the compact
          // original for very long recordings (WAV ≈ 1.9MB/min) or if
          // decoding fails.
          let outBlob = blob
          let mime = type
          let ext = type.includes("ogg") ? "ogg" : type.includes("mp4") ? "m4a" : "webm"
          if (recSecondsRef.current <= 600) {
            try {
              outBlob = await blobToWav(blob)
              mime = "audio/wav"
              ext = "wav"
            } catch {
              /* keep original container */
            }
          }
          const url = await blobToDataUrl(outBlob)
          const filename = `recording-${Date.now()}.${ext}`
          setAttachments((a) => [...a, { filename, mime, url }])
          // Mic capture = speech intent — auto-transcribe when enabled. The
          // transcript shows on the chip before send, so garbage is catchable.
          const stt = await window.mimo.getSetting("sttEnabled").catch(() => null)
          if (stt === true) void runTranscription(filename, outBlob)
        } catch {
          setAttachError("Could not process the recording.")
        }
      }
      mr.start()
      setRecording(true)
      setRecSeconds(0)
      recSecondsRef.current = 0
      recTimerRef.current = setInterval(() => {
        recSecondsRef.current += 1
        setRecSeconds((sec) => sec + 1)
      }, 1000)
    } catch (e: any) {
      setAttachError("Microphone unavailable: " + String(e?.message ?? e))
    }
  }

  const toggleRecord = () => (recording ? stopRecording() : startRecording())

  // Extension-based MIME fallback for drag-drop/paste, mirroring the ATTACH_MIME
  // table in ipc.ts. Browsers return "" for many text extensions (.md, .ts, etc.).
  const EXT_MIME: Record<string, string> = {
    ".md": "text/plain", ".markdown": "text/plain", ".txt": "text/plain", ".log": "text/plain",
    ".yml": "text/plain", ".yaml": "text/plain", ".toml": "text/plain", ".ini": "text/plain",
    ".ts": "text/plain", ".tsx": "text/plain", ".js": "text/plain", ".jsx": "text/plain",
    ".mjs": "text/plain", ".cjs": "text/plain", ".py": "text/plain", ".go": "text/plain",
    ".rs": "text/plain", ".java": "text/plain", ".c": "text/plain", ".h": "text/plain",
    ".cpp": "text/plain", ".cs": "text/plain", ".rb": "text/plain", ".php": "text/plain",
    ".sh": "text/plain", ".css": "text/plain", ".scss": "text/plain", ".sql": "text/plain",
    ".json": "application/json", ".csv": "text/csv", ".html": "text/html", ".htm": "text/html",
    ".xml": "text/xml", ".pdf": "application/pdf",
    // Audio/video: browsers report empty File.type for several of these
    // (.m4a/.opus especially); without a fallback they became
    // application/octet-stream and the server rejected them.
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".ogg": "audio/ogg",
    ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac", ".aac": "audio/aac",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".m4v": "video/mp4",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".bmp": "image/bmp", ".svg": "image/svg+xml",
    ".zip": "application/zip", ".tar": "application/x-tar",
    ".tgz": "application/gzip", ".gz": "application/gzip",
    ".7z": "application/x-7z-compressed", ".rar": "application/x-rar-compressed",
  }

  // Same per-file ceiling as the native picker (ipc.ts pick-attachments).
  // Drag/paste had NO cap — a dropped multi-GB video would balloon into a
  // base64 data URL in renderer memory before anything could refuse it.
  const MAX_ATTACH_BYTES = 25 * 1024 * 1024

  const fileToAttachment = (file: File) =>
    new Promise<FileAttachment>((resolve, reject) => {
      if (file.size > MAX_ATTACH_BYTES) {
        reject(new Error(`"${file.name}" is larger than 25 MB`))
        return
      }
      const r = new FileReader()
      const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      r.onload = () => resolve({ filename: file.name, mime: file.type || EXT_MIME[ext] || "application/octet-stream", url: r.result as string })
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
    // Inject local STT results as text so every model (audio-capable or not)
    // gets the speech content; the audio attachment still rides along for
    // models that can genuinely listen.
    const transcriptBlocks = attachments
      .map((a) => {
        const tr = transcripts[a.filename]
        if (!tr) return null
        if (tr.status === "done" && tr.text) return `[Transcript of ${a.filename}]: ${tr.text}`
        if (tr.status === "no-speech")
          return `[No clear speech detected in ${a.filename} — may be music or ambient audio]`
        return null
      })
      .filter((b): b is string => b !== null)
    const finalText = [t, ...transcriptBlocks].filter(Boolean).join("\n\n")
    props.onSend(finalText, attachments.length ? attachments : undefined)
    setText("")
    setAttachments([])
    setTranscripts({})
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

  // Pastes larger than this become a text attachment instead of inline text.
  // Big inline pastes (logs, JSON dumps) wreck the composer, break the message
  // bubble's markdown when they contain ``` fences, and blow up the model
  // request — as an attachment they flow through the server's inline/spill
  // logic (small → inlined verbatim, huge → temp file + read-tool hint).
  const PASTE_ATTACH_THRESHOLD = 6_000

  const textToAttachment = (text: string): FileAttachment => {
    let isJson = false
    try {
      JSON.parse(text)
      isJson = true
    } catch {
      /* plain text */
    }
    const bytes = new TextEncoder().encode(text)
    let bin = ""
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)))
    }
    const b64 = window.btoa(bin)
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, "")
    return {
      filename: `pasted-${stamp}.${isJson ? "json" : "txt"}`,
      mime: isJson ? "application/json" : "text/plain",
      url: `data:${isJson ? "application/json" : "text/plain"};base64,${b64}`,
    }
  }

  const onPaste = async (e: React.ClipboardEvent) => {
    const items = Array.from(e.clipboardData.items ?? [])
    const fileItems = items.filter((it) => it.kind === "file" && it.type)
    if (!fileItems.length) {
      const pasted = e.clipboardData.getData("text/plain")
      if (pasted && pasted.length > PASTE_ATTACH_THRESHOLD) {
        e.preventDefault()
        try {
          setAttachments((a) => [...a, textToAttachment(pasted)])
        } catch {
          // btoa/encoding hiccup — fall back to a plain inline paste.
          setText((t) => t + pasted)
        }
      }
      return
    }
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
            const isAudio = a.mime.startsWith("audio/")
            const tr = transcripts[a.filename]
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
                {isAudio && tr?.status === "working" && <span className="attach-stt working">transcribing…</span>}
                {isAudio && tr?.status === "done" && (
                  <span className="attach-stt done" title={tr.text}>✓ transcript</span>
                )}
                {isAudio && tr?.status === "no-speech" && (
                  <span className="attach-stt nospeech" title={tr.text || "No clear speech detected"}>♪ no speech</span>
                )}
                {isAudio && tr?.status === "error" && <span className="attach-stt error">transcription failed</span>}
                {isAudio && !tr && sttEnabled && (
                  <button
                    className="attach-stt-btn"
                    title="Transcribe locally (Whisper)"
                    onClick={async () => {
                      try {
                        const buf = await (await fetch(a.url)).arrayBuffer()
                        void runTranscription(a.filename, buf)
                      } catch {
                        setTranscripts((t) => ({ ...t, [a.filename]: { status: "error" } }))
                      }
                    }}
                  >
                    Transcribe
                  </button>
                )}
                <button className="attach-remove" title="Remove" onClick={() => removeAttachment(i)}>
                  {"×"}
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
            <button className="attach-preview-close" onClick={() => setPreviewUrl(null)}>{"×"}</button>
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
                <span className="skills-pop-back-arrow">â€¹</span> Skills
              </button>
              <div className="skills-pop-list">
                {skillsLoading ? (
                  <div className="menu-sub-empty">Loadingâ€¦</div>
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

        {props.showMode && primaryAgents.filter((a) => a.name !== "webagent").length > 0 && (
          <select
            className="select"
            value={props.agentName ?? ""}
            onChange={(e) => props.onAgentChange?.(e.target.value)}
            // Lock the mode selector mid-turn — same guard as the interrupt
            // button. Switching agents while the server is running a turn would
            // race the server-driven agent sync (plan_enter/plan_exit) and could
            // land the wrong mode; force an abort first.
            disabled={props.busy}
            title={props.busy ? "Stop the current turn to change mode" : "Autonomy / mode"}
            style={props.busy ? { opacity: 0.5, cursor: "not-allowed" } : undefined}
          >
            {primaryAgents.filter((a) => a.name !== "webagent").map((a) => (
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