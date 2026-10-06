import { createRequire } from 'node:module';
import path from 'node:path';
import Parser from 'web-tree-sitter';
import { cognitiveComplexity } from './complexity.js';

/** Displayed complexity: max over the function's own score and its merged named inner functions (each scored separately). */
function cxOf(n: Parser.SyntaxNode): number { const inner: number[] = []; return Math.max(cognitiveComplexity(n, inner), ...inner); }

const require = createRequire(import.meta.url);
const wasmDir = path.join(path.dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

export type Lang = 'typescript' | 'tsx' | 'javascript' | 'python' | 'go' | 'java' | 'c_sharp' | 'rust';

export function languageFor(file: string): Lang | null {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.ts' || ext === '.mts' || ext === '.cts') return 'typescript';
  if (ext === '.tsx') return 'tsx';
  if (['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) return 'javascript';
  if (ext === '.py' || ext === '.pyi') return 'python';
  if (ext === '.go') return 'go';
  if (ext === '.java') return 'java';
  if (ext === '.cs') return 'c_sharp';
  if (ext === '.rs') return 'rust';
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

export interface Item { kind: 'class' | 'function'; name: string; startLine: number; endLine: number; children: Item[]; cx?: number }
/** A string literal or call site (0-based lines) for detectors. */
export interface StrLit { text: string; startLine: number; endLine: number; at?: number }
export interface CallSite { callee: string; text: string; startLine: number; endLine: number; at?: number }
/** An import statement: module specifier (Python: dotted, leading dots = relative) and, for `from X import a, b`, the names. */
export interface ImportRef { spec: string; names?: string[] }
export interface ParseResult { comments: Array<[number, number]>; items: Item[]; strings: StrLit[]; calls: CallSite[]; imports: ImportRef[] }

type N = Parser.SyntaxNode;

const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class_definition', 'class',
  // Java / C# / Rust
  'interface_declaration', 'enum_declaration', 'record_declaration', 'struct_declaration', 'impl_item', 'trait_item', 'mod_item']);
const FN_TYPES = new Set(['function_declaration', 'generator_function_declaration', 'function_definition', 'method_definition', 'function_signature',
  // Go / Java / C# / Rust
  'method_declaration', 'constructor_declaration', 'local_function_statement', 'function_item']);
/** Containers whose members are hoisted to the file level (C# namespaces). */
const NAMESPACE_TYPES = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);
const COMMENT_TYPES = new Set(['comment', 'line_comment', 'block_comment']);
const STRING_TYPES = new Set(['string', 'template_string', 'interpreted_string_literal', 'raw_string_literal', 'string_literal', 'verbatim_string_literal']);
const CALL_TYPES = new Set(['call_expression', 'call', 'new_expression', 'method_invocation', 'invocation_expression', 'object_creation_expression']);
const FN_VALUE = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function nameOf(n: N, fallback: string): string {
  if (n.type === 'impl_item') {
    const t = n.childForFieldName('type')?.text, tr = n.childForFieldName('trait')?.text;
    return t ? `impl ${tr ? `${tr} for ` : ''}${t}` : fallback;
  }
  const name = n.childForFieldName('name')?.text ?? fallback;
  if (n.type === 'method_declaration') {
    // Go method: prefix receiver type, e.g. "(*Server).Start" -> "Server.Start"
    const recv = n.childForFieldName('receiver');
    const t = recv?.text.match(/([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*$/)?.[1];
    if (t) return `${t}.${name}`;
  }
  return name;
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
    if (node.type === 'mod_item' && !body) return null; // `mod foo;` declaration
    const children: Item[] = [];
    if (body && depth < 2) for (const c of body.namedChildren) { const it = toItem(c, depth + 1); if (it) children.push(it); }
    return { kind: 'class', name: nameOf(node, '(anonymous class)'), ...span, children };
  }
  if (FN_TYPES.has(node.type)) return { kind: 'function', name: nameOf(node, '(anonymous)'), ...span, children: [], cx: cxOf(node) };
  // const foo = () => {} / class field foo = () => {}
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const decls = node.namedChildren.filter((c) => c.type === 'variable_declarator');
    if (decls.length === 1) {
      const v = decls[0]!.childForFieldName('value');
      if (v && FN_VALUE.has(v.type)) return { kind: 'function', name: nameOf(decls[0]!, '(anonymous)'), ...span, children: [], cx: cxOf(v) };
      if (v && CLASS_TYPES.has(v.type)) { const it = toItem(v, depth); if (it) { it.name = nameOf(decls[0]!, it.name); Object.assign(it, span); } return it; }
    }
    return null;
  }
  if (node.type === 'public_field_definition' || node.type === 'field_definition') {
    const v = node.childForFieldName('value');
    if (v && FN_VALUE.has(v.type)) return { kind: 'function', name: (node.childForFieldName('name') ?? node.childForFieldName('property'))?.text ?? '(field)', ...span, children: [], cx: cxOf(v) };
  }
  return null;
}

export async function parseSource(text: string, lang: Lang): Promise<ParseResult> {
  const parser = await getParser(lang);
  const tree = parser.parse(text);
  try {
    const comments: Array<[number, number]> = [];
    const strings: StrLit[] = [];
    const calls: CallSite[] = [];
    const stack: N[] = [tree.rootNode];
    const docstrings = new Set<number>();
    const imports: ImportRef[] = [];
    while (stack.length) {
      const n = stack.pop()!;
      const imp = importOf(n, lang);
      if (imp) imports.push(...imp);
      if (COMMENT_TYPES.has(n.type)) { comments.push([n.startIndex, n.endIndex]); continue; }
      // Python docstrings: expression_statement containing only a string
      if (lang === 'python' && n.type === 'expression_statement' && n.namedChildCount === 1 && n.namedChildren[0]!.type === 'string') {
        if (!n.previousNamedSibling && (n.parent?.type === 'block' || n.parent?.type === 'module')) { comments.push([n.startIndex, n.endIndex]); docstrings.add(n.namedChildren[0]!.startIndex); }
      }
      if (STRING_TYPES.has(n.type) && !docstrings.has(n.startIndex) && n.parent?.type !== 'string') {
        strings.push({ text: stripQuotes(n.text), startLine: n.startPosition.row, endLine: n.endPosition.row, at: n.startIndex });
        if (n.type !== 'template_string') continue;
      }
      if (CALL_TYPES.has(n.type)) {
        const f = n.type === 'method_invocation'
          ? { text: [n.childForFieldName('object')?.text, n.childForFieldName('name')?.text].filter(Boolean).join('.') }
          : n.childForFieldName('function') ?? n.childForFieldName('constructor') ?? n.childForFieldName('type');
        if (f) calls.push({ callee: f.text.replace(/\s+/g, '').slice(0, 200), text: n.text.slice(0, 600), startLine: n.startPosition.row, endLine: n.endPosition.row, at: n.startIndex });
      }
      for (const c of n.children) stack.push(c);
    }
    const items: Item[] = [];
    const top = (parent: N) => {
      for (const c of parent.namedChildren) {
        if (NAMESPACE_TYPES.has(c.type)) { const b = c.childForFieldName('body'); top(b ?? c); continue; }
        const it = toItem(c, 0); if (it) items.push(it);
      }
    };
    top(tree.rootNode);
    const byAt = (a: { at?: number }, b: { at?: number }) => a.at! - b.at!;
    return { comments, items, strings: strings.sort(byAt), calls: calls.sort(byAt), imports };
  } finally {
    tree.delete();
    parser.delete();
  }
}

function stripQuotes(t: string): string {
  const m = t.match(/^[rbuRBUfF@$]*#*('''|"""|'|"|`)([\s\S]*)\1#*$/);
  return m ? m[2]! : t;
}

const strArg = (n: N | null | undefined): string | null => (n && (n.type === 'string' || n.type === 'interpreted_string_literal' || n.type === 'raw_string_literal' || (n.type === 'template_string' && !n.namedChildren.some((c) => c.type === 'template_substitution'))) ? stripQuotes(n.text) : null);

function importOf(n: N, lang: Lang): ImportRef[] | null {
  if (lang === 'go') {
    if (n.type !== 'import_spec') return null;
    const s = strArg(n.childForFieldName('path'));
    return s ? [{ spec: s }] : null;
  }
  if (lang === 'java') {
    if (n.type !== 'import_declaration') return null;
    const t = n.text.replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').replace(/\s+/g, '');
    return [{ spec: t }];
  }
  if (lang === 'c_sharp') {
    if (n.type !== 'using_directive') return null;
    const t = n.text.replace(/^(global\s+)?using\s+(static\s+)?/, '').replace(/;\s*$/, '').replace(/^\w+\s*=\s*/, '').trim();
    return t ? [{ spec: t }] : null;
  }
  if (lang === 'rust') {
    if (n.type === 'use_declaration') {
      const a = n.childForFieldName('argument')?.text.replace(/\s+/g, '');
      return a ? [{ spec: a }] : null;
    }
    if (n.type === 'mod_item' && !n.childForFieldName('body')) { const nm = n.childForFieldName('name')?.text; return nm ? [{ spec: `mod:${nm}` }] : null; }
    return null;
  }
  if (lang === 'python') {
    if (n.type === 'import_statement') {
      return n.namedChildren.map((c) => (c.type === 'aliased_import' ? c.childForFieldName('name')!.text : c.text)).map((spec) => ({ spec }));
    }
    if (n.type === 'import_from_statement') {
      const mod = n.childForFieldName('module_name');
      if (!mod) return null;
      const names = n.namedChildren.filter((c) => c.id !== mod.id).map((c) => (c.type === 'aliased_import' ? c.childForFieldName('name')!.text : c.text)).filter((t) => t !== '*');
      return [{ spec: mod.text.replace(/\s+/g, ''), names }];
    }
    return null;
  }
  if (n.type === 'import_statement' || n.type === 'export_statement') {
    const s = strArg(n.childForFieldName('source'));
    return s ? [{ spec: s }] : null;
  }
  if (n.type === 'call_expression') {
    const f = n.childForFieldName('function');
    if (f && (f.type === 'import' || (f.type === 'identifier' && f.text === 'require'))) {
      const s = strArg(n.childForFieldName('arguments')?.namedChildren[0]);
      return s ? [{ spec: s }] : null;
    }
  }
  return null;
}
