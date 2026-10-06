# grim-repo

Local-first codebase treemap visualiser. See [docs/SPEC.md](docs/SPEC.md). Status: **M6 ops** (all v1 milestones).

## Requirements
Node 20+, pnpm 9+.

## Run
```sh
pnpm install
pnpm -r build
node packages/cli/dist/index.js [path|git-url]   # starts server on a free port and opens the browser
# options: --port=4317  --no-open  --verbose (log scan timings / cache hits)
node packages/cli/dist/index.js scan <path|git-url> --out snapshot.json [--ref branch] [--no-cache]   # headless
```
Git URLs (https, ssh, GitHub/GitLab/Bitbucket web URLs incl. `/tree/<branch>`) are cloned blobless into
`~/.grim-repo/repos/<id>`; per-file analysis, git history, blame and the last snapshot are cached in
`~/.grim-repo/cache/<id>/` (override the root with `GRIM_REPO_HOME`). Auth: `gh auth token` (github.com) →
git credential helper / SSH → PAT in the OS keychain (optional `keytar`). Repo code is never executed.

Publishable package: `cd packages/cli && npm pack` → `npx ./grim-repo-0.1.0.tgz --no-open <path>` (server, core,
schema bundled with esbuild; built web UI copied to `dist/web`).

### Editor types
Workspace packages export a `source` condition pointing at `src/index.ts`; each package's `tsconfig.json`
(used by editors) sets `customConditions: ["source"]`, so types come from source without rebuilding.
Builds use `tsconfig.build.json` (dist `.d.ts`).

## Dev
```sh
pnpm dev:server -- /path/to/repo   # API on http://127.0.0.1:4317 (rebuilds server first)
pnpm dev:web                       # Vite on http://localhost:5173, proxies /api to 4317
pnpm test                          # Vitest (packages/core)
```

## API
- `POST /api/scan` `{ "path": "/abs/path", "showDocs": false }` → snapshot JSON (`packages/schema`)
- `GET /api/scan?path=...` → same
- `GET /api/config` → `{ defaultPath }`
- `POST /api/scan` also takes `ref` (branch) and `fetch` (remote: fetch + reset first)
- `GET /api/cached?path=` → last persisted snapshot (instant reopen) · `GET /api/branches?path=<url>`
- `POST /api/watch` `{ root, on }` (local only) · `GET /api/detail?root=&path=` (lazy file detail for >50k-file repos)
- `POST /api/auth/pat` `{ host, token }` → OS keychain
- `GET /api/git/branches?root=` · `GET /api/commits?root=&branch=&offset=&limit=` (sha, parents, subject, author, date, +/−) · `GET /api/diff?root=&from=&to=` (per-file A/M/D/R status, counts, `-U0` hunks, per-function attribution; `root` must be a scanned root, refs strictly validated)
- `WS /api/progress` → stage events (clone, walk, sloc, git, parse, detect, coverage, blame), partial / watch snapshots, blame layer updates

## Packages
- `schema` – zod snapshot schema / types
- `core` – walker (.gitignore, exclusions), SLOC, tree-sitter (WASM, worker_threads pool) for TS/JS, Python, Go, Java, C#, Rust; git, cache, clone
- `server` – Fastify API + static web
- `web` – React + Vite + Tailwind + PixiJS v8 treemap
- `cli` – `grim-repo [path|url]`, `grim-repo scan`; publishable bundle

## Controls
Scroll to zoom, drag to pan, click to dive one level, right-click / Esc to go up, breadcrumb to jump, Tab to cycle the exploded view off → medium → large (Shift+Tab steps back): tiles keep their size and arrangement and drift apart like an exploded-view diagram, folders far more than files.

**Changes panel** (above the layer dock): pick a branch, click a commit to see what it changed (vs its first parent), or shift-click a second commit for the inclusive range `older^..newer`. Changed files and functions light up on the map (green added, amber modified, brighter = more lines) while everything else dims; folders with changes get a faint tint. The list shows changed files → functions with +/− (click to fly there) plus a "Not on map" section for deleted/renamed files. Clear (or Esc in the panel) restores the fill layer.
