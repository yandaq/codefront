import path from 'node:path';
import { decodeRanges, type Snapshot, type TreeNode, type ScanProgress, type Hit, type Coverage } from '@grim-repo/schema';
import { walk, readTextFile } from './walk.js';
import { codeLines, fallbackComments } from './sloc.js';
import { languageFor, parseSource } from './parse.js';
import { buildFileChildren } from './build.js';
import { readHistory, applyHistory } from './git.js';
import { detectSource, detectFile, isPromptFile } from './detect.js';
import { ingestCoverage } from './coverage.js';
import { ImportResolver, importEdges, coChange } from './coupling.js';
import type { ImportRef } from './parse.js';

export { readHistory, applyHistory, blameTree, blameLines, functionAges, renameTarget, isGitRepo } from './git.js';

export { walk } from './walk.js';
export { codeLines, countSloc, fallbackComments } from './sloc.js';
export { parseSource, languageFor } from './parse.js';
export { cognitiveComplexity } from './complexity.js';
export * from './detect.js';
export * from './coverage.js';
export * from './coupling.js';

export interface ScanOptions { showDocs?: boolean; coverageReport?: string; onProgress?: (p: ScanProgress) => void }

export async function scan(rootPath: string, opts: ScanOptions = {}): Promise<Snapshot> {
  const t0 = Date.now();
  const root = path.resolve(rootPath);
  const files = await walk(root, { showDocs: opts.showDocs });
  opts.onProgress?.({ stage: 'walk', done: files.length, total: files.length });
  const rootNode: TreeNode = { id: '', name: path.basename(root), kind: 'folder', path: '', sloc: 0, children: [] };
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
  let parsed = 0, done = 0;
  const hits: Hit[] = [];
  const importsByFile = new Map<string, ImportRef[]>();
  for (const f of files) {
    done++;
    const text = await readTextFile(f.abs).catch(() => null);
    if (text == null) continue;
    const lang = languageFor(f.rel);
    let node: TreeNode;
    if (lang) {
      try {
        const r = await parseSource(text, lang);
        if (r.imports.length) importsByFile.set(f.rel, r.imports);
        hits.push(...detectSource({ file: f.rel, lang: lang === 'python' ? 'py' : 'js', strings: r.strings, calls: r.calls }));
        const lines = codeLines(text, r.comments);
        const children = buildFileChildren(f.rel, lines, r.items, lang);
        node = { id: f.rel, name: path.posix.basename(f.rel), kind: 'file', path: f.rel, language: lang, sloc: children.reduce((a, c) => a + c.sloc, 0), children };
        if (children.length === 1 && children[0]!.kind === 'module-scope') delete node.children;
        parsed++;
      } catch {
        node = plainFile(f.rel, text);
      }
    } else { node = plainFile(f.rel, text); const h = detectFile(f.rel, text); if (h) hits.push(h); }
    if (node.sloc === 0) continue;
    folderFor(f.rel).children!.push(node);
    if (done % 50 === 0) opts.onProgress?.({ stage: 'parse', done, total: files.length });
  }
  const sum = (n: TreeNode): number => {
    if (n.kind === 'folder') n.sloc = n.children!.reduce((a, c) => a + sum(c), 0);
    return n.sloc;
  };
  sum(rootNode);
  const prune = (n: TreeNode) => { if (n.children) { n.children = n.children.filter((c) => c.sloc > 0); n.children.forEach(prune); } };
  prune(rootNode);
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
  opts.onProgress?.({ stage: 'detect', done: hits.length, total: hits.length });
  aggregateComplexity(rootNode);
  const coverage = await ingestCoverage(root, files.map((f) => f.rel), opts.coverageReport);
  applyCoverage(rootNode, coverage);
  opts.onProgress?.({ stage: 'coverage', done: coverage.reports.length, total: coverage.reports.length });
  assignHits(rootNode, hits);
  const hist = await readHistory(root);
  applyHistory(rootNode, hist);
  opts.onProgress?.({ stage: 'git', done: hist.commits.length, total: hist.commits.length });
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
  opts.onProgress?.({ stage: 'done', done: files.length, total: files.length });
  return {
    version: 1, createdAt: new Date().toISOString(), source: { type: 'local', path: root },
    stats: { files: fileCount, sloc: rootNode.sloc, parsedFiles: parsed, durationMs: Date.now() - t0 },
    root: rootNode,
    git: { available: hist.available, commits: hist.commits, head: hist.head },
    coverage,
    hits,
    coupling: { files: [...ix.keys()], ...coupling },
  };
}

function plainFile(rel: string, text: string): TreeNode {
  const sloc = codeLines(text, fallbackComments(text, rel)).filter(Boolean).length;
  return { id: rel, name: path.posix.basename(rel), kind: 'file', path: rel, sloc };
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
