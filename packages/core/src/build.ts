import type { TreeNode } from '@grim-repo/schema';
import type { Item } from './parse.js';

export const SMALL_SLOC = 3;

/** Build file children from parsed items, assigning each code line to its innermost owner. */
export function buildFileChildren(filePath: string, lines: boolean[], items: Item[], lang: string): TreeNode[] {
  const owner: (TreeNode | null)[] = new Array(lines.length).fill(null);
  const make = (it: Item, parentId: string, depth: number): TreeNode => {
    const id = `${parentId}#${it.name}@${it.startLine + 1}`;
    const node: TreeNode = { id, name: it.name, kind: it.kind, path: filePath, sloc: 0, language: lang, startLine: it.startLine + 1, endLine: it.endLine + 1 };
    if (it.cx != null) node.cx = it.cx;
    for (let l = it.startLine; l <= it.endLine && l < lines.length; l++) owner[l] = node;
    if (it.children.length && depth < 2) node.children = it.children.map((c) => make(c, id, depth + 1));
    return node;
  };
  const top = items.map((it) => make(it, filePath, 0));
  let moduleScope = 0;
  lines.forEach((code, l) => { if (!code) return; const o = owner[l]; if (o) o.sloc++; else moduleScope++; });
  const finish = (n: TreeNode): TreeNode => {
    if (n.children?.length) {
      n.children = n.children.map(finish);
      const own = n.sloc;
      if (own > 0) n.children.push({ id: `${n.id}#scope`, name: 'class scope', kind: 'module-scope', path: filePath, sloc: own });
      n.sloc = n.children.reduce((a, c) => a + c.sloc, 0);
      n.children = aggregateSmall(n.children.filter((c) => c.sloc > 0), n.id, filePath);
    }
    return n;
  };
  const result = top.map(finish).filter((n) => n.sloc > 0);
  if (moduleScope > 0) result.push({ id: `${filePath}#module`, name: 'module scope', kind: 'module-scope', path: filePath, sloc: moduleScope });
  return aggregateSmall(result, filePath, filePath);
}

function aggregateSmall(nodes: TreeNode[], parentId: string, filePath: string): TreeNode[] {
  const small = nodes.filter((n) => n.kind === 'function' && n.sloc < SMALL_SLOC);
  if (small.length < 2) return nodes;
  const rest = nodes.filter((n) => !small.includes(n));
  rest.push({ id: `${parentId}#small`, name: `${small.length} small functions`, kind: 'small-group', path: filePath, sloc: small.reduce((a, c) => a + c.sloc, 0), children: small });
  return rest;
}
