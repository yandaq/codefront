import { createRequire } from 'node:module';
import path from 'node:path';
import Parser from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const wasmDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python';

export function languageFor(file: string): Lang | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py' || ext === '.pyi') return 'python';
  return null;
}

let initP: Promise<void> | null = null;
const langs = new Map<Lang, Promise<Parser.Language>>();

async function getParser(lang: Lang): Promise<Parser> {
  initP ??= Parser.init();
  await initP;
  if (!langs.has(lang)) langs.set(lang, Parser.Language.load(path.join(wasmDir, `tree-sitter-${lang}.wasm`)));
  const p = new Parser();
  p.setLanguage(await langs.get(lang)!);
  return p;
}

export interface Item { kind: 'class' | 'function'; name: string; startLine: number; endLine: number; children: Item[] }
export interface ParseResult { comments: Array<[number, number]>; items: Item[] }

type N = Parser.SyntaxNode;

const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class_definition', 'class']);
const FN_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'function_definition', 'method_definition', 'function_signature']);
const FN_VALUE = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function nameOf(n: N, fallback: string): string {
  return n.childForFieldName('name')?.text ?? fallback;
}

/** Turn a node into an Item if it's a class/function (possibly wrapped in export/decorator/variable). */
function toItem(n: N, depth: number): Item | null {
  let node = n;
  if (node.type === 'export_statement' || node.type === 'decorated_definition') {
    const inner = node.childForFieldName('declaration') ?? node.childForFieldName('definition') ?? node.namedChildren.find((c) => CLASS_TYPES.has(c.type) || FN_TYPES.has(c.type) || c.type === 'lexical_declaration');
    if (!inner) return null;
    const it = toItem(inner, depth);
    if (it) { it.startLine = n.startPosition.row; it.endLine = n.endPosition.row; }
    return it;
  }
  const span = { startLine: n.startPosition.row, endLine: n.endPosition.row };
  if (CLASS_TYPES.has(node.type)) {
    const body = node.childForFieldName('body');
    const children: Item[] = [];
    if (body && depth < 2) for (const c of body.namedChildren) { const it = toItem(c, depth + 1); if (it) children.push(it); }
    return { kind: 'class', name: nameOf(node, '(anonymous class)'), ...span, children };
  }
  if (FN_TYPES.has(node.type)) return { kind: 'function', name: nameOf(node, '(anonymous)'), ...span, children: [] };
  // const foo = () => {} / class field foo = () => {}
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const decls = node.namedChildren.filter((c) => c.type === 'variable_declarator');
    if (decls.length === 1) {
      const v = decls[0]!.childForFieldName('value');
      if (v && FN_VALUE.has(v.type)) return { kind: 'function', name: nameOf(decls[0]!, '(anonymous)'), ...span, children: [] };
      if (v && CLASS_TYPES.has(v.type)) { const it = toItem(v, depth); if (it) { it.name = nameOf(decls[0]!, it.name); Object.assign(it, span); } return it; }
    }
    return null;
  }
  if (node.type === 'public_field_definition' || node.type === 'field_definition') {
    const v = node.childForFieldName('value');
    if (v && FN_VALUE.has(v.type)) return { kind: 'function', name: (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text ?? '(field)', ...span, children: [] };
  }
  return null;
}

export async function parseSource(text: string, lang: Lang): Promise<ParseResult> {
  const parser = await getParser(lang);
  const tree = parser.parse(text);
  try {
    const comments: Array<[number, number]> = [];
    const stack: N[] = [tree.rootNode];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.type === 'comment') { comments.push([n.startIndex, n.endIndex]); continue; }
      // Python docstrings: expression_statement containing only a string
      if (lang === 'python' && n.type === 'expression_statement' && n.namedChildCount === 1 && n.namedChildren[0]!.type === 'string') {
        if (!n.previousNamedSibling && (n.parent?.type === 'block' || n.parent?.type === 'module')) comments.push([n.startIndex, n.endIndex]);
      }
      for (const c of n.children) stack.push(c);
    }
    const items: Item[] = [];
    for (const c of tree.rootNode.namedChildren) { const it = toItem(c, 0); if (it) items.push(it); }
    return { comments, items };
  } finally {
    tree.delete();
    parser.delete();
  }
}
