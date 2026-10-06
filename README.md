# grim-repo

Local-first codebase treemap visualiser. See [docs/SPEC.md](docs/SPEC.md). Status: **M1 skeleton**.

## Requirements
Node 20+, pnpm 9+.

## Run
```sh
pnpm install
pnpm -r build
node packages/cli/dist/index.js [path]   # starts server on a free port and opens the browser
# options: --port=4317  --no-open
```

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
- `WS /api/progress` → scan stage events (stub)

## Packages
- `schema` – zod snapshot schema / types
- `core` – walker (.gitignore, exclusions), SLOC, tree-sitter (WASM) class/function split for TS/JS/Python
- `server` – Fastify API + static web
- `web` – React + Vite + Tailwind + PixiJS v8 treemap
- `cli` – `grim-repo [path]`

## Controls
Scroll to zoom, drag to pan, click to dive one level, right-click / Esc to go up, breadcrumb to jump.
