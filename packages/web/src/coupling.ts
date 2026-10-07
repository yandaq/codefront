import type { Snapshot, TreeNode } from '@codefront/schema';

export interface CouplingOptions { on: boolean; mode: 'imports' | 'cochange'; minConf: number; minCommits: number }
/** File-level edge (paths); directed for imports. */
export interface Edge { a: string; b: string; w: number }

export function couplingEdges(s: Snapshot, o: CouplingOptions): Edge[] {
  const c = s.coupling;
  if (!c || !o.on) return [];
  if (o.mode === 'imports') return c.imports.map(([a, b, w]) => ({ a: c.files[a]!, b: c.files[b]!, w }));
  return c.cochange.filter(([, , n, conf]) => n >= o.minCommits && conf * 100 >= o.minConf).map(([a, b, n, conf]) => ({ a: c.files[a]!, b: c.files[b]!, w: n * conf }));
}

const inside = (n: TreeNode, p: string) => n.kind === 'folder' ? n.id === '' || p === n.path || p.startsWith(n.path + '/') : p === n.path;

/** Tooltip stats: import statements in/out across the node boundary and top co-change partner. */
export function couplingStats(s: Snapshot, n: TreeNode) {
  const c = s.coupling;
  if (!c) return null;
  if (n.kind !== 'folder') n = { ...n, kind: 'file' }; // functions/classes report their file's coupling
  const ins = c.files.map((f) => inside(n, f));
  let inc = 0, out = 0;
  for (const [a, b, w] of c.imports) { if (ins[a] && !ins[b]) out += w; else if (!ins[a] && ins[b]) inc += w; }
  let top: { path: string; conf: number; n: number } | null = null;
  for (const [a, b, k, conf] of c.cochange) {
    if (ins[a] === ins[b]) continue;
    const other = ins[a] ? b : a;
    if (!top || conf > top.conf || (conf === top.conf && k > top.n)) top = { path: c.files[other]!, conf, n: k };
  }
  return { inc, out, top };
}
