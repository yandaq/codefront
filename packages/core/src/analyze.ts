import path from 'node:path';
import type { Hit, TreeNode } from '@grim-repo/schema';
import { codeLines, fallbackComments } from './sloc.js';
import { languageFor, parseSource, type ImportRef } from './parse.js';
import { buildFileChildren } from './build.js';
import { detectSource, detectFile } from './detect.js';

/** Per-file analysis result (JSON-serialisable; cached by blob SHA, computed in worker threads). */
export interface FileAnalysis { node: TreeNode; hits: Hit[]; imports: ImportRef[]; parsed: boolean }

/** Bump when analysis output changes shape/semantics to invalidate on-disk caches. */
export const ANALYSIS_VERSION = 3;

export function plainFile(rel: string, text: string): TreeNode {
  const sloc = codeLines(text, fallbackComments(text, rel)).filter(Boolean).length;
  return { id: rel, name: path.posix.basename(rel), kind: 'file', path: rel, sloc };
}

/** Parse + SLOC + complexity + detectors + imports for one file. Pure: safe to run in a worker. */
export async function analyzeFile(rel: string, text: string): Promise<FileAnalysis> {
  const lang = languageFor(rel);
  if (lang) {
    try {
      const r = await parseSource(text, lang);
      const hits = detectSource({ file: rel, lang: lang === 'python' ? 'py' : 'js', strings: r.strings, calls: r.calls });
      const children = buildFileChildren(rel, codeLines(text, r.comments), r.items, lang);
      const node: TreeNode = { id: rel, name: path.posix.basename(rel), kind: 'file', path: rel, language: lang, sloc: children.reduce((a, c) => a + c.sloc, 0), children };
      if (children.length === 1 && children[0]!.kind === 'module-scope') delete node.children;
      return { node, hits, imports: r.imports, parsed: true };
    } catch { /* fall through to plain */ }
  }
  const h = lang ? null : detectFile(rel, text);
  return { node: plainFile(rel, text), hits: h ? [h] : [], imports: [], parsed: false };
}
