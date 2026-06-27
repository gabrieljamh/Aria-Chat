# MiMo Code Desktop — Architecture

Onboarding guide for the `desktop/` app. Read this first if you're new to the
codebase; it maps the modules, the data flow, and the conventions you need to
make a change without surprises.

For the *server* contract (endpoints, event shapes) see
[`API_NOTES.md`](./API_NOTES.md). For install/run/build steps see
[`README.md`](./README.md). This document is about *how the app is wired*.

---

## 1. What this app is

An Electron desktop UI (Claude-desktop style) over MiMo Code's local HTTP + SSE
server. The app does not implement any AI logic itself — it **spawns** (or
attaches to) a MiMo Code `serve` process and drives it over REST + Server-Sent
Events, rendering the streamed result.

There are **two active top-level tabs**: **Chat** and **Tasker** (internally keyed as "cowork"). (A `CodeTab`
component exists but is not currently mounted — see [§9 Caveats](#9-caveats--reality-checks).)

- **Chat** — each chat runs in its own throwaway sandbox folder under the app's
  user-data directory, so file work never touches your real projects.
- **Tasker** — runs against a user-picked project folder, with a live progress
  checklist and a list of edited files alongside the conversation.

---

## 2. The three Electron layers

Electron splits a desktop app into separate processes. Everything here follows
that split, and the boundary is enforced: **the renderer never talks to the
server directly.**

```
┌──────────────────────────────────────────────────────────────────┐
│  MAIN PROCESS (Node)              src/main/                        │
│                                                                    │
│   index.ts ── creates BrowserWindow, app lifecycle                 │
│   ipc.ts   ── the bridge: registers all ipcMain handlers           │
│      │                                                             │
│      ├── server.ts   spawns/attaches the MiMo `serve` process      │
│      ├── client.ts   HTTP + SSE client (Node fetch)                │
│      ├── store.ts     JSON settings file (<userData>/settings.json)│
│      └── workspaces.ts sandbox folders + chat/tasker registries    │
└───────────────────────────────┬──────────────────────────────────┘
                                 │  contextBridge  (window.mimo)
┌───────────────────────────────┴──────────────────────────────────┐
│  PRELOAD                          src/preload/index.ts             │
│   Exposes a single typed object `window.mimo` (the MimoApi).       │
│   Pure pass-through: every method is ipcRenderer.invoke/send/on.   │
└───────────────────────────────┬──────────────────────────────────┘
                                 │  window.mimo.*
┌───────────────────────────────┴──────────────────────────────────┐
│  RENDERER (React)                 src/renderer/                    │
│   App.tsx ── top-level state, tab switching, registry orchestration│
│   useConversation.ts ── reduces the SSE event stream into UI state │
│   ChatTab / TaskerTab / Composer / Sidebar / cards / SettingsModal │
└──────────────────────────────────────────────────────────────────┘

       src/shared/types.ts ── types shared by ALL three layers
```

Why the strict split: the HTTP/SSE client lives in the **main process** (Node
`fetch`), so browser CORS never applies and the server's loopback password stays
out of the renderer. The renderer only ever sends commands and receives
*already-parsed* events.

---

## 3. Repo layout

```
desktop/
├── electron.vite.config.ts   3 build targets: main, preload (CJS), renderer (React)
├── package.json              standalone npm package (NOT in the repo's bun workspace)
├── tsconfig*.json            split node/web TS projects (typecheck:node + :web)
├── API_NOTES.md              the server contract this app depends on
├── README.md                 install / run / build / troubleshooting
├── ARCHITECTURE.md           (this file)
│
├── src/main/                 Electron main process (Node)
│   ├── index.ts              window + app lifecycle
│   ├── ipc.ts                IPC bridge — wires renderer ↔ server (~all handlers)
│   ├── server.ts             ServerManager: spawn/attach `serve`, health, lifecycle
│   ├── client.ts             MimoClient: REST methods + SSE frame parser
│   ├── store.ts              Store: tiny JSON settings persistence
│   ├── workspaces.ts         sandboxes + ChatsList.json / ProjectsList.json
│   └── menu.ts               native menu template (built, but see §9)
│
├── src/preload/index.ts      contextBridge → window.mimo
│
├── src/shared/
│   ├── types.ts              the IPC + server type contract (single source of truth)
│   └── img/                  logos bundled into the renderer
│
└── src/renderer/             React UI
    ├── main.tsx              React root
    ├── App.tsx               state hub: tabs, registries, send/abort, model/agent
    ├── useConversation.ts    SSE event-stream reducer → conversation State
    ├── ChatTab.tsx           sidebar + greeting + composer + message list
    ├── TaskerTab.tsx         dir picker + 3-pane (conv | Progress + file list)
    ├── CodeTab.tsx           stub (not mounted)
    ├── Composer.tsx          input box: model/mode selects, "+" menu, slash menu
    ├── Sidebar.tsx           chat list: favorites, recents, rename/pin/delete
    ├── MessageView.tsx       renders one message's parts (text/reasoning/tool/file)
    ├── ApprovalCard.tsx      inline permission prompt (Approve/Always/Deny)
    ├── QuestionCard.tsx      inline multiple-choice question prompt
    ├── SettingsModal.tsx     Models / Skills / Server / Conversations pages
    ├── FileViewer.tsx        modal preview of an edited file
    ├── Markdown.tsx          react-markdown wrapper (GFM, safe links)
    ├── customModels.ts       renderer-side store for user-defined models
    ├── Icons.tsx             inline SVG icon set
    ├── types-internal.ts     re-export of State/ConvMessage
    └── styles.css            all styling (single stylesheet)
```

---

## 4. Startup sequence

What happens from launching the app to a usable window:

1. **`index.ts`** — `app.whenReady()` → `registerIpc()` → `createWindow()`. The
   window is frameless (`frame: false`, custom title bar in `App.tsx`),
   `contextIsolation: true`, `nodeIntegration: false`.
2. **`ipc.ts` `boot()`** runs immediately (not lazily). It:
   - reads any stored `serverUrl` / `serverPassword` setting,
   - calls **`ServerManager.start()`** → spawn or attach,
   - constructs a **`MimoClient`** with the server's credentials,
   - subscribes to client events and rebroadcasts them to the renderer over the
     `server-event` channel,
   - calls `client.startEventStream()` to open the SSE connection.
   - The promise is cached as `bootPromise`; **every REST handler `await`s it**
     before touching the client, so the renderer can fire calls before the
     server is confirmed ready.
3. **`server.ts` spawn path** — finds the repo root by walking up for
   `packages/opencode/src/index.ts`, then prefers `bun` (run with
   `cwd = packages/opencode` so it picks up that package's tsconfig), falling
   back to an `opencode` / `mimocode` binary on PATH. It generates a random
   loopback password (so working dirs *outside* the repo are allowed), spawns
   the process, and scans stdout/stderr for `listening on <url>` to learn the
   port. 30s timeout.
4. **Renderer** — `App.tsx` subscribes to `server-status`; while not `ready` it
   shows the "Starting…" banner. On `ready` it loads registries, providers, and
   agents (see §6).

Status is a small state machine surfaced to the UI:
`{ starting } → { ready, url } | { error, message } | { stopped }`.

---

## 5. The IPC contract (`window.mimo`)

`src/shared/types.ts` defines **`MimoApi`** — the entire surface the renderer
can call. `preload/index.ts` implements it as thin `ipcRenderer` wrappers, and
`ipc.ts` registers the matching `ipcMain` handlers. **To add a feature that
needs the server, you touch all three in lockstep:** add the method to
`MimoApi`, wrap it in the preload, handle it in `ipc.ts`.

Channels group into:

| Group | Examples | Notes |
|-------|----------|-------|
| Server lifecycle | `getServerStatus`, `onServerStatus`, `onServerEvent` | `on*` return an unsubscribe fn |
| Conversation | `createSession`, `getMessages`, `prompt`, `abort` | all accept an optional `directory` |
| Approvals / questions | `replyPermission`, `questionReply`, `questionReject` | request→session dir resolved in main |
| Discovery | `getProviders`, `getAgents`, `getCommands`, `getSkills`, `getTodos`, `getPath` | populate selectors / slash menu |
| Config / auth | `getConfig`, `updateConfig`, `setAuth` | provider setup (see §8) |
| Skills mgmt | `installSkill`, `installSkillFile`, `uninstallSkill`, `pickSkillFile` | copy into `~/.agents/skills/<name>` |
| Workspaces | `createChatSandbox`, `ensureProjectMarker`, `getRegistry`, `saveRegistry`, `deleteSandbox`, `readFileText`, `openPath` | local-only, no server |
| Window / native | `minimizeWindow`, `maximizeWindow`, `closeWindow`, `pickDirectory`, `onMenu` | frameless controls |
| Settings | `getSetting`, `setSetting` | backed by `store.ts` |

The `directory` argument is the key plumbing detail: it becomes the
`?directory=` query on the server request, telling MiMo which working folder
(= which instance) the call targets. Chat sandboxes and Tasker projects are each
their own instance, so almost every call carries one.

---

## 6. State model in the renderer

Two cooperating pieces of state:

### `App.tsx` — the orchestrator

Holds the cross-tab state: current tab, server status, providers, agents,
selected model + agent, web-search toggle, the **registries** (`chats`,
`cowork` — the internal key for the Tasker tab), and which item is active per tab.

A subtlety worth knowing: registries are mirrored in `useRef` (`chatsRef`,
`coworkRef` — contains Tasker items) **in addition to** React state. React state updates are async, so
inside one async action (create chat → send prompt → refresh title) reading the
state closure would be stale and could clobber the registry. `persist()` writes
the ref synchronously *and* the state, so every step sees the latest list.

`App.tsx` owns the action handlers wired into the tabs: `sendPrompt` (creates a
session lazily if none is active, then `window.mimo.prompt(...)`), `abort`,
`replyPermission`, the question handlers, project picking, and registry edits
(rename/pin/delete).

### `useConversation.ts` — the SSE reducer

This is the heart of the live UI. It owns a `useReducer` whose state is:

```ts
{ order: string[], messages: Record<id, {info, parts}>, todos, files,
  permissions, questions, busy, error }
```

It does two things:

1. **On session change** — fetches `getMessages` + `getTodos` for history and
   dispatches a `reset`. There's a guard: if SSE events have already started
   populating the session (`populatedRef`), the late history fetch is dropped so
   it doesn't overwrite live data, and a stale fetch for an old session id is
   ignored.
2. **On every `server-event`** — filters to the active session (via
   `eventSessionId`) and dispatches into the reducer.

The reducer maps event types to state transitions:

| Event | Effect |
|-------|--------|
| `message.updated` | upsert message envelope; clears `busy` if assistant msg is completed |
| `message.part.updated` | upsert a part — **this is token streaming** (text parts grow cumulatively) |
| `message.part.removed` / `message.removed` | drop part / message |
| `permission.asked` / `permission.replied` | add / remove an approval card |
| `question.asked` / `question.replied` / `question.rejected` | add / remove a question card |
| `todo.updated` | replace the Progress checklist (Tasker) |
| `file.edited` | append to the workspace file list (Tasker), de-duped |
| `session.idle` | clear `busy` (turn finished) |
| `session.error` | clear `busy`, set `error` |

So the data flow end to end is:

```
user types → Composer.onSend → App.sendPrompt → window.mimo.prompt
  → ipc → MimoClient POST /session/{id}/message
  → server runs the turn, emits SSE events on /event
  → MimoClient parses frames → emits "event"
  → ipc broadcasts "server-event" → useConversation reducer → React re-render
```

---

## 7. Sandboxes & registries (`workspaces.ts`)

- **Chat mode**: `createChatSandbox()` makes a fresh
  `<userData>/chats/<uuid>/` folder (with a `.mimocode` marker so MiMo accepts
  it as a valid project) — isolated, deletable per chat.
- **Tasker mode** (internally keyed as "cowork"): runs in a folder the user picks; `ensureProjectMarker()`
  drops the same `.mimocode` marker so MiMo will operate there.
- **Registries**: two JSON files, `<userData>/chats/ChatsList.json` and
  `<userData>/projects/ProjectsList.json`, each a list of `ChatRef`
  (`{ id, sessionID, title, directory, mode, createdAt, updatedAt }`) mapping
  the app's stable id to a server session + folder. This is how chats/tasks
  survive restarts; titles are refreshed from MiMo's auto-generated session
  title after the first turn.

The `.mimocode` marker matters because the spawned server runs with a password,
which is what lets it operate in directories outside the repo root — without the
marker MiMo's `isValidProjectDirectory` would reject them.

---

## 8. Provider / model configuration (`SettingsModal.tsx` + `customModels.ts`)

Nothing about models is hardcoded. The model selector is built live from
`GET /provider` (`connected` providers + their models), and the default
selection comes from the server's `default` map (or the last-used model,
persisted as the `lastModel` setting).

Adding a provider in Settings does a few things at once:
1. `updateConfig({ provider: {...} }, dir)` — **note** this does *not* use
   `PATCH /config`. As documented in `client.ts`, MiMo's project-config loader
   only reads `mimocode.json` (walking up from the working dir), so
   `updateConfig` merges the patch into `<dir>/mimocode.json` and disposes the
   instance so it reloads. (A `PATCH /config` would write a file the loader
   never reads.)
2. Stores the provider under the `baseConfig` setting, so new chat sandboxes can
   be **seeded** (`App.seedDir`) — each sandbox is its own instance and needs
   the provider config to resolve the model.
3. `setAuth(providerID, { type: "api", key })` to store the API key.
4. Adds a `CustomModel` entry (via `customModels.ts`, a small subscribe-able
   renderer store) so the model shows in the composer dropdown immediately,
   merged alongside the server's connected providers.

---

## 9. Caveats & reality checks

Things that differ from a first read of the code or the README — worth knowing
before you go looking:

- **The Code tab is not mounted.** `CodeTab.tsx` exists, but `App.tsx`'s tab type
  is `"chat" | "cowork"` (the pill bar shows "Chat" / "Tasker") and the pill bar only renders those two. The README's
  "three tabs" framing is aspirational. Wiring it back means adding `"code"` to
  the `Tab` union, the pill bar, and the body switch.
- **The native menu is built but not installed.** `menu.ts` exports
  `buildMenu()`, but `index.ts` never calls it, so there's no OS menu bar and the
  `menu-command` channel (`onMenu`) currently receives nothing. The frameless
  title bar's brand-logo dropdown (Settings / Reload / Quit) and the in-app
  window controls cover the same actions. To enable the menu, call
  `buildMenu(win)` in `createWindow()`.
- **Permission reply route.** `client.ts` posts to
  `POST /permission/{requestID}/reply` (global route). `API_NOTES.md` also
  mentions a session-scoped variant; the global one is what's actually used, and
  `ipc.ts` resolves the directory from the request→session map.
- **The "+" menu's Connectors row is a placeholder** — the rest is wired:
  Add files opens the native file picker, Skills opens the skills submenu with
  installed skills and "Manage skills" link.
- **Voice/mic button is wired** — uses `navigator.mediaDevices.getUserMedia` +
  `MediaRecorder`, attaches audio as a data-URL attachment.
- **Composer attachments** support: native file picker, drag-and-drop, clipboard
  paste (images/files), image thumbnails with click-to-preview overlay.
- **Lots of `console.log` left in** `App.tsx`, `useConversation.ts`,
  `QuestionCard.tsx` — useful for debugging in DevTools (Ctrl/Cmd+Shift+I),
  strip before shipping.
- **Standalone npm package.** `desktop/` is intentionally *not* in the repo's Bun
  workspace catalog; it only depends on the repo at runtime (to spawn the
  server). `npm install` here, not `bun install`.

---

## 10. Where to make common changes

| You want to… | Start in |
|---|---|
| Add a server call to the UI | `shared/types.ts` (`MimoApi`) → `preload/index.ts` → `ipc.ts` → caller |
| Handle a new SSE event | `shared/types.ts` (`ServerEvent` union) → `useConversation.ts` reducer |
| Change how a message/tool/file renders | `MessageView.tsx` (+ `Markdown.tsx`) |
| Change the composer (selectors, slash, "+" menu) | `Composer.tsx` |
| Change chat list / rename / delete / pin | `Sidebar.tsx` + the handlers in `App.tsx` |
| Change Tasker's Progress / file panel | `TaskerTab.tsx` (`ProgressPanel`) |
| Change how the server is launched | `server.ts` |
| Change provider/model setup | `SettingsModal.tsx` + `client.ts` `updateConfig` |
| Change styling | `styles.css` (single stylesheet, CSS variables for theme) |

---

## 11. Quick reference

- **Run dev:** `npm run dev` (auto-starts the server). **Typecheck:**
  `npm run typecheck` (runs node + web projects). **Build:** `npm run build`.
- **Attach to your own server:** `MIMO_SERVER_URL=http://127.0.0.1:4096 npm run dev`,
  or set Server URL in Settings → Server.
- **Settings file:** `<userData>/settings.json`. **Sandboxes:**
  `<userData>/chats/`. **Projects registry:** `<userData>/projects/`.
- **Server contract:** [`API_NOTES.md`](./API_NOTES.md). **Setup/troubleshooting:**
  [`README.md`](./README.md).
