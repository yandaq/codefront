import { scaleSequentialLog } from 'd3-scale';
import { interpolateCool, interpolateMagma, interpolateInferno } from 'd3-scale-chromatic';
import { churnFor, complexityOf, type ChurnWindow, type Snapshot, type TreeNode } from '@grim-repo/schema';

export type LayerId = 'type' | 'age' | 'churn' | 'hotspots' | 'complexity' | 'coverage';
export const LAYERS: { id: LayerId; label: string; git?: boolean }[] = [
  { id: 'type', label: 'Type' }, { id: 'age', label: 'Age', git: true }, { id: 'churn', label: 'Churn', git: true }, { id: 'hotspots', label: 'Hotspots', git: true },
  { id: 'complexity', label: 'Complexity' }, { id: 'coverage', label: 'Coverage' },
];
export interface CxOptions { mode: 'max' | 'mean'; absolute: boolean }

export interface Painter {
  /** Fill colour (0xRRGGBB) or null to use the default type colouring. */
  colour: (n: TreeNode) => number | null;
  glow: (n: TreeNode) => boolean;
  /** Human-readable value for the tooltip. */
  describe: (n: TreeNode) => string | null;
  /** Draw a hatched "no data" pattern over the tile. */
  hatch?: (n: TreeNode) => boolean;
}

const NO_DATA = 0x334155;
export const ageRamp = (t: number) => interpolateCool(0.72 - 0.72 * t); // fresh cyan-green -> ancient violet
export const churnRamp = (p: number) => interpolateMagma(0.12 + 0.86 * p);
export const hotRamp = (p: number) => interpolateInferno(0.1 + 0.88 * p);
// red -> amber -> green with monotonically rising luminance so it still reads for red/green colour-blindness
const RAG = [[0xb4, 0x1f, 0x2e], [0xe8, 0xa0, 0x2c], [0x5f, 0xd3, 0x8d]] as const;
export const ragRamp = (t: number) => {
  const x = Math.max(0, Math.min(1, t)) * 2, i = Math.min(1, Math.floor(x)), f = x - i;
  const c = RAG[i]!.map((v, k) => Math.round(v + (RAG[i + 1]![k]! - v) * f));
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
};
export const coverageRamp = ragRamp;
export const complexityRamp = (p: number) => ragRamp(1 - p);
export const cxAbsolute = (v: number) => (v <= 5 ? 0 : v <= 15 ? 0.5 : 1);

function hex(css: string): number {
  if (css.startsWith('#')) return parseInt(css.slice(1), 16);
  const m = css.match(/\d+/g)!.map(Number);
  return (m[0]! << 16) | (m[1]! << 8) | m[2]!;
}

/** Percentile rank function over a list of values (ties share the lower rank). */
export function percentiles(values: number[]): (v: number) => number {
  const s = [...values].sort((a, b) => a - b);
  return (v) => {
    if (s.length <= 1) return v > 0 ? 1 : 0;
    let lo = 0, hi = s.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (s[m]! < v) lo = m + 1; else hi = m; }
    return lo / (s.length - 1);
  };
}

const days = (secs: number, now: number) => Math.max(0, (now - secs) / 86400);
export const fmtAge = (d: number) => (d < 1 ? 'today' : d < 60 ? `${Math.round(d)}d ago` : d < 730 ? `${(d / 30.4).toFixed(0)}mo ago` : `${(d / 365).toFixed(1)}y ago`);

export function makePainter(layer: LayerId, snap: Snapshot, window: ChurnWindow, ages: Record<string, number>, cxo: CxOptions = { mode: 'max', absolute: false }, now = Date.now() / 1000): Painter {
  const none: Painter = { colour: () => null, glow: () => false, describe: () => null };
  if (layer === 'type') return none;
  if (layer === 'coverage') {
    const has = (n: TreeNode) => n.cov != null && n.kind !== 'module-scope';
    return {
      colour: (n) => (has(n) ? hex(coverageRamp(n.cov!)) : 0x2a3240),
      hatch: (n) => !has(n) && n.kind !== 'module-scope',
      glow: () => false,
      describe: (n) => (has(n) ? `${(n.cov! * 100).toFixed(1)}% lines covered` : 'no coverage data'),
    };
  }
  if (layer === 'complexity') {
    const val = (n: TreeNode) => (n.kind === 'function' || cxo.mode === 'max' ? n.cx : n.cxMean);
    const all: TreeNode[] = [];
    const rec = (n: TreeNode) => { all.push(n); n.children?.forEach(rec); };
    rec(snap.root);
    const groups: Record<string, number[]> = {};
    const g = (n: TreeNode) => (n.kind === 'folder' ? 'folder' : n.kind === 'file' ? 'file' : 'sub');
    for (const n of all) { const v = val(n); if (v != null) (groups[g(n)] ??= []).push(v); }
    const pct = Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, percentiles(v)]));
    const t = (n: TreeNode, v: number) => (cxo.absolute ? cxAbsolute(v) : pct[g(n)]!(v));
    return {
      colour: (n) => { const v = val(n); return v == null ? NO_DATA : hex(complexityRamp(t(n, v))); },
      glow: () => false,
      describe: (n) => { const v = val(n); return v == null ? 'n/a' : `${cxo.mode === 'mean' && n.kind !== 'function' ? 'mean' : n.kind === 'function' ? 'cognitive' : 'max'} ${Number.isInteger(v) ? v : v.toFixed(1)}${cxo.absolute ? '' : ` · p${Math.round(pct[g(n)]!(v) * 100)}`}`; },
    };
  }
  const commits = snap.git?.commits ?? [];
  if (!snap.git?.available) return { colour: () => NO_DATA, glow: () => false, describe: () => 'no git data' };

  // parent file lookup so sub-file nodes inherit file-level git data
  const fileOf = new Map<string, TreeNode>();
  const all: TreeNode[] = [];
  const walk = (n: TreeNode, file?: TreeNode) => {
    const f = n.kind === 'file' ? n : file;
    if (f) fileOf.set(n.id, f);
    all.push(n);
    n.children?.forEach((c) => walk(c, f));
  };
  walk(snap.root);
  const gitOf = (n: TreeNode) => n.git ?? fileOf.get(n.id)?.git;

  if (layer === 'age') {
    const scale = scaleSequentialLog([1, 730], (t) => t).clamp(true);
    const lastOf = (n: TreeNode) => ages[n.id] ?? gitOf(n)?.last;
    return {
      colour: (n) => { const l = lastOf(n); return l == null ? NO_DATA : hex(ageRamp(scale(Math.max(1, days(l, now))))); },
      glow: () => false,
      describe: (n) => { const l = lastOf(n); return l == null ? 'untracked' : `${fmtAge(days(l, now))}${ages[n.id] ? ' (blame)' : ''}`; },
    };
  }

  const churn = new Map<TreeNode, { commits: number; lines: number }>();
  for (const n of all) churn.set(n, churnFor(gitOf(n), commits, window, now));
  const group = (n: TreeNode) => (n.kind === 'folder' ? 'folder' : n.kind === 'file' ? 'file' : 'sub');
  const byGroup = (f: (n: TreeNode) => number) => {
    const g: Record<string, number[]> = { folder: [], file: [], sub: [] };
    for (const n of all) g[group(n)]!.push(f(n));
    const p = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, percentiles(v)]));
    const max = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Math.max(1e-9, ...v)]));
    return { pct: (n: TreeNode, v: number) => p[group(n)]!(v), max: (n: TreeNode) => max[group(n)]! };
  };

  if (layer === 'churn') {
    const r = byGroup((n) => churn.get(n)!.commits);
    return {
      colour: (n) => { const c = churn.get(n)!.commits; return c === 0 ? 0x1e1b2e : hex(churnRamp(r.pct(n, c))); },
      glow: () => false,
      describe: (n) => { const c = churn.get(n)!; return `${c.commits} commits · ${c.lines.toLocaleString()} lines (${window})`; },
    };
  }

  // Hotspots = normalised churn × normalised cognitive complexity.
  const cr = byGroup((n) => churn.get(n)!.commits);
  const xr = byGroup((n) => complexityOf(n));
  const score = new Map<TreeNode, number>();
  for (const n of all) score.set(n, (churn.get(n)!.commits / cr.max(n)) * (complexityOf(n) / xr.max(n)));
  const hr = byGroup((n) => score.get(n)!);
  return {
    colour: (n) => { const s = score.get(n)!; return s === 0 ? 0x1a1625 : hex(hotRamp(hr.pct(n, s))); },
    glow: (n) => { const s = score.get(n)!; return s > 0 && hr.pct(n, s) >= 0.95; },
    describe: (n) => { const s = score.get(n)!; return `score ${s.toFixed(3)} · p${Math.round(hr.pct(n, s) * 100)}`; },
  };
}

/** CSS gradient stops for a legend. */
export function legendGradient(layer: LayerId): string {
  const ramp = layer === 'age' ? ageRamp : layer === 'churn' ? churnRamp : layer === 'coverage' ? coverageRamp : layer === 'complexity' ? complexityRamp : hotRamp;
  return `linear-gradient(90deg, ${Array.from({ length: 9 }, (_, i) => ramp(i / 8)).join(', ')})`;
}

export interface HitCounts { llm: number; sql: number }
/** Per-node hit counts keyed by node id (direct hits only; Treemap aggregates when zoomed out). */
export function hitCounts(snap: Snapshot): Map<string, HitCounts> {
  const m = new Map<string, HitCounts>();
  for (const h of snap.hits ?? []) {
    if (h.nodeId == null) continue;
    const c = m.get(h.nodeId) ?? { llm: 0, sql: 0 };
    c[h.kind]++;
    m.set(h.nodeId, c);
  }
  return m;
}
