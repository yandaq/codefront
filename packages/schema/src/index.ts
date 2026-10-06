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
    children: z.array(TreeNodeSchema).optional(),
  }),
);

export const SnapshotSchema = z.object({
  version: z.literal(1),
  createdAt: z.string(),
  source: z.object({ type: z.literal('local'), path: z.string() }),
  stats: z.object({ files: z.number(), sloc: z.number(), parsedFiles: z.number(), durationMs: z.number() }),
  root: TreeNodeSchema,
  /** Git history; `available: false` for non-git directories. `commits` are epoch seconds, ascending. */
  git: z.object({ available: z.boolean(), commits: z.array(z.number()), head: z.string().optional() }).optional(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const ScanRequestSchema = z.object({ path: z.string().min(1), showDocs: z.boolean().optional() });
export type ScanRequest = z.infer<typeof ScanRequestSchema>;

export interface ScanProgress { stage: 'walk' | 'sloc' | 'parse' | 'git' | 'blame' | 'done'; done: number; total: number; root?: string }

/** Layer update pushed over /api/progress. `values` maps node id -> epoch seconds of last change. */
export interface LayerUpdate { type: 'layer'; layer: 'age'; root: string; values: Record<string, number>; done: number; total: number }
export type ProgressMessage = (ScanProgress & { type?: 'progress' }) | LayerUpdate;

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

/** Placeholder complexity proxy (SLOC) used by Hotspots until M3 cognitive complexity lands. Swap here. */
export function complexityProxy(n: TreeNode): number { return n.sloc; }
