import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import type { GitMetrics, TreeNode } from '@codefront/schema';

const exec = promisify(execFile);

export interface GitHistory {
  available: boolean;
  head?: string;
  /** Commit timestamps (epoch s), ascending. */
  commits: number[];
  /** Distinct author names; `commitAuthors[i]` indexes this for commit i. */
  authors: string[];
  commitAuthors: number[];
  files: Map<string, GitMetrics>;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', ['-c', 'core.quotepath=off', ...args], { cwd, maxBuffer: 1 << 30 });
  return stdout;
}

export async function isGitRepo(root: string): Promise<boolean> {
  try { return (await git(root, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

/** Resolve numstat rename notation (`a => b`, `dir/{a => b}/f`) to the new path. */
export function renameTarget(p: string): string {
  const brace = p.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
  if (brace) return (brace[1]! + brace[3]! + brace[4]!).replace(/\/\//g, '/');
  const plain = p.match(/^(.*) => (.*)$/);
  return plain ? plain[2]! : p;
}

export interface RawCommit { h: string; ts: number; author: string; files: [string, number][] }
/** Persistable raw history for incremental refresh: `head` is the last-seen HEAD. */
export interface RawHistory { head?: string; raw: RawCommit[] }

const LOG_ARGS = ['log', '--no-merges', '--numstat', '--relative', '--format=@@%H %ct %aN'];

export function parseLog(out: string): RawCommit[] {
  const raw: RawCommit[] = [];
  for (const line of out.split('\n')) {
    if (line.startsWith('@@')) {
      const [h, ts, ...au] = line.slice(2).split(' ');
      raw.push({ h: h!, ts: Number(ts), author: au.join(' '), files: [] });
    } else if (line && raw.length) {
      const [a, d, ...rest] = line.split('\t');
      const p = renameTarget(rest.join('\t'));
      raw[raw.length - 1]!.files.push([p, (Number(a) || 0) + (Number(d) || 0)]); // binary files report '-'
    }
  }
  return raw.reverse(); // git log is newest-first; keep chronological order (stable for equal timestamps)
}

export function buildHistory(raw: RawCommit[], head?: string): GitHistory {
  raw = [...raw].sort((x, y) => x.ts - y.ts);
  const files = new Map<string, GitMetrics>();
  raw.forEach((c, i) => {
    for (const [p, l] of c.files) {
      let m = files.get(p);
      if (!m) files.set(p, (m = { last: 0, c: [], l: [] }));
      m.c.push(i); m.l.push(l); m.last = Math.max(m.last, c.ts);
    }
  });
  const aix = new Map<string, number>();
  const commitAuthors = raw.map((c) => { let i = aix.get(c.author); if (i == null) aix.set(c.author, (i = aix.size)); return i; });
  return { available: true, head, commits: raw.map((c) => c.ts), authors: [...aix.keys()], commitAuthors, files };
}

/**
 * Ingest `git log --numstat` for the scan root (paths relative to it). Non-git dirs return available:false.
 * With `prev`, only commits since the last-seen HEAD are read (full recompute if HEAD isn't a descendant).
 */
export async function readHistory(root: string, prev?: RawHistory): Promise<GitHistory & { rawHistory: RawHistory; mode: 'full' | 'incremental' | 'unchanged' }> {
  const none = { available: false, commits: [], authors: [], commitAuthors: [], files: new Map(), rawHistory: { raw: [] }, mode: 'full' as const };
  if (!(await isGitRepo(root))) return none;
  let head: string;
  try { head = (await git(root, ['rev-parse', 'HEAD'])).trim(); }
  catch { return { ...none, available: true }; } // e.g. no commits yet
  let raw: RawCommit[], mode: 'full' | 'incremental' | 'unchanged' = 'full';
  if (prev?.head === head) { raw = prev.raw; mode = 'unchanged'; }
  else if (prev?.head && (await isAncestor(root, prev.head, head))) {
    raw = [...prev.raw, ...parseLog(await git(root, [...LOG_ARGS, `${prev.head}..${head}`, '--', '.']))];
    mode = 'incremental';
  } else raw = parseLog(await git(root, [...LOG_ARGS, head, '--', '.']));
  return { ...buildHistory(raw, head), rawHistory: { head, raw }, mode };
}

async function isAncestor(root: string, a: string, b: string): Promise<boolean> {
  try { await exec('git', ['merge-base', '--is-ancestor', a, b], { cwd: root }); return true; } catch { return false; }
}

/**
 * Content id per file: git blob SHA from `git ls-files -s` for clean tracked files;
 * dirty/untracked files (and non-git dirs) get `c:<sha1 of content>` computed by the caller (returns undefined).
 */
export async function blobShas(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!(await isGitRepo(root))) return out;
  try {
    const ls = await git(root, ['ls-files', '-s', '-z']);
    for (const rec of ls.split('\0')) {
      const m = rec.match(/^\d+ ([0-9a-f]+) \d\t(.*)$/s);
      if (m) out.set(m[2]!, m[1]!);
    }
    const dirty = await git(root, ['ls-files', '-m', '-z']);
    for (const p of dirty.split('\0')) if (p) out.delete(p);
  } catch { /* ignore */ }
  return out;
}

function merge(a: GitMetrics, b: GitMetrics): GitMetrics {
  const c: number[] = [], l: number[] = [];
  let i = 0, j = 0;
  while (i < a.c.length || j < b.c.length) {
    const x = a.c[i] ?? Infinity, y = b.c[j] ?? Infinity;
    if (x === y) { c.push(x); l.push(a.l[i++]! + b.l[j++]!); }
    else if (x < y) { c.push(x); l.push(a.l[i++]!); }
    else { c.push(y); l.push(b.l[j++]!); }
  }
  return { last: Math.max(a.last, b.last), c, l };
}

/** Attach file metrics and aggregate folders (union of commits, max last-change). */
export function applyHistory(node: TreeNode, h: GitHistory): GitMetrics | undefined {
  if (node.kind === 'file') {
    const m = h.files.get(node.path);
    if (m) node.git = m;
    return m;
  }
  if (node.kind !== 'folder') return undefined;
  let acc: GitMetrics | undefined;
  for (const c of node.children ?? []) {
    const m = applyHistory(c, h);
    if (m) acc = acc ? merge(acc, m) : m;
  }
  if (acc) node.git = acc;
  return acc;
}

/** Per-line committer time from `git blame --line-porcelain` (index = line-1). */
export async function blameLines(root: string, rel: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const p = spawn('git', ['blame', '--line-porcelain', '--', rel], { cwd: root });
    let buf = '';
    const times: number[] = [];
    let cur = 0;
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (d: string) => {
      buf += d;
      let k: number;
      while ((k = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, k); buf = buf.slice(k + 1);
        if (line.startsWith('committer-time ')) cur = Number(line.slice(15));
        else if (line.startsWith('\t')) times.push(cur);
      }
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(times) : reject(new Error(`blame exit ${code}`))));
  });
}

/** Last-change time for every sub-file node with a line range, from blame. */
export function functionAges(file: TreeNode, times: number[], out: Record<string, number> = {}): Record<string, number> {
  const visit = (n: TreeNode) => {
    if (n.startLine && n.endLine) {
      let m = 0;
      for (let l = n.startLine - 1; l < n.endLine && l < times.length; l++) m = Math.max(m, times[l]!);
      if (m) out[n.id] = m;
    }
    n.children?.forEach(visit);
    if (n.kind === 'small-group' && n.children) {
      const m = Math.max(0, ...n.children.map((c) => out[c.id] ?? 0));
      if (m) out[n.id] = m;
    }
  };
  file.children?.forEach(visit);
  return out;
}

/** Background blame over all parsed files with bounded concurrency; reports batches of node ages. */
export interface BlameCache { get(file: TreeNode): Record<string, number> | undefined; set(file: TreeNode, v: Record<string, number>): void }

export async function blameTree(root: string, tree: TreeNode, onBatch: (values: Record<string, number>, done: number, total: number) => void, concurrency = 4, cache?: BlameCache): Promise<void> {
  const files: TreeNode[] = [];
  const collect = (n: TreeNode) => { if (n.kind === 'file') { if (n.children?.length && n.git) files.push(n); } else n.children?.forEach(collect); };
  collect(tree);
  let next = 0, done = 0;
  let pending: Record<string, number> = {};
  let lastFlush = Date.now();
  const flush = (force = false) => {
    if (!force && Date.now() - lastFlush < 250) return;
    onBatch(pending, done, files.length); pending = {}; lastFlush = Date.now();
  };
  const worker = async () => {
    while (next < files.length) {
      const f = files[next++]!;
      const hit = cache?.get(f);
      if (hit) Object.assign(pending, hit);
      else try { const v = functionAges(f, await blameLines(root, f.path)); cache?.set(f, v); Object.assign(pending, v); } catch { /* untracked etc. */ }
      done++;
      flush();
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, worker));
  flush(true);
}
