import path from 'node:path';
import type { Snapshot, TreeNode, ScanProgress } from '@grim-repo/schema';
import { walk, readTextFile } from './walk.js';
import { codeLines, fallbackComments } from './sloc.js';
import { languageFor, parseSource } from './parse.js';
import { buildFileChildren } from './build.js';

export { walk } from './walk.js';
export { codeLines, countSloc, fallbackComments } from './sloc.js';
export { parseSource, languageFor } from './parse.js';

export interface ScanOptions { showDocs?: boolean; onProgress?: (p: ScanProgress) => void }

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
  for (const f of files) {
    done++;
    const text = await readTextFile(f.abs).catch(() => null);
    if (text == null) continue;
    const lang = languageFor(f.rel);
    let node: TreeNode;
    if (lang) {
      try {
        const r = await parseSource(text, lang);
        const lines = codeLines(text, r.comments);
        const children = buildFileChildren(f.rel, lines, r.items, lang);
        node = { id: f.rel, name: path.posix.basename(f.rel), kind: 'file', path: f.rel, language: lang, sloc: children.reduce((a, c) => a + c.sloc, 0), children };
        if (children.length === 1 && children[0]!.kind === 'module-scope') delete node.children;
        parsed++;
      } catch {
        node = plainFile(f.rel, text);
      }
    } else node = plainFile(f.rel, text);
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
  let fileCount = 0;
  const count = (n: TreeNode) => { if (n.kind === 'file') fileCount++; else n.children?.forEach(count); };
  count(rootNode);
  opts.onProgress?.({ stage: 'done', done: files.length, total: files.length });
  return {
    version: 1, createdAt: new Date().toISOString(), source: { type: 'local', path: root },
    stats: { files: fileCount, sloc: rootNode.sloc, parsedFiles: parsed, durationMs: Date.now() - t0 },
    root: rootNode,
  };
}

function plainFile(rel: string, text: string): TreeNode {
  const sloc = codeLines(text, fallbackComments(text, rel)).filter(Boolean).length;
  return { id: rel, name: path.posix.basename(rel), kind: 'file', path: rel, sloc };
}
