import { churnFor, complexityOf, type ChurnWindow, type Snapshot, type TreeNode } from '@codefront/schema';
import { fmtAge, percentiles } from './layers';

export interface MetricRow { label: string; value: string; pct: number | null }
export interface Index { byId: Map<string, TreeNode>; parent: Map<string, TreeNode>; fileOf: Map<string, TreeNode>; all: TreeNode[] }

export function indexTree(root: TreeNode): Index {
  const byId = new Map<string, TreeNode>(), parent = new Map<string, TreeNode>(), fileOf = new Map<string, TreeNode>(), all: TreeNode[] = [];
  const walk = (n: TreeNode, p?: TreeNode, f?: TreeNode) => {
    byId.set(n.id, n); all.push(n);
    if (p) parent.set(n.id, p);
    const ff = n.kind === 'file' ? n : f;
    if (ff) fileOf.set(n.id, ff);
    n.children?.forEach((c) => walk(c, n, ff));
  };
  walk(root);
  return { byId, parent, fileOf, all };
}

const group = (n: TreeNode) => (n.kind === 'folder' ? 'folder' : n.kind === 'file' ? 'file' : 'sub');

/** Inspector rows: every layer value with a repo percentile among nodes of the same kind group. */
export function metricRows(snap: Snapshot, ix: Index, win: ChurnWindow, ages: Record<string, number>, now = Date.now() / 1000) {
  const gitOf = (n: TreeNode) => n.git ?? ix.fileOf.get(n.id)?.git;
  const commits = snap.git?.commits ?? [];
  const hasGit = !!snap.git?.available;
  const age = (n: TreeNode) => { const l = ages[n.id] ?? gitOf(n)?.last; return l == null ? null : Math.max(0, (now - l) / 86400); };
  const churn = (n: TreeNode) => churnFor(gitOf(n), commits, win, now).commits;
  const cx = (n: TreeNode) => (n.kind === 'module-scope' ? null : n.cx ?? null);
  const cov = (n: TreeNode) => n.cov ?? null;
  const groups: Record<string, TreeNode[]> = { folder: [], file: [], sub: [] };
  for (const n of ix.all) groups[group(n)]!.push(n);
  const maxOf = (f: (n: TreeNode) => number) => Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, Math.max(1e-9, ...v.map(f))]));
  const cmax = maxOf(churn), xmax = maxOf(complexityOf);
  const hot = (n: TreeNode) => (churn(n) / cmax[group(n)]!) * (complexityOf(n) / xmax[group(n)]!);
  const ranks = (f: (n: TreeNode) => number | null) =>
    Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, percentiles(v.map(f).filter((x): x is number => x != null))]));
  const R = { age: ranks(age), churn: ranks(churn), cx: ranks(cx), cov: ranks(cov), hot: ranks(hot) };
  return (n: TreeNode): MetricRow[] => {
    const g = group(n);
    const rows: MetricRow[] = [];
    if (hasGit) {
      const a = age(n);
      rows.push({ label: 'Age', value: a == null ? 'untracked' : fmtAge(a), pct: a == null ? null : R.age[g]!(a) });
      const c = churnFor(gitOf(n), commits, win, now);
      rows.push({ label: `Churn ${win}`, value: `${c.commits} commits · ${c.lines.toLocaleString()} lines`, pct: R.churn[g]!(c.commits) });
    }
    const x = cx(n);
    rows.push({ label: 'Complexity', value: x == null ? 'n/a' : `${n.kind === 'function' ? '' : 'max '}${x}${n.cxMean != null ? ` · mean ${n.cxMean.toFixed(1)}` : ''}`, pct: x == null ? null : R.cx[g]!(x) });
    const v = cov(n);
    rows.push({ label: 'Coverage', value: v == null ? 'no data' : `${(v * 100).toFixed(1)}%`, pct: v == null ? null : R.cov[g]!(v) });
    if (hasGit) { const h = hot(n); rows.push({ label: 'Hotspot', value: h.toFixed(3), pct: R.hot[g]!(h) }); }
    return rows;
  };
}
