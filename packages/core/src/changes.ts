import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TreeNode } from '@grim-repo/schema';
import { listBranches } from './remote.js';

const exec = promisify(execFile);
/** git's well-known empty tree: the "parent" of a root commit. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 1 << 30 });
  return stdout;
}

/** Syntactic check for a sha or ref name (no options, no range/revision syntax). */
export function refShapeOk(ref: string): boolean {
  if (!ref || ref.length > 200 || ref.startsWith('-') || ref.includes('..') || ref.includes('@{') || ref.endsWith('.lock') || ref.endsWith('/')) return false;
  return /^[A-Za-z0-9._/-]+$/.test(ref);
}

/** Resolve a sha or existing ref name to a full commit sha; throws on anything else. */
export async function resolveRef(root: string, ref: string): Promise<string> {
  if (ref === EMPTY_TREE) return ref;
  if (!refShapeOk(ref)) throw new Error(`invalid ref: ${ref}`);
  try { return (await git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])).trim(); }
  catch { throw new Error(`unknown ref: ${ref}`); }
}

export interface GitBranches { git: boolean; branches: string[]; current: string | null; remotes: string[] }
/** Local branches (current first default); for clones of remotes, the remote's branches (as the M6 picker lists them). */
export async function gitBranches(root: string, remote = false): Promise<GitBranches> {
  try { await git(root, ['rev-parse', '--is-inside-work-tree']); } catch { return { git: false, branches: [], current: null, remotes: [] }; }
  let current: string | null = null;
  try { current = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim(); if (current === 'HEAD') current = null; } catch { /* no commits */ }
  let branches: string[] = [];
  if (remote) { try { branches = (await listBranches(root)).map((b) => (b === current ? b : `origin/${b}`)); } catch { /* none */ } }
  const local = (await git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).catch(() => '')).split('\n').filter(Boolean);
  // Local repos: remote-tracking branches (origin/*) too, so fetched history can be browsed.
  if (!remote) branches = (await git(root, ['for-each-ref', '--format=%(refname)', 'refs/remotes']).catch(() => '')).split('\n')
    .filter((l) => l && !l.endsWith('/HEAD')).map((l) => l.replace(/^refs\/remotes\//, ''));
  const remotes = (await git(root, ['remote']).catch(() => '')).split('\n').map((s) => s.trim()).filter(Boolean);
  branches = [...new Set([...local, ...branches])];
  if (current && !branches.includes(current)) branches.unshift(current);
  return { git: true, branches, current, remotes };
}

export interface CommitInfo { sha: string; parents: string[]; subject: string; author: string; date: number; added: number; deleted: number }

export async function listCommits(root: string, branch: string, offset = 0, limit = 100): Promise<CommitInfo[]> {
  const sha = await resolveRef(root, branch);
  const out = await git(root, ['log', '--numstat', '--relative', '--format=%x1e%H%x1f%P%x1f%aN%x1f%ct%x1f%s', `--skip=${Math.max(0, offset | 0)}`, `-n${Math.min(500, Math.max(1, limit | 0))}`, sha, '--', '.']);
  const res: CommitInfo[] = [];
  for (const rec of out.split('\x1e')) {
    if (!rec.trim()) continue;
    const [head, ...rest] = rec.split('\n');
    const [h, p, au, ct, ...subj] = head!.split('\x1f');
    let added = 0, deleted = 0;
    for (const l of rest) { const [a, d] = l.split('\t'); if (d != null) { added += Number(a) || 0; deleted += Number(d) || 0; } }
    res.push({ sha: h!, parents: p ? p.split(' ') : [], author: au!, date: Number(ct), subject: subj.join('\x1f'), added, deleted });
  }
  return res;
}

/** [oldStart, oldCount, newStart, newCount] as in `@@ -os,oc +ns,nc @@`. */
export type Hunk = [number, number, number, number];
export interface FilePatch { path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R'; added: number; deleted: number; hunks: Hunk[] }

const unq = (s: string) => (s.startsWith('"') ? JSON.parse(s) as string : s);
const strip = (s: string, pre: string) => { s = unq(s.trim()); return s.startsWith(pre) ? s.slice(pre.length) : s; };

/** Parse `git diff --unified=0` output into per-file patches. */
export function parseDiff(out: string): FilePatch[] {
  const files: FilePatch[] = [];
  let f: FilePatch | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"?a\/)(.*?)"? (?:"?b\/)(.*?)"?$/);
      f = { path: m?.[2] ?? '', status: 'M', added: 0, deleted: 0, hunks: [] };
      files.push(f);
    } else if (!f) continue;
    else if (line.startsWith('new file mode')) f.status = 'A';
    else if (line.startsWith('deleted file mode')) { f.status = 'D'; }
    else if (line.startsWith('rename from ')) { f.oldPath = unq(line.slice(12)); f.status = 'R'; }
    else if (line.startsWith('rename to ')) f.path = unq(line.slice(10));
    else if (line.startsWith('--- ')) { if (line !== '--- /dev/null' && f.status !== 'R') f.oldPath = undefined; if (f.status === 'D') f.path = strip(line.slice(4), 'a/'); }
    else if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') f.path = strip(line.slice(4), 'b/'); }
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const h: Hunk = [Number(m[1]), m[2] == null ? 1 : Number(m[2]), Number(m[3]), m[4] == null ? 1 : Number(m[4])];
      f.hunks.push(h); f.deleted += h[1]; f.added += h[3];
    }
  }
  return files;
}

/**
 * Map an old-side line through `-U0` hunks to the new side. Lines inside a changed/deleted region
 * map to the nearest surviving line (exact=false).
 */
export function mapLine(line: number, hunks: Hunk[]): { line: number; exact: boolean } {
  let delta = 0;
  for (const [os, oc, ns, nc] of hunks) {
    if (oc === 0) { if (line > os) delta += nc; else break; }
    else if (line >= os + oc) delta += nc - oc;
    else if (line >= os) return { line: Math.max(1, nc === 0 ? ns : ns + Math.min(line - os, nc - 1)), exact: false };
    else break;
  }
  return { line: line + delta, exact: true };
}

export interface NodeChange { a: number; d: number; s: 'A' | 'M' }
export interface DiffFile extends FilePatch { /** Path in the current snapshot (after later renames), null if not on the map. */ mapPath: string | null; fns: { id: string; name: string; a: number; d: number; s: 'A' | 'M' }[] }
export interface DiffResult { from: string; to: string; commits: number; files: DiffFile[]; nodes: Record<string, NodeChange>; touched: Record<string, string[]> }

/** Deepest node with a line range containing `line`. */
function fnAt(file: TreeNode, line: number): TreeNode | null {
  let best: TreeNode | null = null;
  const visit = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.kind === 'small-group') { visit(c); continue; }
      if (c.startLine != null && c.endLine != null && c.startLine <= line && line <= c.endLine) { best = c; visit(c); return; }
    }
  };
  visit(file);
  return best;
}

/**
 * Diff `from..to` (paths relative to the scan root), attributing changed lines to the snapshot's
 * functions. `to`-side lines are translated to the work tree (the scanned snapshot) via `git diff -U0 to`.
 */
export async function diffRange(root: string, fromRef: string, toRef: string, findFile: (rel: string) => TreeNode | null): Promise<DiffResult> {
  const from = await resolveRef(root, fromRef), to = await resolveRef(root, toRef);
  const base = ['diff', '--unified=0', '-M', '--relative', '--no-color', '--no-ext-diff'];
  const [patches, later, log] = await Promise.all([
    git(root, [...base, from, to, '--', '.']).then(parseDiff),
    git(root, [...base, to, '--', '.']).then(parseDiff), // to -> work tree
    git(root, ['log', '--format=@@%H', '--name-only', '--relative', '-M', ...(from === EMPTY_TREE ? [to] : [`${from}..${to}`]), '--', '.']),
  ]);
  const touched: Record<string, string[]> = {};
  let commits = 0, cur = '';
  for (const l of log.split('\n')) {
    if (l.startsWith('@@')) { cur = l.slice(2); commits++; } else if (l) (touched[l] ??= []).push(cur);
  }
  const laterBy = new Map(later.map((p) => [p.oldPath ?? p.path, p]));
  const nodes: Record<string, NodeChange> = {};
  const files: DiffFile[] = patches.map((p) => {
    const lp = p.status === 'D' ? undefined : laterBy.get(p.path);
    const mapPath = p.status === 'D' || lp?.status === 'D' ? null : lp?.status === 'R' ? lp.path : p.path;
    const file = mapPath ? findFile(mapPath) : null;
    const res: DiffFile = { ...p, mapPath: file ? mapPath : null, fns: [] };
    if (!file) return res;
    nodes[file.id] = { a: p.added, d: p.deleted, s: p.status === 'A' ? 'A' : 'M' };
    const h2 = lp?.hunks ?? [];
    const per = new Map<TreeNode, { a: number; d: number }>();
    const bump = (n: TreeNode | null, k: 'a' | 'd', v: number) => { if (!n) return; const e = per.get(n) ?? { a: 0, d: 0 }; e[k] += v; per.set(n, e); };
    for (const [, oc, ns, nc] of p.hunks) {
      for (let l = ns; l < ns + nc; l++) bump(fnAt(file, mapLine(l, h2).line), 'a', 1);
      if (oc) bump(fnAt(file, mapLine(Math.max(1, ns), h2).line), 'd', oc);
    }
    for (const [n, e] of per) {
      const span = (n.endLine ?? 0) - (n.startLine ?? 0) + 1;
      const s = p.status === 'A' || (e.d === 0 && e.a >= span) ? 'A' : 'M';
      nodes[n.id] = { ...e, s };
      res.fns.push({ id: n.id, name: n.name, ...e, s });
    }
    res.fns.sort((x, y) => y.a + y.d - x.a - x.d);
    return res;
  });
  return { from, to, commits, files, nodes, touched };
}
