import { promises as fs } from 'node:fs';
import path from 'node:path';
import { encodeRanges, type Coverage } from '@grim-repo/schema';

/** Raw parsed report: report path -> (line -> hit count). */
export type LineHits = Map<string, Map<number, number>>;
export type CoverageFormat = 'lcov' | 'istanbul' | 'cobertura' | 'jacoco' | 'go';

const add = (m: LineHits, file: string, line: number, hits: number) => {
  let f = m.get(file);
  if (!f) m.set(file, (f = new Map()));
  f.set(line, Math.max(f.get(line) ?? 0, hits));
};
const attr = (s: string, name: string) => s.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1];

export function parseLcov(text: string): LineHits {
  const m: LineHits = new Map();
  let file = '';
  for (const raw of text.split('\n')) {
    const l = raw.trim();
    if (l.startsWith('SF:')) file = l.slice(3);
    else if (l.startsWith('DA:') && file) { const [ln, h] = l.slice(3).split(','); add(m, file, Number(ln), Number(h)); }
    else if (l === 'end_of_record') file = '';
  }
  return m;
}

export function parseIstanbul(text: string): LineHits {
  const m: LineHits = new Map();
  const j = JSON.parse(text) as Record<string, { path?: string; statementMap: Record<string, { start: { line: number }; end: { line: number } }>; s: Record<string, number> }>;
  for (const [k, v] of Object.entries(j)) {
    const file = v.path ?? k;
    for (const [id, loc] of Object.entries(v.statementMap ?? {})) add(m, file, loc.start.line, v.s?.[id] ?? 0);
  }
  return m;
}

export function parseCobertura(text: string): LineHits {
  const m: LineHits = new Map();
  const sources = [...text.matchAll(/<source>([^<]*)<\/source>/g)].map((x) => x[1]!.trim());
  const src = sources[0] ?? '';
  for (const cls of text.matchAll(/<class\b([^>]*)>([\s\S]*?)<\/class>/g)) {
    const fn = attr(cls[1]!, 'filename');
    if (!fn) continue;
    const file = src && !path.isAbsolute(fn) ? `${src.replace(/\/$/, '')}/${fn}` : fn;
    for (const ln of cls[2]!.matchAll(/<line\b([^>]*)\/?>/g)) add(m, file, Number(attr(ln[1]!, 'number')), Number(attr(ln[1]!, 'hits') ?? 0));
  }
  return m;
}

export function parseJacoco(text: string): LineHits {
  const m: LineHits = new Map();
  for (const pkg of text.matchAll(/<package\b([^>]*)>([\s\S]*?)<\/package>/g)) {
    const pname = attr(pkg[1]!, 'name') ?? '';
    for (const sf of pkg[2]!.matchAll(/<sourcefile\b([^>]*)>([\s\S]*?)<\/sourcefile>/g)) {
      const file = (pname ? pname + '/' : '') + (attr(sf[1]!, 'name') ?? '');
      for (const ln of sf[2]!.matchAll(/<line\b([^>]*)\/?>/g)) {
        const ci = Number(attr(ln[1]!, 'ci') ?? 0), mi = Number(attr(ln[1]!, 'mi') ?? 0);
        if (ci + mi > 0) add(m, file, Number(attr(ln[1]!, 'nr')), ci);
      }
    }
  }
  return m;
}

export function parseGoCover(text: string): LineHits {
  const m: LineHits = new Map();
  for (const l of text.split('\n')) {
    const r = l.match(/^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/);
    if (!r) continue;
    for (let ln = Number(r[2]); ln <= Number(r[3]); ln++) add(m, r[1]!, ln, Number(r[4]));
  }
  return m;
}

export function sniffFormat(file: string, text: string): CoverageFormat | null {
  const b = path.basename(file).toLowerCase();
  if (b.endsWith('.info') || /^SF:/m.test(text.slice(0, 2000))) return 'lcov';
  if (b.endsWith('.json')) return 'istanbul';
  if (/^mode: (set|count|atomic)/.test(text)) return 'go';
  if (/<report\b/.test(text.slice(0, 4000)) && /<sourcefile|<package/.test(text)) return 'jacoco';
  if (/<coverage\b/.test(text.slice(0, 4000))) return 'cobertura';
  return null;
}

export function parseReport(file: string, text: string): LineHits | null {
  const f = sniffFormat(file, text);
  try {
    return f === 'lcov' ? parseLcov(text) : f === 'istanbul' ? parseIstanbul(text) : f === 'cobertura' ? parseCobertura(text) : f === 'jacoco' ? parseJacoco(text) : f === 'go' ? parseGoCover(text) : null;
  } catch { return null; }
}

const REPORT_NAMES = new Set(['lcov.info', 'coverage-final.json', 'coverage.xml', 'cobertura.xml', 'cobertura-coverage.xml', 'jacoco.xml', 'cover.out', 'coverage.out']);
const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'vendor']);

/** Find coverage reports under root (depth-limited; includes coverage/, build/, target/site/jacoco, packages/x/coverage, ...). */
export async function findReports(root: string, maxDepth = 5): Promise<string[]> {
  const out: string[] = [];
  const rec = async (dir: string, depth: number) => {
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { if (depth < maxDepth && !SKIP.has(e.name) && (!e.name.startsWith('.') || e.name === '.coverage')) await rec(abs, depth + 1); }
      else if (REPORT_NAMES.has(e.name)) out.push(abs);
    }
  };
  await rec(root, 0);
  // prefer lcov over istanbul json in the same dir (same data)
  return out.filter((f) => !(path.basename(f) === 'coverage-final.json' && out.includes(path.join(path.dirname(f), 'lcov.info'))));
}

/** Map a report's file path onto a repo-relative path. */
export function makeResolver(root: string, repoFiles: string[]): (p: string) => string | null {
  const set = new Set(repoFiles);
  const byBase = new Map<string, string[]>();
  for (const f of repoFiles) { const b = path.posix.basename(f); byBase.set(b, [...(byBase.get(b) ?? []), f]); }
  return (p) => {
    let q = p.replace(/\\/g, '/').replace(/^file:\/\//, '');
    const r = root.replace(/\\/g, '/').replace(/\/$/, '');
    if (q.startsWith(r + '/')) q = q.slice(r.length + 1);
    q = q.replace(/^\.\//, '');
    if (set.has(q)) return q;
    const cands = (byBase.get(path.posix.basename(q)) ?? []).filter((f) => q.endsWith('/' + f) || f.endsWith('/' + q));
    if (!cands.length) return null;
    return cands.sort((a, b) => b.length - a.length)[0]!; // longest common suffix wins
  };
}

/** Ingest reports and produce compact per-file covered/uncovered line sets keyed by repo-relative path. */
export async function ingestCoverage(root: string, repoFiles: string[], manual?: string): Promise<Coverage> {
  const reports = manual ? [path.resolve(root, manual)] : await findReports(root);
  const resolve = makeResolver(root, repoFiles);
  const merged: LineHits = new Map();
  const used: string[] = [];
  for (const rp of reports) {
    const text = await fs.readFile(rp, 'utf8').catch(() => null);
    if (text == null) continue;
    const parsed = parseReport(rp, text);
    if (!parsed) continue;
    let any = false;
    for (const [f, lines] of parsed) {
      const rel = resolve(f);
      if (!rel) continue;
      any = true;
      for (const [l, h] of lines) add(merged, rel, l, h);
    }
    if (any) used.push(path.relative(root, rp) || rp);
  }
  const files: Coverage['files'] = {};
  for (const [f, lines] of merged) {
    const cov: number[] = [], unc: number[] = [];
    for (const [l, h] of lines) (h > 0 ? cov : unc).push(l);
    files[f] = { covered: encodeRanges(cov), uncovered: encodeRanges(unc) };
  }
  return { available: used.length > 0, reports: used, files };
}
