/// <reference lib="webworker" />
// Local speech-to-text worker: ONNX Whisper via transformers.js.
//
// Runs entirely in this Web Worker so model load + inference never block the
// composer. The model (~80MB, onnx-community/whisper-base — multilingual, so
// Portuguese works) is downloaded once on first use and cached by the browser
// Cache API in the app partition. WebGPU when available, WASM fallback.
//
// Protocol: { id, samples: Float32Array (16kHz mono) } in,
//           { id, text } | { id, error } | { id, progress } out.

import { pipeline } from "@huggingface/transformers"

type AsrPipeline = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text?: string }>

// Model size ↔ accuracy/download tradeoff, user-selectable in Settings.
const MODELS: Record<string, string> = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
}

let loadedSize: string | null = null
let asrPromise: Promise<AsrPipeline> | null = null

function loadAsr(size: string, onProgress: (info: unknown) => void): Promise<AsrPipeline> {
  const model = MODELS[size] ?? MODELS.base
  if (loadedSize !== size) {
    // Size changed since last load — drop the cached pipeline and reload.
    asrPromise = null
    loadedSize = size
  }
  if (!asrPromise) {
    asrPromise = (async () => {
      const opts = { progress_callback: onProgress } as Record<string, unknown>
      try {
        return (await pipeline("automatic-speech-recognition", model, {
          ...opts,
          device: "webgpu",
        })) as unknown as AsrPipeline
      } catch {
        // No WebGPU (or adapter init failed) — quantized WASM still handles
        // short voice notes fine.
        return (await pipeline("automatic-speech-recognition", model, {
          ...opts,
          device: "wasm",
          dtype: "q8",
        })) as unknown as AsrPipeline
      }
    })().catch((err) => {
      asrPromise = null // allow retry after a failed download
      loadedSize = null
      throw err
    })
  }
  return asrPromise
}

self.onmessage = async (e: MessageEvent<{ id: number; samples: Float32Array; model?: string }>) => {
  const { id, samples, model } = e.data
  try {
    const asr = await loadAsr(model ?? "base", (p) => self.postMessage({ id, progress: p }))
    const out = await asr(samples, { chunk_length_s: 30, return_timestamps: false })
    self.postMessage({ id, text: (out?.text ?? "").trim() })
  } catch (err) {
    self.postMessage({ id, error: String((err as Error)?.message ?? err) })
  }
}
