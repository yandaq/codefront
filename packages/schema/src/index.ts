import { z } from 'zod';

export const NodeKind = z.enum(['folder', 'file', 'class', 'function', 'module-scope', 'small-group']);
export type NodeKind = z.infer<typeof NodeKind>;

export interface TreeNode {
  id: string;
  name: string;
  kind: NodeKind;
  path: string;
  sloc: number;
  language?: string;
  startLine?: number;
  endLine?: number;
  /** Git metrics (files and aggregated folders). */
  git?: GitMetrics;
  /** Cognitive complexity: functions = own score; classes/files/folders = max over functions. */
  cx?: number;
  /** SLOC-weighted mean cognitive complexity over descendant functions (non-function nodes). */
  cxMean?: number;
  /** Fraction (0..1) of instrumented lines covered; undefined = no coverage data. */
  cov?: number;
  /** Files: content id (git blob SHA, or `c:<sha1>` for dirty/untracked) — used for rescan diffs. */
  hash?: string;
  children?: TreeNode[];
}

/**
 * Compact per-node git data. `c` holds indices into `Snapshot.git.commits` (sorted ascending by time),
 * `l` the parallel line churn (added+deleted) per commit. Folders hold the union of their descendants.
 */
export interface GitMetrics { last: number; c: number[]; l: number[] }
export const GitMetricsSchema = z.object({ last: z.number(), c: z.array(z.number().int()), l: z.array(z.number().int()) });


export const TreeNodeSchema: z.ZodType<TreeNode> = z.lazy(() =>
  z.object({
    id: z.string(),
    name: z.string(),
    kind: NodeKind,
    path: z.string(),
    sloc: z.number().int().nonnegative(),
    language: z.string().optional(),
    startLine: z.number().int().optional(),
    endLine: z.number().int().optional(),
    git: GitMetricsSchema.optional(),
    cx: z.number().optional(),
    cxMean: z.number().optional(),
    cov: z.number().optional(),
    hash: z.string().optional(),
    children: z.array(TreeNodeSchema).optional(),
  }),
);

export const SqlInfoSchema = z.object({ style: z.enum(['raw', 'orm']), op: z.enum(['read', 'write']), tables: z.array(z.string()) });
export const HitSchema = z.object({
  kind: z.enum(['llm', 'sql']),
  rule: z.string(),
  file: z.string(),
  startLine: z.number().int(),
  endLine: z.number().int(),
  confidence: z.number(),
  snippet: z.string(),
  /** Innermost tree node containing the hit (function/class/file, or nearest folder for hidden files). */
  nodeId: z.string().optional(),
  sql: SqlInfoSchema.optional(),
});
export type Hit = z.infer<typeof HitSchema>;

/** Per-file coverage: line ranges encoded as "1-5,7,9-12" (1-based). */
export const FileCoverageSchema = z.object({ covered: z.string(), uncovered: z.string() });
export type FileCoverage = z.infer<typeof FileCoverageSchema>;
export const CoverageSchema = z.object({ available: z.boolean(), reports: z.array(z.string()), files: z.record(FileCoverageSchema) });
export type Coverage = z.infer<typeof CoverageSchema>;

export function encodeRanges(lines: number[]): string {
  const s = [...new Set(lines)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}
export function decodeRanges(r: string): number[] {
  const out: number[] = [];
  for (const part of r.split(',')) {
    if (!part) continue;
    const [a, b] = part.split('-').map(Number);
    for (let l = a!; l <= (b ?? a!); l++) out.push(l);
  }
  return out;
}

/**
 * Coupling data. `files` is a path table; edges reference it by index.
 * imports: directed [from, to, importStatements]; cochange: [a, b, sharedCommits, confidence 0..1] (shared ≥ 2, bulk commits > 50 files skipped).
 */
export const CouplingSchema = z.object({
  files: z.array(z.string()),
  imports: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int()])),
  cochange: z.array(z.tuple([z.number().int(), z.number().int(), z.number().int(), z.number()])),
  /** Unresolved / external import statements per file path. */
  unresolved: z.record(z.number().int()),
});
export type Coupling = z.infer<typeof CouplingSchema>;

export const SnapshotSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  source: z.object({ type: z.enum(['local', 'remote']), path: z.string(),
    /** Clone URL for remote scans. */
    url: z.string().optional(),
    /** Web URL of the hosting repo (GitHub/GitLab) for remote scans (M6); when set, "open" links go to the host. */
    webUrl: z.string().optional(), ref: z.string().optional() }),
  stats: z.object({ files: z.number(), sloc: z.number(), parsedFiles: z.number(), durationMs: z.number(),
    /** Per-file analysis cache hits/misses for this scan. */
    cacheHits: z.number().optional(), cacheMisses: z.number().optional(),
    /** Large repo: file children stripped; fetch per-file detail lazily via /api/detail. */
    lite: z.boolean().optional() }),
  root: TreeNodeSchema,
  /** Git history; `available: false` for non-git directories. `commits` are epoch seconds, ascending. */
  git: z.object({ available: z.boolean(), commits: z.array(z.number()), head: z.string().optional(),
    /** Author name table and per-commit author index (parallel to `commits`). */
    authors: z.array(z.string()).optional(), commitAuthors: z.array(z.number().int()).optional() }).optional(),
  coverage: CoverageSchema.optional(),
  hits: z.array(HitSchema).optional(),
  coupling: CouplingSchema.optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ScanRequestSchema = z.object({ path: z.string().min(1), showDocs: z.boolean().optional(), coverageReport: z.string().optional(),
  /** Remote repos: branch to check out. */
  ref: z.string().optional(),
  /** Remote repos: `git fetch` + reset to origin/<branch> before scanning (rescan). */
  fetch: z.boolean().optional() });
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export const STAGES = ['clone', 'walk', 'sloc', 'git', 'parse', 'detect', 'coverage', 'blame'] as const;
export type Stage = (typeof STAGES)[number];
export interface ScanProgress { stage: Stage | 'done'; done: number; total: number; root?: string; message?: string }

/** Layer update pushed over /api/progress. `values` maps node id -> epoch seconds of last change. */
export interface LayerUpdate { type: 'layer'; layer: 'age'; root: string; values: Record<string, number>; done: number; total: number }
/** A (partial or refreshed) snapshot pushed to clients: progressive render, watch-mode rescans. */
export interface SnapshotUpdate { type: 'snapshot'; root: string; partial?: boolean; snapshot: Snapshot }
export type ProgressMessage = (ScanProgress & { type?: 'progress' }) | LayerUpdate | SnapshotUpdate;

export const CHURN_WINDOWS = { '30d': 30, '90d': 90, '1y': 365, all: Infinity } as const;
export type ChurnWindow = keyof typeof CHURN_WINDOWS;

/** Commits (and line churn) touching a node within the window ending at `now` (epoch s). */
export function churnFor(g: GitMetrics | undefined, commits: number[], window: ChurnWindow, now: number): { commits: number; lines: number } {
  if (!g) return { commits: 0, lines: 0 };
  const since = now - CHURN_WINDOWS[window] * 86400;
  let n = 0, lines = 0;
  for (let i = 0; i < g.c.length; i++) if (commits[g.c[i]!]! >= since) { n++; lines += g.l[i]!; }
  return { commits: n, lines };
}

/** Complexity used by Hotspots: cognitive complexity (max over functions for aggregate nodes). */
export function complexityOf(n: TreeNode): number { return n.cx ?? 0; }

export interface Contributor { name: string; commits: number; lines: number; last: number }
/** Aggregate a node's commits by author, most commits first. */
export function contributors(g: GitMetrics | undefined, git: { commits: number[]; authors?: string[]; commitAuthors?: number[] } | undefined, top = 3): Contributor[] {
  if (!g || !git?.authors || !git.commitAuthors) return [];
  const m = new Map<number, Contributor>();
  g.c.forEach((ci, i) => {
    const a = git.commitAuthors![ci];
    if (a == null) return;
    let e = m.get(a);
    if (!e) m.set(a, (e = { name: git.authors![a] ?? '?', commits: 0, lines: 0, last: 0 }));
    e.commits++; e.lines += g.l[i] ?? 0; e.last = Math.max(e.last, git.commits[ci] ?? 0);
  });
  return [...m.values()].sort((a, b) => b.commits - a.commits || b.lines - a.lines || a.name.localeCompare(b.name)).slice(0, top);
}

/** Line link on a code host. Supports GitHub and GitLab (incl. self-hosted gitlab.*); returns null otherwise. */
export function hostLineUrl(webUrl: string, ref: string, path: string, line?: number, endLine?: number): string | null {
  let u: URL;
  try { u = new URL(webUrl.replace(/^git@([^:]+):/, 'https://$1/').replace(/\.git$/, '')); } catch { return null; }
  const base = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  const p = path.split('/').map(encodeURIComponent).join('/');
  const r = encodeURIComponent(ref);
  if (u.hostname === 'github.com' || u.hostname.startsWith('github.')) {
    const frag = line ? `#L${line}${endLine && endLine !== line ? `-L${endLine}` : ''}` : '';
    return `${base}/blob/${r}/${p}${frag}`;
  }
  if (u.hostname === 'gitlab.com' || u.hostname.startsWith('gitlab.')) {
    const frag = line ? `#L${line}${endLine && endLine !== line ? `-${endLine}` : ''}` : '';
    return `${base}/-/blob/${r}/${p}${frag}`;
  }
  return null;
}
