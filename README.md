# codefront

`codefront` is a local-first codebase explorer. Point it at a local directory or a Git URL and it builds an interactive treemap of folders, files, classes, and functions, with each tile sized by source lines of code (SLOC).

The map can be coloured by code age, churn, hotspots, cognitive complexity, or test coverage. Independent overlays show imports, co-change relationships, LLM/SQL usage, selected commit ranges, and uncommitted work.

The repository is a TypeScript/pnpm monorepo. The complete v1 design is documented in [docs/SPEC.md](docs/SPEC.md).

## Highlights

- Local paths and HTTPS, SSH, or SCP-style Git URLs, including GitHub/GitLab/Bitbucket branch URLs
- Tree-sitter analysis for TypeScript/JavaScript, Python, Go, Java, C#, and Rust
- Semantic zoom from folders down to classes and functions
- Git age, churn, hotspot, contributor, commit, branch, and diff views
- Cognitive-complexity and coverage layers; coverage reports are read, never generated
- Import and co-change coupling overlays
- Heuristic pins for LLM prompts/API calls and SQL/query-builder usage
- Live watch mode for local repositories, including staged, unstaged, and untracked changes
- Incremental, content-addressed scans with persisted snapshots and background worker parsing
- Headless JSON output for other tools

Repository code is scanned as data and is never executed.

## Requirements

- Node.js 20 or newer
- pnpm 10 (the workspace currently pins `pnpm@10.7.0`)
- Git on `PATH` for history features and remote repositories

## Quick start

```sh
pnpm install
pnpm build
pnpm start -- /path/to/repository
```

The CLI starts a server on a free loopback port and opens the UI in your browser. If no target is supplied, it scans the current directory.

After building, the equivalent direct commands are:

```sh
# Local repository
node packages/cli/dist/index.js /path/to/repository

# Remote repository
node packages/cli/dist/index.js https://github.com/owner/repository

# Do not open a browser; optionally choose a port
node packages/cli/dist/index.js --no-open --port 4317 /path/to/repository
```

Use `--verbose` to print scan timings and cache hit/miss information from the server.

### Headless scan

```sh
node packages/cli/dist/index.js scan /path/to/repository --out snapshot.json
node packages/cli/dist/index.js scan https://github.com/owner/repository --ref main --out snapshot.json
```

Headless scans write a portable snapshot matching the schema in `packages/schema`. The available options are:

```text
--out <file>   Output path (default: snapshot.json)
--ref <name>   Remote branch to scan
--no-cache     Ignore the per-file analysis cache
--no-docs      Exclude documentation and configuration files
```

### Package smoke test

The CLI package bundles the server, core scanner, schema, and built web UI:

```sh
cd packages/cli
npm pack
npx ./codefront-0.1.0.tgz --no-open /path/to/repository
```

## Using the UI

- Scroll to zoom and drag to pan.
- Single-click a tile to inspect its metrics, history, coupling, detections, and source actions.
- Double-click a tile to dive into it. Right-click, Backspace, or Escape moves up; breadcrumbs jump directly to an ancestor.
- Press `Ctrl+K` or `Cmd+K` to search files and functions.
- Press Tab to cycle the exploded view through off, medium, and large; Shift+Tab cycles backwards.
- Local repositories enable Watch by default. File edits and Git index/ref changes trigger a debounced incremental rescan.
- Documentation and configuration files are included by default. The persistent Docs/config toolbar toggle hides or restores them and rescans immediately.

Only one fill layer is active at a time:

| Layer | Meaning |
| --- | --- |
| Type | Language/file type and code-node kind |
| Age | Time since code was last touched; function-level values arrive from background blame |
| Churn | Commits touching a node over 30 days, 90 days, one year, or all history |
| Hotspots | Normalised churn multiplied by cognitive complexity |
| Complexity | Cognitive complexity, shown as maximum or SLOC-weighted mean |
| Coverage | Covered lines from an existing report; missing data is hatched |

Pins for LLM and SQL detections and edges for imports or co-change can be enabled independently. Coupling edges can be filtered by confidence and shared commit count.

The Changes panel lets you select a commit or Shift-click a second commit for an inclusive range. Changed files and functions receive a static white outline over the current fill layer. Local uncommitted changes use a separate pulsing outline and include staged, unstaged, and untracked files.

For local repositories, Fetch updates remote-tracking refs with `git fetch --prune`; it does not modify the work tree, index, local branches, or `HEAD`. For a cloned remote, Rescan fetches and resets the managed clone to the selected remote branch.

## Coverage reports

codefront searches up to five directory levels for common report names and merges matching line data. Supported formats are:

- LCOV (`lcov.info`)
- Istanbul (`coverage-final.json`)
- Cobertura/pytest-cov (`coverage.xml`, `cobertura.xml`, `cobertura-coverage.xml`)
- JaCoCo (`jacoco.xml`)
- Go cover profiles (`cover.out`, `coverage.out`)

Tests are not run by codefront. Generate a report with your normal test command, then rescan.

## Remote repositories and authentication

Remote repositories are cloned with `--filter=blob:none` into the codefront data directory. Hooks are disabled, Git LFS smudging is skipped, interactive credential prompts are disabled, and repository code is not executed.

Authentication is attempted through the normal SSH or Git credential setup. For HTTPS, codefront can also use:

1. `gh auth token` for `github.com`
2. A personal access token stored in the operating-system keychain through the optional `keytar` dependency

Tokens injected by codefront are passed to Git in memory and are not written to repository configuration or logs.

## Cache and scan behaviour

By default, data is stored under `~/.codefront`:

```text
~/.codefront/
├── repos/<repo-id>/   # managed blobless clones
└── cache/<repo-id>/   # file analysis, history, blame, and latest snapshot
```

Set `CODEFRONT_HOME` to move that directory. Set `CODEFRONT_LITE_FILES` to change the large-repository threshold (default: 50,000 files); above it, sub-file detail is fetched lazily when a file is selected.

Scans respect nested `.gitignore` files and generated/vendored paths marked in `.gitattributes`. Documentation and configuration files are included by default; pass `showDocs: false`, use the UI toggle, or use headless `--no-docs` to hide them. Common dependency, build, cache, and VCS directories plus lockfiles, binaries, minified/generated files, and files larger than 1 MB are always excluded. Prompt files are still checked by the detector when documentation is hidden.

## Development

Run the API and web app in separate terminals:

```sh
# Fastify API at http://127.0.0.1:4317
pnpm dev:server -- /path/to/repository

# Vite app at http://localhost:5173; /api is proxied to port 4317
pnpm dev:web
```

Common workspace commands:

```sh
pnpm build       # build every package
pnpm test        # run every package's Vitest suite
pnpm start -- .  # run the built CLI against this repository
```

### Workspace layout

| Package | Responsibility |
| --- | --- |
| `@codefront/schema` | Zod schemas, snapshot types, and shared metric helpers |
| `@codefront/core` | Walking, parsing, SLOC, Git/history, cache, coverage, detectors, and coupling |
| `@codefront/server` | Fastify HTTP/WebSocket API, static UI, watch mode, and safe source access |
| `@codefront/web` | React/Vite UI and PixiJS treemap renderer |
| `codefront` | Publishable CLI bundle and headless scanner |

Workspace packages expose a `source` export condition so editors resolve types from `src/index.ts` without a rebuild. Production declaration files are emitted through each package's `tsconfig.build.json`.

## HTTP and WebSocket API

The server listens on `127.0.0.1` by default.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `POST` | `/api/scan` | Scan `{ path, showDocs?, coverageReport?, ref?, fetch? }` |
| `GET` | `/api/scan?path=...` | Query-string form of a scan |
| `GET` | `/api/cached?path=...&showDocs=...` | Return the compatible latest persisted snapshot without rescanning |
| `GET` | `/api/config` | Return the default target and keychain availability |
| `POST` | `/api/watch` | Enable or disable local watch mode with `{ root, on, showDocs? }` |
| `GET` | `/api/detail?root=...&path=...` | Lazily return file internals for a large snapshot |
| `GET` | `/api/file?root=...&path=...` | Read a file already present in the scanned snapshot |
| `GET` | `/api/branches?path=...` | List branches in a managed remote clone |
| `GET` | `/api/git/branches?root=...` | List branches for the Changes panel |
| `GET` | `/api/commits?root=...&branch=...` | Return paginated commit metadata |
| `GET` | `/api/diff?root=...&from=...&to=...` | Return file/function changes for a validated ref range |
| `GET` | `/api/git/remotes?root=...` | List configured remotes |
| `POST` | `/api/git/fetch?root=...` | Fetch and prune local-repository remote-tracking refs |
| `POST` | `/api/auth/pat` | Store `{ host, token }` in the OS keychain |
| `GET` | `/api/layers/age?path=...` | Retrieve blame-derived age values already computed |
| `WS` | `/api/progress` | Stream scan progress, partial/watch snapshots, and age-layer updates |

Snapshot responses conform to `SnapshotSchema` in `packages/schema/src/index.ts`.

## License

Licensed under the [MIT License](LICENSE).
