import type { ModelRef } from "@shared/types"

export interface Suggestion {
  label: string // short text shown on the chip/card
  text: string // full prompt inserted into the composer on click
  desc?: string // optional longer description (tasker cards)
}

export type GenKind = "chat" | "cowork"

/**
 * Run a single prompt in a disposable sandbox session and return the assistant's
 * text. The sandbox is created, used, and deleted — it never enters the chat
 * registry, so it can't affect real chats. Throws on any failure so callers can
 * fall back to static content.
 */
async function oneShot(
  promptText: string,
  model: ModelRef | null,
  agent: string | null,
  overrideModel?: ModelRef | null,
): Promise<string> {
  const effective = overrideModel ?? model
  const { directory } = await window.mimo.createChatSandbox()
  try {
    const session = await window.mimo.createSession({ directory })
    await window.mimo.prompt({
      sessionID: session.id,
      text: promptText,
      model: effective ?? undefined,
      agent: agent ?? undefined,
      directory,
    })
    const messages = await window.mimo.getMessages(session.id, directory)
    let out = ""
    for (const m of messages) {
      if (m.info.role !== "assistant") continue
      for (const p of m.parts) {
        if ((p as { type?: string }).type === "text" && typeof (p as { text?: unknown }).text === "string") {
          out += (p as { text: string }).text
        }
      }
    }
    return out.trim()
  } finally {
    window.mimo.deleteSandbox(directory).catch(() => {})
  }
}

export async function generateGreeting(
  kind: GenKind,
  model: ModelRef | null,
  agent: string | null,
  overrideModel?: ModelRef | null,
): Promise<string> {
  const ctx = kind === "chat"
    ? "a user opening a new casual conversation"
    : "a user about to start a new agentic task that works inside a project folder"
  const tone = kind === "chat"
    ? "Casual, warm and chatty — like greeting a friend you haven't seen in a bit (e.g. \"Hey, how's it going?\", \"What's on your mind?\", \"Hey there! Ready to chat?\"). Keep it light and open-ended; no coding or work references, no corporate tone."
    : "Warm, lightly playful but focused, since the user is about to kick off real work."
  const raw = await oneShot(
    `You write UI microcopy. Produce ONE short greeting headline (max 8 words) for the home screen of Aria, an AI assistant, addressed to ${ctx}. Tone: ${tone} No quotes, no emoji, no preamble, no trailing punctuation beyond a single ? or .. Output only the headline.`,
    model,
    agent,
    overrideModel,
  )
  const line = raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)[0]
  const clean = (line ?? "").replace(/^["'`*]+|["'`*]+$/g, "").trim()
  if (!clean || clean.length > 64) throw new Error("greeting rejected")
  return clean
}

export async function generateSuggestions(
  kind: GenKind,
  model: ModelRef | null,
  agent: string | null,
  overrideModel?: ModelRef | null,
): Promise<Suggestion[]> {
  const ctx = kind === "chat"
    ? "a general-purpose AI assistant chat (not just coding — can talk about anything)"
    : "an agentic coding assistant that performs tasks inside a chosen project folder"
  const raw = await oneShot(
    `Produce exactly 4 home-screen suggestion chips for ${ctx}. The suggestions should be casual, fun, and varied — mix creative, helpful, curious, and everyday topics (e.g. brainstorming ideas, telling a story, planning something, answering a random question, getting advice). Avoid making all four coding-related. Respond with ONLY a JSON array (no markdown fences, no commentary): ` +
      `[{"label":"2 to 5 word button label","text":"the full prompt to insert into the input when the chip is clicked"}, ...]. ` +
      `Make the four varied and genuinely useful.`,
    model,
    agent,
    overrideModel,
  )
  const start = raw.indexOf("[")
  const end = raw.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) throw new Error("no json array")
  const arr = JSON.parse(raw.slice(start, end + 1)) as unknown
  const out: Suggestion[] = (Array.isArray(arr) ? arr : [])
    .map((x) => {
      const o = x as { label?: unknown; text?: unknown }
      return { label: String(o.label ?? "").trim(), text: String(o.text ?? "").trim() }
    })
    .filter((s) => s.label && s.text)
    .slice(0, 4)
    .map((s) => ({ ...s, desc: s.text }))
  if (out.length !== 4) throw new Error("suggestions rejected")
  return out
}
