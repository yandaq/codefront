import type { Hit } from '@codefront/schema';
import type { CallSite, StrLit } from './parse.js';
import { defaultRules, type Rules, type Lang } from './rules/default-rules.js';

export { defaultRules } from './rules/default-rules.js';
export type { Rules, CallRule, FileRule } from './rules/default-rules.js';

const snip = (s: string, n = 400) => (s.length > n ? s.slice(0, n) + '…' : s);
const TABLE_RE = /\b(?:FROM|JOIN|INTO|UPDATE|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+([`"\[]?[A-Za-z_][\w.]*[`"\]]?)/gi;
const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|TRUNCATE|MERGE|REPLACE)\b/i;
const SQL_KW = new Set(['SELECT', 'FROM', 'WHERE', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'AND', 'OR', 'GROUP', 'BY', 'ORDER', 'LIMIT', 'OFFSET', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE', 'CREATE', 'TABLE', 'AS', 'IN', 'NOT', 'NULL', 'IS', 'DISTINCT', 'HAVING', 'RETURNING', 'PRIMARY', 'KEY', 'INDEX', 'VIEW', 'IF', 'EXISTS', 'COUNT', 'WITH', 'UNION', 'ALL', 'LIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'DESC', 'ASC']);
const STOP = new Set(['the', 'a', 'an', 'this', 'that', 'your', 'my', 'our', 'their', 'which', 'one', 'some', 'any', 'each', 'all', 'these', 'those']);

export function extractTables(sql: string): string[] {
  const out = new Set<string>();
  for (const m of sql.matchAll(TABLE_RE)) {
    const t = m[1]!.replace(/[`"\[\]]/g, '');
    if (!SQL_KW.has(t.toUpperCase()) && !STOP.has(t.toLowerCase())) out.add(t);
  }
  return [...out];
}

/**
 * Lightweight SQL validation: tokenise from the matched statement and require SQL-shaped structure
 * (identifier after FROM/INTO/UPDATE/TABLE, no English determiners in object positions, keyword density).
 * Returns a confidence in 0..1 (0 = reject).
 */
export function sqlConfidence(text: string, rules: Rules = defaultRules): number {
  const start = rules.sqlStatements.map((r) => text.search(r)).filter((i) => i >= 0);
  if (!start.length) return 0;
  const body = text.slice(Math.min(...start));
  const toks = body.match(/[A-Za-z_][\w.]*|\$\d+|:\w+|\?|\*|=|<>|!=|<=|>=|[(),;<>]|'[^']*'|\d+/g) ?? [];
  if (toks.length < 4) return 0;
  const up = toks.map((t) => t.toUpperCase());
  // object positions must not be English determiners ("select an item from the list")
  for (let i = 0; i < up.length - 1; i++) {
    if (['SELECT', 'FROM', 'INTO', 'UPDATE', 'TABLE', 'JOIN'].includes(up[i]!) && STOP.has(toks[i + 1]!.toLowerCase())) return 0;
  }
  const kw = up.filter((t) => SQL_KW.has(t)).length;
  const symbols = toks.filter((t) => /^(\$\d+|:\w+|\?|\*|=|<>|!=|<=|>=|,|\(|\))$/.test(t)).length;
  const words = toks.filter((t) => /^[A-Za-z]/.test(t)).length;
  if (kw / Math.max(1, words) < 0.25 && symbols === 0) return 0;
  const upperKw = toks.filter((t) => SQL_KW.has(t) && t === t.toUpperCase()).length;
  let c = 0.55 + Math.min(0.2, symbols * 0.05) + (upperKw >= 2 ? 0.2 : 0);
  if (!extractTables(body).length) c -= 0.3;
  return Math.max(0, Math.min(0.98, c));
}

export function promptScore(text: string, rules: Rules = defaultRules): number {
  if (text.length < rules.promptMinLength) return 0;
  const n = rules.promptMarkers.filter((r) => r.test(text)).length;
  return n ? Math.min(0.95, 0.55 + 0.15 * n) : 0;
}

export interface DetectInput { file: string; lang: Lang; strings: StrLit[]; calls: CallSite[] }

/** Detect LLM/SQL hits in a parsed source file. Lines in output are 1-based. */
export function detectSource(inp: DetectInput, rules: Rules = defaultRules): Hit[] {
  const hits: Hit[] = [];
  const seen = new Set<string>();
  const push = (h: Hit) => { const k = `${h.kind}:${h.startLine}:${h.rule}:${h.snippet}`; if (!seen.has(k)) { seen.add(k); hits.push(h); } };
  const callLines: Array<[number, number, 'llm' | 'sql']> = [];
  for (const c of inp.calls) {
    for (const r of rules.calls) {
      if (r.langs && !r.langs.includes(inp.lang)) continue;
      if (!r.callee.test(c.callee)) continue;
      const h: Hit = { kind: r.kind, rule: r.id, file: inp.file, startLine: c.startLine + 1, endLine: c.endLine + 1, confidence: r.confidence, snippet: snip(c.text) };
      if (r.kind === 'llm' && /\b(system|messages|prompt|instructions|input)\s*[:=]/.test(c.text)) h.confidence = Math.min(0.99, h.confidence + 0.04);
      if (r.kind === 'sql') {
        const method = c.callee.split('.').pop() ?? '';
        const table = r.table ? c.text.match(r.table)?.[1] : undefined;
        const strArg = c.text.match(/['"`]([^'"`]{6,})['"`]/)?.[1];
        const rawSql = r.style === 'raw' && strArg ? strArg : '';
        h.sql = {
          style: r.style ?? 'orm',
          op: r.op ?? (rawSql ? (WRITE_RE.test(rawSql) ? 'write' : 'read') : rules.writeMethods.test(method) ? 'write' : 'read'),
          tables: table ? [table] : rawSql ? extractTables(rawSql) : [],
        };
      }
      push(h);
      callLines.push([c.startLine, c.endLine, r.kind]);
      break;
    }
  }
  const insideCall = (s: StrLit, kind: 'llm' | 'sql') => callLines.some(([a, b, k]) => k === kind && s.startLine >= a && s.endLine <= b);
  for (const s of inp.strings) {
    const sc = sqlConfidence(s.text, rules);
    if (sc > 0 && !insideCall(s, 'sql')) {
      push({ kind: 'sql', rule: 'raw-sql', file: inp.file, startLine: s.startLine + 1, endLine: s.endLine + 1, confidence: sc, snippet: snip(s.text.trim()),
        sql: { style: 'raw', op: WRITE_RE.test(s.text.replace(/^[\s\S]*?(?=\b(SELECT|INSERT|UPDATE|DELETE|CREATE|WITH)\b)/i, '')) ? 'write' : 'read', tables: extractTables(s.text) } });
    }
    const pc = promptScore(s.text, rules);
    if (pc > 0 && !insideCall(s, 'llm')) push({ kind: 'llm', rule: 'prompt-literal', file: inp.file, startLine: s.startLine + 1, endLine: s.endLine + 1, confidence: pc, snippet: snip(s.text.trim()) });
  }
  return hits;
}

/** Whole-file detectors (.sql, *.prompt, prompts/*.md, .jinja). Returns null if no file rule matches. */
export function detectFile(file: string, text: string, rules: Rules = defaultRules): Hit | null {
  const r = rules.files.find((f) => f.path.test(file));
  if (!r) return null;
  const lines = text.split('\n').length;
  const h: Hit = { kind: r.kind, rule: r.id, file, startLine: 1, endLine: lines, confidence: r.confidence, snippet: snip(text.trim()) };
  if (r.kind === 'sql') h.sql = { style: 'raw', op: /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(text) ? 'write' : 'read', tables: extractTables(text) };
  return h;
}

export function isPromptFile(file: string, rules: Rules = defaultRules): boolean {
  return rules.files.some((f) => f.kind === 'llm' && f.path.test(file));
}
