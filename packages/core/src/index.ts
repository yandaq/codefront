import path from 'node:path';
import { decodeRanges, type Snapshot, type TreeNode, type ScanProgress, type Hit, type Coverage } from '@grim-repo/schema';
import { walk, readTextFile } from './walk.js';
import { readHistory, applyHistory, blobShas } from './git.js';
import { detectFile, isPromptFile } from './detect.js';
import { ingestCoverage } from './coverage.js';
import { ImportResolver, importEdges, coChange } from './coupling.js';
import type { ImportRef } from './parse.js';
import { plainFile, type FileAnalysis } from './analyze.js';
import { analyzeAll, ParsePool } from './pool.js';
import { contentHash, type RepoCache } from './cache.js';

export { readHistory, applyHistory, blameTree, blameLines, functionAges, renameTarget, isGitRepo, parseLog, buildHistory, blobShas } from './git.js';
export type { RawHistory, RawCommit, BlameCache } from './git.js';

export { walk, ignoreFilter, readTextFile } from './walk.js';
export { codeLines, countSloc, fallbackComments } from './sloc.js';
export { parseSource, languageFor } from './parse.js';
export { cognitiveComplexity } from './complexity.js';
export * from './detect.js';
export * from './coverage.js';
export * from './coupling.js';
export { analyzeFile, plainFile, ANALYSIS_VERSION, type FileAnalysis } from './analyze.js';
export { ParsePool, analyzeAll, workerScript, defaultPoolSize } from './pool.js';
export { RepoCache, grimHome, localRepoId, contentHash, sha1 } from './cache.js';
export * from './remote.js';
export * from './repo.js';
export * from './changes.js';

export interface ScanOptions {
  showDocs?: boolean; coverageReport?: string; onProgress?: (p: ScanProgress) => void;
  /** Called with a file-level snapshot after walk + SLOC (progressive render), when anything needs parsing. */
  onPartial?: (s: Snapshot) => void;
  cache?: RepoCache;
  /** Worker threads for parsing: 0 = synchronous path; default = pool when the compiled worker is available. */
  workers?: number;
}

/** Build the folder tree from file nodes (sorted by path), summing and pruning empty nodes. */
function buildTree(rootName: string, nodes: TreeNode[]): TreeNode {
  const rootNode: TreeNode = { id: '', name: rootName, kind: 'folder', path: '', sloc: 0, children: [] };
  const folders = new Map<string, TreeNode>([['', rootNode]]);
  const folderFor = (rel: string): TreeNode => {
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    let f = folders.get(dir);
    if (f) return f;
    const parent = folderFor(dir);
    f = { id: dir, name: path.posix.basename(dir), kind: 'folder', path: dir, sloc: 0, children: [] };
    parent.children!.push(f);
    folders.set(dir, f);
    return f;
  };
  for (const n of nodes) if (n.sloc > 0) folderFor(n.path).children!.push(n);
  const sum = (n: TreeNode): number => {
    if (n.kind === 'folder') n.sloc = n.children!.reduce((a, c) => a + sum(c), 0);
    return n.sloc;
  };
  sum(rootNode);
  const prune = (n: TreeNode) => { if (n.children) { n.children = n.children.filter((c) => c.sloc > 0); n.children.forEach(prune); } };
  prune(rootNode);
  return rootNode;
}

export async function scan(rootPath: string, opts: ScanOptions = {}): Promise<Snapshot> {
  const t0 = Date.now();
  const root = path.resolve(rootPath);
  const progress = (stage: ScanProgress['stage'], done: number, total: number) => opts.onProgress?.({ stage, done, total });
  const files = await walk(root, { showDocs: opts.showDocs });
  progress('walk', files.length, files.length);
  // ---- content ids + cache lookup + SLOC ----
  const shas = await blobShas(root);
  const results = new Map<string, FileAnalysis>();
  const misses: { rel: string; text: string; hash: string }[] = [];
  const cache = opts.cache;
  let i = 0;
  for (const f of files) {
    i++;
    let hash = shas.get(f.rel);
    let text: string | null = null;
    if (!hash) { text = await readTextFile(f.abs).catch(() => null); if (text == null) continue; hash = contentHash(text); }
    const hit = cache?.getFile(f.rel, hash);
    if (hit) { hit.node.hash = hash; results.set(f.rel, hit); }
    else {
      text ??= await readTextFile(f.abs).catch(() => null);
      if (text == null) continue;
      misses.push({ rel: f.rel, text, hash });
      results.set(f.rel, { node: { ...plainFile(f.rel, text), hash }, hits: [], imports: [], parsed: false });
    }
    if (i % 200 === 0) progress('sloc', i, files.length);
  }
  progress('sloc', files.length, files.length);
  const rootName = path.basename(root);
  const order = files.map((f) => f.rel).filter((r) => results.has(r));
  if (misses.length && opts.onPartial) {
    const partial = buildTree(rootName, order.map((r) => structuredClone(results.get(r)!.node)));
    opts.onPartial({ version: 1, createdAt: new Date().toISOString(), source: { type: 'local', path: root },
      stats: { files: order.length, sloc: partial.sloc, parsedFiles: 0, durationMs: Date.now() - t0 }, root: partial });
  }
  // ---- git history (incremental from last-seen HEAD) ----
  const hist = await readHistory(root, cache?.history ?? undefined);
  if (cache) cache.history = hist.rawHistory;
  progress('git', hist.commits.length, hist.commits.length);
  // ---- parse (worker pool) ----
  const pool = misses.length >= 8 && opts.workers !== 0 ? ParsePool.create(opts.workers) : null;
  try {
    progress('parse', 0, misses.length);
    const analysed = await analyzeAll(misses, pool, (n) => { if (n % 25 === 0) progress('parse', n, misses.length); });
    misses.forEach((m, k) => { const a = analysed[k]!; cache?.setFile(m.rel, m.hash, a); a.node.hash = m.hash; results.set(m.rel, a); });
  } finally { await pool?.close(); }
  progress('parse', misses.length, misses.length);
  let parsed = 0;
  const hits: Hit[] = [];
  const importsByFile = new Map<string, ImportRef[]>();
  const nodes: TreeNode[] = [];
  for (const rel of order) {
    const a = results.get(rel)!;
    if (a.parsed) parsed++;
    if (a.imports.length) importsByFile.set(rel, a.imports);
    hits.push(...a.hits);
    nodes.push(a.node);
  }
  const rootNode = buildTree(rootName, nodes);
  // Prompt files (prompts/*.md etc.) are scanned even when docs are hidden from the map.
  if (!opts.showDocs) {
    const seen = new Set(files.map((f) => f.rel));
    for (const f of await walk(root, { showDocs: true })) {
      if (seen.has(f.rel) || !isPromptFile(f.rel)) continue;
      const text = await readTextFile(f.abs).catch(() => null);
      const h = text != null ? detectFile(f.rel, text) : null;
      if (h) hits.push(h);
    }
  }
  progress('detect', hits.length, hits.length);
  aggregateComplexity(rootNode);
  const coverage = await ingestCoverage(root, files.map((f) => f.rel), opts.coverageReport);
  applyCoverage(rootNode, coverage);
  progress('coverage', coverage.reports.length, coverage.reports.length);
  assignHits(rootNode, hits);
  applyHistory(rootNode, hist);
  let fileCount = 0;
  const kept: string[] = [];
  const count = (n: TreeNode) => { if (n.kind === 'file') { fileCount++; kept.push(n.path); } else n.children?.forEach(count); };
  count(rootNode);
  const keptSet = new Set(kept);
  const { edges, unresolved } = importEdges(new ImportResolver(root, files.map((f) => f.rel)), importsByFile);
  const cc = coChange(hist.files, keptSet);
  const ix = new Map<string, number>();
  const id = (p: string) => { let i = ix.get(p); if (i == null) ix.set(p, (i = ix.size)); return i; };
  const coupling = {
    imports: edges.filter(([a, b]) => keptSet.has(a) && keptSet.has(b)).map(([a, b, w]) => [id(a), id(b), w] as [number, number, number]),
    cochange: cc.map(([a, b, n, c]) => [id(a), id(b), n, c] as [number, number, number, number]),
    unresolved,
  };
  progress('done', files.length, files.length);
  return {
    version: 1, createdAt: new Date().toISOString(), source: { type: 'local', path: root },
    stats: { files: fileCount, sloc: rootNode.sloc, parsedFiles: parsed, durationMs: Date.now() - t0, cacheHits: files.length - misses.length, cacheMisses: misses.length },
    root: rootNode,
    git: { available: hist.available, commits: hist.commits, head: hist.head, authors: hist.authors, commitAuthors: hist.commitAuthors },
    coverage,
    hits,
    coupling: { files: [...ix.keys()], ...coupling },
  };
}

/** Large-repo transport: strip sub-file structure (fetched lazily per file). */
export function liteSnapshot(s: Snapshot): Snapshot {
  const strip = (n: TreeNode): TreeNode => (n.kind === 'file' ? { ...n, children: undefined } : { ...n, children: n.children?.map(strip) });
  return { ...s, root: strip(s.root), stats: { ...s.stats, lite: true } };
}

/** Find a file node by path. */
export function findFile(root: TreeNode, rel: string): TreeNode | null {
  let n: TreeNode | undefined = root;
  const segs = rel.split('/');
  for (let i = 0; n && i < segs.length; i++) {
    const p = segs.slice(0, i + 1).join('/');
    n = n.children?.find((c) => c.path === p && (i === segs.length - 1 ? c.kind === 'file' : c.kind === 'folder'));
  }
  return n ?? null;
}

/** Roll function complexity up: non-function nodes get max (`cx`) and SLOC-weighted mean (`cxMean`). */
export function aggregateComplexity(n: TreeNode): { max: number; ws: number; w: number; any: boolean } {
  if (n.kind === 'function' && n.cx != null) {
    // nested children (rare) are already counted inside the function's own score
    return { max: n.cx, ws: n.cx * n.sloc, w: n.sloc, any: true };
  }
  let max = 0, ws = 0, w = 0, any = false;
  for (const c of n.children ?? []) { const r = aggregateComplexity(c); if (r.any) { any = true; max = Math.max(max, r.max); ws += r.ws; w += r.w; } }
  if (any) { n.cx = max; n.cxMean = w ? ws / w : 0; }
  return { max, ws, w, any };
}

/** Attach coverage fractions: code nodes from their line ranges, folders SLOC-weighted over files with data. */
export function applyCoverage(rootNode: TreeNode, cov: Coverage) {
  const rec = (n: TreeNode, lines?: { c: Set<number>; u: Set<number> }): { ws: number; w: number } => {
    if (n.kind === 'folder') {
      let ws = 0, w = 0;
      for (const c of n.children ?? []) { const r = rec(c); ws += r.ws; w += r.w; }
      if (w) n.cov = ws / w;
      return { ws, w };
    }
    if (n.kind === 'file') {
      const fc = cov.files[n.path];
      if (!fc) return { ws: 0, w: 0 };
      const ls = { c: new Set(decodeRanges(fc.covered)), u: new Set(decodeRanges(fc.uncovered)) };
      const tot = ls.c.size + ls.u.size;
      if (tot) n.cov = ls.c.size / tot;
      n.children?.forEach((c) => rec(c, ls));
      return n.cov == null ? { ws: 0, w: 0 } : { ws: n.cov * n.sloc, w: n.sloc };
    }
    if (lines && n.startLine != null && n.endLine != null) {
      let c = 0, u = 0;
      for (let l = n.startLine; l <= n.endLine; l++) { if (lines.c.has(l)) c++; else if (lines.u.has(l)) u++; }
      if (c + u) n.cov = c / (c + u);
    }
    n.children?.forEach((c) => rec(c, lines));
    return { ws: 0, w: 0 };
  };
  rec(rootNode);
}

/** Set `nodeId` on each hit: innermost code node containing its start line, else the file, else nearest folder. */
export function assignHits(rootNode: TreeNode, hits: Hit[]) {
  const files = new Map<string, TreeNode>();
  const folders = new Set<string>();
  const index = (n: TreeNode) => { if (n.kind === 'file') files.set(n.path, n); else if (n.kind === 'folder') folders.add(n.id); n.children?.forEach(index); };
  index(rootNode);
  for (const h of hits) {
    const f = files.get(h.file);
    if (f) {
      let cur = f;
      for (;;) {
        const next = cur.children?.find((c) => c.kind === 'small-group' ? c.children?.some((g) => g.startLine! <= h.startLine && g.endLine! >= h.startLine) : c.startLine != null && c.startLine <= h.startLine && c.endLine! >= h.startLine);
        if (!next) break;
        cur = next.kind === 'small-group' ? next.children!.find((g) => g.startLine! <= h.startLine && g.endLine! >= h.startLine)! : next;
      }
      h.nodeId = cur.id;
      continue;
    }
    let d = path.posix.dirname(h.file);
    while (d !== '.' && d !== '' && !folders.has(d)) d = path.posix.dirname(d);
    h.nodeId = d === '.' ? '' : d;
  }
}
