# Agent Instructions

## Core Principles

- Use Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- CI triggers on both `main` and `dev` branches.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Monorepo Layout

- **`packages/opencode/`** — the core server + TUI (`@org/cli`). Bun workspace package. Effect framework, SolidJS TUI.
- **`desktop/`** — **Desktop App** (standalone Electron app). NOT in the Bun workspace — uses `npm`, not `bun`. See `desktop/ARCHITECTURE.md`.
- **`packages/desktop/`** — upstream `@org/desktop`. Different Electron app, in the Bun workspace. Do not confuse with `desktop/`.
- **`packages/sdk/`** — JS SDK. Regenerated via `./packages/sdk/js/script/build.ts`.
- **`packages/shared/`** — shared types/utilities.
- Other packages: `app`, `console`, `enterprise`, `extensions`, `identity`, `plugin`, `script`, `slack`, `ui`, `web`.

## Commands

| What | Command | CWD |
|------|---------|-----|
| Typecheck all (turbo) | `bun run typecheck` | repo root |
| Typecheck desktop/ (Desktop App) | `npm run typecheck` | `desktop/` |
| Typecheck packages/desktop/ | `bun run typecheck` from package, or `bun turbo typecheck` | root |
| Typecheck opencode single | `bun run typecheck` | `packages/opencode/` |
| Lint (oxlint) | `bun run lint` | repo root |
| Test opencode | `bun test --timeout 30000` | `packages/opencode/` |
| Test single file | `bun test test/<path>.test.ts` | `packages/opencode/` |
| Run TUI dev | `bun run dev` | repo root |
| Run Desktop App dev | `npm run dev` | `desktop/` |
| Build Desktop App portable | `npm run pack` | `desktop/` |

**Never run `tsc` directly** — always use the package's typecheck script. The opencode package uses `tsgo`.

**Tests cannot run from repo root** (guard exits with error). Always `cd` into a package dir first.

## Pre-push Hook

Runs `bun typecheck` — your push will be rejected on type errors. Also validates the Bun version matches `packageManager` in root `package.json`.

## TUI (`packages/opencode/src/cli/cmd/tui/`)

The core development focus. SolidJS + OpentUI framework. Key paths:
- `app.tsx` — root component
- `routes/` — route components
- `component/` — shared UI components
- `context/` — reactive contexts
- `plugin/` — plugin system
- `feature-plugins/` — built-in feature plugins

Uses `@opentui/solid` with `customConditions: ["browser"]` and path alias `@tui/*`.

## Desktop (`desktop/`) — Desktop App

- Standalone npm package. Use `npm install` / `npm run dev`, not `bun`.
- Three-layer Electron: Main (`src/main/`) → Preload (contextBridge) → Renderer (React).
- Renderer never talks to the server directly — all server comms go through IPC.
- **Adding a server feature**: touch all three in lockstep — `shared/types.ts` (`Api`) → `preload/index.ts` → `main/ipc.ts`.
- Single CSS file: `src/renderer/styles.css`. CSS variables for theming. No CSS-in-JS or Tailwind.
- Typecheck: `npm run typecheck` (runs `typecheck:node` then `typecheck:web`).
- `package.json` `name` field (`desktop-app`) determines the `%APPDATA%` folder — **do not rename it** or user data will be orphaned.
- See `desktop/ARCHITECTURE.md` for full architecture docs.

## opencode (`packages/opencode/`)

- Effect framework (`effect`, `@effect/*`). Uses `Effect.gen` (`function*`) extensively.
- Condition imports: `#db`, `#pty`, `#hono`, `#read-sqlite` — Bun vs Node entry points.
- Custom TS path aliases: `@/*` → `./src/*`, `@tui/*`, `@test/*`.
- `@effect/language-service` plugin enabled in tsconfig.
- DB: Drizzle ORM with SQLite. Use snake_case for schema fields (no string redefinition needed).

## Style Guide

- Keep things in one function unless composable or reusable
- Avoid `try`/`catch` where possible; avoid `any`
- Use Bun APIs when possible (e.g. `Bun.file()`)
- Rely on type inference; annotate only for exports or clarity
- Prefer functional array methods over for loops; use type guards on `.filter()` for type narrowing
- Config modules in `src/config/`: follow self-export pattern (`export * as ConfigX from "./x"`)
- Inline values used only once — avoid single-use variables
- Avoid unnecessary destructuring; use dot notation to preserve context
- Prefer `const` over `let`; ternaries / early returns over reassignment
- Avoid `else` — prefer early returns

## Drizzle Schemas

Use snake_case fields so column name strings aren't needed:

```ts
const table = sqliteTable("session", {
  id: text().primaryKey(),
  project_id: text().notNull(),
  created_at: integer().notNull(),
})
```

## Testing

- Avoid mocks; test actual implementation
- Do not duplicate logic into tests
- Run from package dirs, never repo root (opencode has a guard)

## CI

Three workflows on `main` and `dev`: lint (oxlint), typecheck (turbo), test (bun test).

## Key Gotchas

- Two different desktop apps: `desktop/` (Desktop App, npm) vs `packages/desktop/` (upstream, bun workspace). They are not the same.
- The opencode package uses `tsgo` for typechecking, not `tsc`.
- `packages/opencode/src/cli/cmd/tui/` TUI renders via SolidJS, not React.
- `desktop/` package name field must stay `desktop-app` — changing it moves the user data directory.

## Agent Behavior

- Be concise, direct, and to the point
- Answer in fewer than 4 lines unless user asks for detail
- Explain BEFORE calling tools (2-4 sentences: what, why, expected outcome)
- Never emit tool calls with zero preceding text
- Minimize output tokens while maintaining helpfulness
- No unnecessary preamble or postamble
- No emojis unless explicitly requested
- Follow existing code conventions in the codebase
- Prefer functional patterns over imperative
- Validate at system boundaries only
- Delete unused code completely rather than leaving shims