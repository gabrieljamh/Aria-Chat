// Local speech-to-text: renderer-side API around stt-worker.ts.
//
// decode (AudioContext — main thread only, workers have no audio APIs) →
// resample to Whisper's canonical 16kHz mono → transcribe in the worker →
// classify against Whisper's known non-speech failure modes.

export interface SttOutcome {
  status: "ok" | "no-speech"
  text: string
  duration: number
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./stt-worker.ts", import.meta.url), { type: "module" })
    worker.onmessage = (e: MessageEvent<{ id: number; text?: string; error?: string; progress?: unknown }>) => {
      const { id, text, error, progress } = e.data
      if (progress !== undefined) return // model download progress — ignored here
      const entry = pending.get(id)
      if (!entry) return
      pending.delete(id)
      if (error !== undefined) entry.reject(new Error(error))
      else entry.resolve(text ?? "")
    }
    worker.onerror = () => {
      for (const [, entry] of pending) entry.reject(new Error("transcription worker crashed"))
      pending.clear()
      worker?.terminate()
      worker = null
    }
  }
  return worker
}

/** Decode any browser-supported audio (wav/mp3/ogg/m4a/webm) to 16kHz mono. */
async function decodeTo16kMono(buf: ArrayBuffer): Promise<{ samples: Float32Array; duration: number }> {
  const probe = new AudioContext()
  const decoded = await probe.decodeAudioData(buf).finally(() => probe.close())
  const rate = 16000
  const offline = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate)
  const src = offline.createBufferSource()
  src.buffer = decoded
  src.connect(offline.destination)
  src.start()
  const rendered = await offline.startRendering()
  return { samples: rendered.getChannelData(0), duration: decoded.duration }
}

/**
 * Whisper hallucination guard. Trained on subtitled media, Whisper responds
 * to music/ambient audio with lyric fragments, "♪" markers, looped phrases,
 * or ghost captions ("Thanks for watching!"). Signatures checked:
 * marker-dominated output, implausibly low word rate for the duration, and
 * heavy n-gram repetition.
 */
export function looksLikeNoSpeech(text: string, duration: number): boolean {
  const t = text.trim()
  if (!t) return true
  const words = t.split(/\s+/).filter(Boolean)
  const markers = (t.match(/[♪♫]|\[(?:music|applause|laughter|silence)\]|\((?:music|instrumental|applause)\)/gi) ?? [])
    .length
  if (markers >= 1 && words.length <= markers * 4) return true
  if (duration >= 5 && words.length / duration < 0.3) return true
  if (words.length >= 12) {
    const tri = new Map<string, number>()
    for (let i = 0; i + 2 < words.length; i++) {
      const k = (words[i] + " " + words[i + 1] + " " + words[i + 2]).toLowerCase()
      tri.set(k, (tri.get(k) ?? 0) + 1)
    }
    let max = 0
    for (const n of tri.values()) if (n > max) max = n
    if (max / (words.length - 2) > 0.3) return true
  }
  return false
}

export type SttModelSize = "tiny" | "base" | "small"

/** Transcribe an audio attachment (any decodable container). */
export async function transcribeAudio(buf: ArrayBuffer, model: SttModelSize = "base"): Promise<SttOutcome> {
  const { samples, duration } = await decodeTo16kMono(buf)
  const id = ++seq
  const text = await new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    // Copy: getChannelData's buffer belongs to the rendered AudioBuffer.
    const copy = new Float32Array(samples)
    getWorker().postMessage({ id, samples: copy, model }, [copy.buffer])
  })
  return looksLikeNoSpeech(text, duration) ? { status: "no-speech", text, duration } : { status: "ok", text, duration }
}
