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
  userName?: string
): Promise<string> {
  const name = userName?.trim() ? userName.trim() : "there"
  const assistantName = agent ?? "Aria"

  const prompt =
    kind === "chat"
      ? `Write a brief, warm, casual greeting for a chat session with ${assistantName}. 
Address the user as "${name}". 
Tone: friendly, relaxed, like greeting a friend. 
Keep it to 1-2 short sentences. 
No markdown, no formatting, no lists. 
Do not mention capabilities or offer help.`
      : `Write a brief, warm, focused greeting for a cowork/coding session with ${assistantName}. 
Address the user as "${name}". 
Tone: professional but approachable, ready to build. 
Keep it to 1-2 short sentences. 
No markdown, no formatting, no lists. 
Do not offer a menu of capabilities.`

  const raw = await oneShot(prompt, model, agent, overrideModel)
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
  const isChat = kind === "chat"
  const prompt = isChat
    ? `Produce exactly 4 home-screen suggestion chips for a general-purpose AI assistant chat (not just coding — can talk about anything). The suggestions should be casual, fun, and varied — mix creative, helpful, curious, and everyday topics (e.g. brainstorming ideas, telling a story, planning something, answering a random question, getting advice). Avoid making all four coding-related. Respond with ONLY a JSON array (no markdown fences, no commentary): ` +
      `[{"label":"2 to 5 word button label","text":"the full prompt to insert into the input when the chip is clicked"}, ...]. ` +
      `Make the four varied and genuinely useful.`
    : `Produce exactly 4 home-screen suggestion cards for an agentic coding assistant (Tasker mode) that performs tasks inside a chosen project folder. The suggestions should be building/coding focused: creating files, implementing features, debugging, refactoring, understanding code, setting up projects, writing tests, etc. Each should have a short label (2-5 words) and a longer description explaining the task. Respond with ONLY a JSON array (no markdown fences, no commentary): ` +
      `[{"label":"2 to 5 word button label","text":"the full prompt to insert into the input when the card is clicked","desc":"one sentence description of what this task does"}, ...]. ` +
      `Make the four varied and genuinely useful for a developer starting a coding session.`

  const raw = await oneShot(prompt, model, agent, overrideModel)
  const start = raw.indexOf("[")
  const end = raw.lastIndexOf("]")
  if (start === -1 || end === -1 || end < start) throw new Error("no json array")
  const arr = JSON.parse(raw.slice(start, end + 1)) as unknown
  const out: Suggestion[] = (Array.isArray(arr) ? arr : [])
    .map((x) => {
      const o = x as { label?: unknown; text?: unknown; desc?: unknown }
      return {
        label: String(o.label ?? "").trim(),
        text: String(o.text ?? "").trim(),
        desc: isChat ? String(o.text ?? "").trim() : String(o.desc ?? "").trim(),
      }
    })
    .filter((s) => s.label && s.text)
    .slice(0, 4)
  if (out.length !== 4) throw new Error("suggestions rejected")
  return out
}
