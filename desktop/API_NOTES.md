# MiMo Code server API — findings

This documents the real server contract used by the `desktop/` app. Everything
below was read from the repo (not invented): the route source under
`packages/opencode/src/server/` and the generated SDK types under
`packages/sdk/js/src/gen/types.gen.ts` / `sdk.gen.ts`.

## Starting the server

The headless server is the `serve` CLI command
(`packages/opencode/src/cli/cmd/serve.ts`). In this monorepo it is run via Bun:

```
bun run --conditions=browser packages/opencode/src/index.ts serve --hostname 127.0.0.1 --port 4096
```

(If the `opencode` / `mimocode` binary is installed on PATH, `opencode serve
--hostname 127.0.0.1 --port 4096` is equivalent — that is what the JS SDK's
`createOpencodeServer` spawns.)

Network options (`packages/opencode/src/cli/network.ts`):
- `--port` (default `0` = random free port; config `server.port` can override)
- `--hostname` (default `127.0.0.1`)
- `--no-auth`, `--mdns`, `--cors <domain>` (repeatable)

On startup it prints exactly:

```
mimocode server listening on http://<hostname>:<port>
```

The desktop main process spawns the process, scans stdout for that line, and
parses the URL (regex `on\s+(https?:\/\/[^\s]+)`). Auth: on a loopback host the
server runs without a password (prints a warning only), so the desktop attaches
with no credentials. A non-loopback bind requires `MIMOCODE_SERVER_PASSWORD`.

Health check: `GET /global/health` returns `200 OK` once ready.

## Base URL & transport

- Base URL: `http://127.0.0.1:<port>` (single local instance / loopback).
- REST is JSON over HTTP. Streaming is Server-Sent Events (`text/event-stream`).
- The HTTP/SSE client lives in the **Electron main process** (Node `fetch`), so
  browser CORS does not apply. CORS middleware only matters for the renderer,
  which never talks to the server directly.

## SSE event stream

`GET /event` (instance event stream — `routes/instance/event.ts`). The body is a
sequence of SSE `data:` lines, each a JSON object `{ type, properties }`.

First event on connect is `{ "type": "server.connected", "properties": {} }`,
and a `{ "type": "server.heartbeat" }` is sent every 10s.

Event types relevant to the UI (from `types.gen.ts`):

| Event type             | properties                                   | Used for |
|------------------------|----------------------------------------------|----------|
| `server.connected`     | `{}`                                          | connection ready |
| `server.heartbeat`     | `{}`                                          | keepalive (ignored) |
| `message.updated`      | `{ info: Message }`                           | new/updated message envelope |
| `message.removed`      | `{ sessionID, messageID }`                    | remove message |
| `message.part.updated` | `{ part: Part, delta?: string }`              | **streaming tokens / tool calls** |
| `message.part.removed` | `{ sessionID, messageID, partID }`            | remove part |
| `permission.updated`   | `Permission`                                  | **approval request** |
| `permission.replied`   | `{ sessionID, permissionID, response }`       | approval resolved |
| `todo.updated`         | `{ sessionID, todos: Todo[] }`                | **Tasker Progress checklist** |
| `file.edited`          | `{ file: string }`                            | **Tasker workspace file tree** |
| `session.idle`         | `{ sessionID }`                               | turn finished |
| `session.updated`      | `{ info: Session }`                           | session metadata |
| `session.error`        | `{ sessionID?, error }`                       | error surface |
| `session.status`       | `{ sessionID, status }`                       | busy/idle/retry |

### `Part` union (`message.part.updated`)

`Part = TextPart | ReasoningPart | FilePart | ToolPart | StepStartPart |
StepFinishPart | SnapshotPart | PatchPart | AgentPart | RetryPart |
CompactionPart`. Each part carries `id, sessionID, messageID, type`.

- `TextPart`  — `{ type:"text", text }`. With `message.part.updated.delta`, the
  delta is the newly appended text (token streaming); `part.text` is cumulative.
- `ReasoningPart` — `{ type:"reasoning", text }` (thinking).
- `ToolPart` — `{ type:"tool", callID, tool, state }` where
  `state.status ∈ pending | running | completed | error`. Running/completed
  carry `input`, optional `title`, `metadata`, `time`; completed has `output`.
- `FilePart` — `{ type:"file", mime, url, filename? }`.

## Permissions / approvals

`permission.updated` payload (`Permission`):
```
{ id, type, pattern?, sessionID, messageID, callID?, title, metadata, time:{created} }
```
Reply: `POST /session/{id}/permissions/{permissionID}` with body
`{ "reply": "once" | "always" | "reject" }` → maps to **Approve once / Always /
Deny**. (`Permission.Reply = ["once","always","reject"]`,
`permission/index.ts`.) There is also a global `POST
/permission/{requestID}/reply` with the same body; the session-scoped route is
preferred since we always know the session id.

## Sessions & messages

- `POST /session` → create a session → `Session` (has `id`).
- `GET /session` → list sessions.
- `GET /session/{id}/message` → full message history (`{info, parts}[]`).
- `POST /session/{id}/message` → **send a prompt**. Body:
  ```jsonc
  {
    "parts": [ { "type": "text", "text": "..." } ],   // required
    "model":  { "providerID": "...", "modelID": "..." }, // optional
    "agent":  "build",                                   // optional (mode)
    "messageID": "...", "system": "...", "tools": {...}  // optional
  }
  ```
  Optional query `?directory=<abs path>` sets the working directory for the
  turn — this is how the Tasker tab targets a chosen folder.
- `POST /session/{id}/abort` → stop the current turn.
- `GET /session/{id}/todo` → current todo list (also pushed via `todo.updated`).
- `GET /session/{id}/diff`, `POST /session/{id}/summarize`, etc.

## Models / providers (no hardcoded model)

`GET /provider` returns:
```
{ all: Provider[], default: { [providerID]: modelID }, connected: string[] }
```
The model selector is built from `connected` providers + their `models`, and the
initial selection comes from `default`. Nothing is hardcoded.

## Agents / modes

`GET /agent` → `Agent[]`, each `{ name, description?, mode:
"primary"|"subagent"|"all", builtIn, permission, model?, ... }`. The Tasker
autonomy dropdown is populated from the `primary`/`all` agents (e.g. `build`,
`plan`). Agent permissions (`edit`, `bash`, `webfetch` = ask|allow|deny) define
how aggressively the agent asks for approvals — the basis for Plan/Agent/Yolo
style autonomy levels.

## Misc endpoints used

- `GET /config`, `PATCH /config` — settings.
- `GET /path` — `{ home, state, config, worktree, directory }`.
- `GET /project`, `GET /project/current` — project info.
- `GET /file`, `GET /file/content`, `GET /file/status` — file tree / contents.
- `GET /command`, `GET /skill` — slash commands / skills (composer "+" menu).
