import type Parser from 'web-tree-sitter';
type N = Parser.SyntaxNode;

const LOOPS = new Set(['for_statement', 'for_in_statement', 'while_statement', 'do_statement',
  'enhanced_for_statement', 'foreach_statement', 'for_each_statement', 'for_expression', 'while_expression', 'loop_expression']);
const SWITCHES = new Set(['switch_statement', 'match_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement', 'switch_expression', 'match_expression']);
const IFS = new Set(['if_statement', 'if_expression']);
const CATCHES = new Set(['catch_clause', 'except_clause', 'except_group_clause']);
const TERNARY = new Set(['ternary_expression', 'conditional_expression']);
const NESTED_FN = new Set(['arrow_function', 'function_expression', 'function', 'generator_function', 'function_declaration', 'generator_function_declaration', 'function_definition', 'method_definition', 'lambda', 'class_declaration', 'class_definition', 'class',
  'func_literal', 'lambda_expression', 'closure_expression', 'anonymous_method_expression']);
const BOOL_JS = new Set(['&&', '||', '??']);

function boolOp(n: N): string | null {
  if (n.type === 'binary_expression') { const op = n.childForFieldName('operator')?.type; return op && BOOL_JS.has(op) ? op : null; }
  if (n.type === 'boolean_operator') return n.childForFieldName('operator')?.type ?? null;
  return null;
}

/** Cognitive complexity (Sonar-style) of a function/class node: structural increments + nesting penalty + boolean sequences. */
export function cognitiveComplexity(fn: N, inners?: number[]): number {
  return children(fn, 0, inners ?? []);
}

const DECL_FN = new Set(['function_declaration', 'generator_function_declaration', 'function_definition', 'method_definition',
  'method_declaration', 'constructor_declaration', 'local_function_statement', 'function_item']);
const VALUE_FN = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const NAMING_PARENT = new Set(['variable_declarator', 'pair', 'public_field_definition', 'field_definition']);

/** Named inner functions are scored separately (option 2); anonymous inline callbacks/lambdas count toward the parent. */
export function isNamedFunction(n: N): boolean {
  if (DECL_FN.has(n.type)) return true;
  if (!VALUE_FN.has(n.type)) return false;
  if (n.childForFieldName('name')) return true;
  return !!n.parent && NAMING_PARENT.has(n.parent.type) && n.parent.childForFieldName('value')?.id === n.id;
}

function children(n: N, nest: number, inners: number[]): number {
  let s = 0;
  for (const c of n.namedChildren) s += visit(c, nest, inners);
  return s;
}

function ifChain(n: N, nest: number, inners: number[]): number {
  // n is an if_statement; caller already added its own increment
  let s = 0;
  const alt = n.childForFieldName('alternative');
  for (const c of n.namedChildren) {
    if (alt && c.id === alt.id && c.type !== 'else_clause') {
      // Go/Java/C#: `alternative` is the else branch itself (an if = else-if)
      s += 1 + (IFS.has(c.type) ? ifChain(c, nest, inners) : children(c, nest + 1, inners));
    } else if (c.type === 'else_clause') {
      const inner = c.namedChildren.length === 1 && IFS.has(c.namedChildren[0]!.type) ? c.namedChildren[0]! : null;
      s += 1 + (inner ? ifChain(inner, nest, inners) : children(c, nest + 1, inners)); // else-if / else: +1, no nesting penalty
    } else if (c.type === 'elif_clause') s += 1 + children(c, nest + 1, inners);
    else s += visit(c, nest + 1, inners);
  }
  return s;
}

function visit(n: N, nest: number, inners: number[]): number {
  const t = n.type;
  if (isNamedFunction(n)) { inners.push(cognitiveComplexity(n, inners)); return 0; }
  if (IFS.has(t)) return 1 + nest + ifChain(n, nest, inners);
  if (LOOPS.has(t) || SWITCHES.has(t) || CATCHES.has(t) || TERNARY.has(t)) return 1 + nest + children(n, nest + 1, inners);
  if (NESTED_FN.has(t)) return children(n, nest + 1, inners);
  const op = boolOp(n);
  if (op) {
    const parentOp = n.parent ? boolOp(n.parent) : null;
    return (parentOp === op ? 0 : 1) + children(n, nest, inners);
  }
  return children(n, nest, inners);
}
