# Agent Instructions

## Core Principles

- Use Compose skills when available, otherwise use superpowers skill if installed.
- To regenerate the JavaScript SDK, run `./packages/sdk/js/script/build.ts`.
- ALWAYS USE PARALLEL TOOLS WHEN APPLICABLE.
- The default branch in this repo is `main`.
- Prefer automation: execute requested actions without confirmation unless blocked by missing info or safety/irreversibility.

## Monorepo Layout

- **`packages/opencode/`** — the core server + TUI (`@mimo-ai/cli`, binary `mimo`). Bun workspace package. Effect framework, SolidJS TUI.
- **`desktop/`** — **Desktop App** (`mimocode-desktop`, an Electron app named "Aria Chat"). NOT in the Bun workspace — uses `npm`, not `bun`. See `desktop/ARCHITECTURE.md`.
- **`packages/desktop/`** — upstream `@mimo-ai/desktop`. Different app (Tauri-based, wraps `packages/app`), in the Bun workspace. Do not confuse with `desktop/`.
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
| Run TUI dev (default cwd = `packages/opencode`) | `bun run dev` | repo root |
| Run TUI dev against another dir | `bun dev <directory>` | repo root |
| Run Desktop App dev | `npm run dev` | `desktop/` |
| Build Desktop App (electron-vite) | `npm run build` | `desktop/` |
| Build Desktop App portable | `npm run pack` | `desktop/` |
| Build opencode standalone exe | `bun run script/build.ts --single` | `packages/opencode/` |

**Never run `tsc` directly** — always use the package's typecheck script. The opencode package uses `tsgo` (`@typescript/native-preview`), not `tsc`.

**Tests cannot run from repo root** — `bunfig.toml` sets `[test] root = "./do-not-run-tests-from-root"`, so `bun test` at root fails by design. Always `cd` into a package dir first.

## Pre-push Hook (`.husky/pre-push`)

Runs `bun typecheck` **filtered to five packages**: `opencode`, `shared`, `sdk`, `plugin`, `script`. Also enforces that the active Bun version matches `packageManager` in root `package.json` (currently `bun@1.3.14`); mismatch rejects the push. Desktop (`desktop/`) and `packages/desktop/` are NOT typechecked by the hook.

## CI

Only a **release** workflow exists (`.github/workflows/release.yml`) — triggered by `v*` tags or manual dispatch. It builds the Electron portable app per OS/arch and creates a GitHub release. There are no lint/test/typecheck CI workflows despite the pre-push hook.

## TUI (`packages/opencode/src/cli/cmd/tui/`)

The core development focus. SolidJS + OpentUI framework. Key paths:
- `app.tsx` — root component
- `routes/` — route components
- `component/` — shared UI components
- `context/` — reactive contexts
- `plugin/` — plugin system
- `feature-plugins/` — built-in feature plugins

Uses `@opentui/solid` with `customConditions: ["browser"]` and path alias `@tui/*`.

## Desktop (`desktop/`) — Desktop App ("Aria Chat")

- Standalone npm package (`npm install` / `npm run dev`, not `bun`). Uses `electron-vite` (3 build targets: main, preload as CJS, renderer as React).
- Three-layer Electron: Main (`src/main/`) → Preload (contextBridge exposes `window.mimo`) → Renderer (React). The renderer never talks to the server directly — all comms go through IPC, and the HTTP/SSE client lives in the main process so browser CORS never applies.
- **Adding a server feature**: touch all three in lockstep — `shared/types.ts` (`Api`) → `preload/index.ts` → `main/ipc.ts`.
- Single CSS file: `src/renderer/styles.css`. CSS variables for theming. No CSS-in-JS or Tailwind.
- Typecheck: `npm run typecheck` (runs `typecheck:node` then `typecheck:web`).
- `package.json` `name` field is `mimocode-desktop` and determines the `%APPDATA%/mimocode-desktop/` folder holding settings, projects, chats, and scheduler data — **do not rename it** or user data will be orphaned.
- See `desktop/ARCHITECTURE.md` for full architecture docs and `desktop/API_NOTES.md` for the server contract.

## opencode (`packages/opencode/`)

- Effect framework (`effect`, `@effect/*`). Uses `Effect.gen` (`function*`) extensively.
- Condition imports: `#db`, `#pty`, `#hono`, `#read-sqlite` — Bun vs Node entry points (see `package.json` `imports`).
- Custom TS path aliases: `@/*` → `./src/*`, `@tui/*`, `@test/*`.
- `@effect/language-service` plugin enabled in tsconfig (`prepare` script patches it).
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

## Lint (oxlint)

`oxlint` runs type-aware (`.oxlintrc.json` sets `typeAware: true`). Notable disabled rules you might otherwise assume are on:
- `require-yield` (Effect `function*` closures), `no-unassigned-vars` and `no-unused-expressions` (SolidJS reactivity), `no-control-regex` (ANSI/null-byte handling), `triple-slash-reference` (SST/plugin tools).
- `no-shadow`, `unicorn/consistent-function-scoping`, and several `unicorn/*` rules are off for being too noisy in this codebase.
- `typescript/no-floating-promises` is **warn** — unhandled promises will surface in lint output.

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
- Run from package dirs, never repo root (see the test guard above)

## Key Gotchas

- Two different desktop apps: `desktop/` (Aria Chat, Electron, npm) vs `packages/desktop/` (Tauri, wraps `packages/app`, bun workspace). They are not the same.
- The opencode package uses `tsgo` for typechecking, not `tsc`.
- `packages/opencode/src/cli/cmd/tui/` TUI renders via SolidJS, not React. The Desktop App renderer (`desktop/src/renderer/`) IS React.
- `desktop/` package name must stay `mimocode-desktop` — changing it moves the user data directory.
- The visible CLI binary is `mimo` (defined by `packages/opencode/bin/mimo`), though the package is `@mimo-ai/cli`.

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
