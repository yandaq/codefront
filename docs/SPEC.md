# grim-repo — Specification (v1)

A local-first codebase visualisation tool. The user points it at a local path or any git URL; it scans the repo and renders a nested treemap (folders → files → classes → functions, sized by SLOC) with weather-app-style overlay layers.

## 1. Runtime & packaging
- Local-first: `npx grim-repo [path|url]` starts a Node server on a free localhost port and opens the browser.
- Headless: `grim-repo scan <path|url> --out snapshot.json` produces a portable, self-contained JSON snapshot (future hosted viewer).
- Node 20+, `git` on PATH. No other native deps (tree-sitter via WASM).
- pnpm monorepo, TypeScript everywhere:
  - `packages/schema` — snapshot types + zod schemas (shared)
  - `packages/core` — scanner pipeline, git, tree-sitter, detectors, metrics (pure library, no HTTP)
  - `packages/server` — Fastify + WebSocket, cache, watch mode
  - `packages/web` — React + Vite + Tailwind + PixiJS v8
  - `packages/cli` — entry point; bundles server + built web assets
- Testing: Vitest for core with generated fixture git repos (deterministic metrics); Playwright smoke + visual snapshot tests for the renderer.

## 2. Inputs
- Local path, or any git URL (GitHub, GitLab, Bitbucket, …). Accepts `/tree/<branch>` forms; branch dropdown after clone.
- Clone: `git clone --filter=blob:none` into `~/.grim-repo/repos/<id>`.
- Auth: `gh auth token` → git credential helper/SSH → user PAT stored in OS keychain (`keytar`). Never plaintext.
- No hosting API dependency in v1. Cloned code is **never executed**.

## 3. Languages
- tree-sitter (`web-tree-sitter` WASM grammars). Deep support first: TS/JS, Python. Then Go, Java, C#, Rust via query files.
- Unsupported languages: file-level squares + git layers only.
- Import resolution: full for TS/JS and Python; best-effort for others.

## 4. Treemap model
- Hierarchy: Folder → File → Class/Module → Function/Method. Named inner functions (declarations, named function expressions, arrow/function expressions assigned to a const/let/var, object property or class field) become child tiles, with a dimmed "<name> body" tile for the parent's own lines; anonymous callbacks (incl. inline JSX arrows) merge into their parent. Max 3 levels inside a file: anything deeper merges into its level-3 ancestor. Each function's complexity is its own score (at the depth cap it is the max over merged named inners). "n small functions" aggregation applies at every level.
- Size = SLOC (non-blank, non-comment) via tree-sitter comment nodes; `scc`-style counting fallback.
- Top-level code outside functions → a dimmed "module scope" square so children sum to file size.
- Docs/config (md, json, yaml, images…) hidden by default (toggle "Show docs/config"). Lockfiles, `dist/`, `*.min.*`, `*.generated.*`, `linguist-generated` always excluded. Respect `.gitignore`; skip `node_modules`, vendored, binaries.
- Tiny items (< ~3 SLOC or < ~4px on screen) aggregate into an "n small functions" tile until zoomed.
- Target scale: up to ~50k files; beyond that, folder-level detail until zoomed.

## 5. Layers
One **fill** layer at a time (radio), plus independent **edge** and **pin** overlays. Fill switches cross-fade (~400ms). Windy-style layer dock bottom-right with animated legends and per-layer progress rings while scanning.

| Layer | Kind | Definition | Scale |
|---|---|---|---|
| Age | fill | Days since last change; per-function via `git blame` (background), file-level last commit until ready | Log, today → 2y+; cyan (fresh) → violet (ancient) |
| Coverage | fill | % lines covered from ingested reports; folders SLOC-weighted | Linear 0–100%, red → amber → green; no data = hatched grey |
| Complexity | fill | Cognitive complexity per function; files/folders max or SLOC-weighted mean (toggle) | Repo percentile (absolute-threshold toggle) |
| Churn | fill | Commits touching it in window (30d/90d/1y/all, default 90d); optional line-churn | Percentile, magma |
| Hotspots | fill | normalised churn × normalised complexity | Percentile; top 5% extra bloom |
| Coupling | edges | Sub-modes: **Imports** (default) / **Co-change** (threshold slider, e.g. ≥30%, min 5 commits) | — |
| LLM Prompts | pins (cyan, pulsing) | Count of hits | — |
| SQL/Queries | pins (amber) | Count of hits | — |

All colour ramps perceptual and colourblind-safe.

### Coverage ingest
Auto-detect `coverage/lcov.info`, `coverage-final.json` (Istanbul), `coverage.xml` (Cobertura/pytest-cov), `jacoco.xml`, Go `cover.out`. Manual path override. If none: "No coverage data" + hint command. Tests are never run.

### Coupling rendering
Hierarchical edge bundling (`d3.curveBundle`) at file level; auto-aggregate to folders when zoomed out. Idle: strongest ~200 edges, faint. Hover/select: node's edges light up with directional animated particles.

### Detectors (AST + heuristics, pluggable rules file, confidence scores)
- **LLM prompts:** known SDK calls (Anthropic, OpenAI, LangChain, Vercel AI SDK `generateText`, …) and their `system`/`messages` args; long string/template literals (> ~200 chars) with prompt markers ("You are", "Respond in JSON", `{{`, role keywords); `*.prompt`, `prompts/*.md`, `.jinja` files.
- **SQL:** string literals matching SELECT…FROM / INSERT INTO / UPDATE…SET / DELETE FROM / CREATE TABLE, validated by a lightweight SQL tokenizer; ORM calls (Prisma, Knex, Drizzle, TypeORM, SQLAlchemy, Django ORM); `.sql` files. Tag raw vs ORM, read vs write; extract tables touched.
- No LLM dependency in v1.

## 6. Scanning
- Stages streamed to UI over WebSocket: clone/fetch → walk → SLOC → git history → tree-sitter parse → detectors → coverage ingest → (background) blame.
- Progressive render: treemap appears after walk+SLOC; layers light up as stages complete.
- Parsing in a `worker_threads` pool.
- Incremental rescan: cache keyed by git blob SHA (content hash for dirty working-tree files); git history fetched incrementally from last-seen commit; remote repos `git fetch` + reset.
- Rescan animated diff: changed squares pulse, layout tweens to new sizes.
- Cache: `~/.grim-repo/cache/<repo-id>/` — reopen is instant.
- **Watch mode** (local repos, default off): chokidar → debounced incremental rescan.

## 7. Rendering & interaction
- d3 (`d3.treemap` with label padding, edge bundling) computes geometry; PixiJS v8 (WebGPU, WebGL fallback) renders. Labels in an HTML/SVG overlay, only for squares big enough.
- Semantic zoom: scroll/click dives with animated camera; function sub-squares appear when file is large enough on screen. Breadcrumb bar.
- Single click → right glass inspector: path, SLOC, all layer values with repo-percentile bars; git (last edit date/author, commit count, top 3 contributors, commit sparkline); coupling (imports / imported-by / top co-change partners with %, clickable); LLM/SQL hits with highlighted snippets.
- Double-click → zoom into node.
- Code peek: Shiki-highlighted source (theme matching UI), scrolled to function, coverage gutters when available.
- Open in editor: `vscode://file/...` (configurable: Cursor, JetBrains, …); remote repos link to host line URL.
- `⌘K` fuzzy search over files/functions; camera flies to result.

## 8. Visual design — "Mission Control"
- Dark hero theme (light toggle available). Background `#0a0e17`.
- Glassy tiles, 1px luminous borders, progressive inset shadows by depth ("terrain").
- Bloom shader on heatmap colours; neon coupling filaments with flowing particles; cyan LLM pins, amber SQL pins.
- Inter (UI) + JetBrains Mono (code/metrics).
- Cinematic intro: squares grow from root, staggered by depth.
- Hover: glass tooltip card with sparkline stats.

## 9. Out of scope (v1)
- Timeline / git-history scrubber (keep snapshot data timestamped to allow it later).
- Running tests to produce coverage.
- LLM-based classification.
- Hosted/SaaS mode, GitHub API overlays (PRs/issues).

## 10. Milestones
1. **M1 Skeleton** — monorepo, CLI, local-path scan (walk, SLOC, tree-sitter function split for TS/JS + Python), Pixi treemap with semantic zoom, breadcrumb, Mission Control styling, grow-in intro.
2. **M2 Git layers** — Age (file-level then background blame), Churn, Hotspots, layer dock + legends + cross-fades.
3. **M3 Analysis layers** — Complexity, coverage ingest, LLM/SQL detectors + pins.
4. **M4 Coupling** — import resolution, co-change, edge bundling, particles.
5. **M5 Interaction** — inspector, code peek, ⌘K, open-in-editor.
6. **M6 Ops** — git URL clone + auth, incremental rescan + animated diff, watch mode, cache, headless `scan`, remaining languages.
