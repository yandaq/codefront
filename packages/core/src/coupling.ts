import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GitMetrics } from '@grim-repo/schema';
import type { ImportRef } from './parse.js';

const P = path.posix;
const JS_EXT = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs'];

function readJson(abs: string): any {
  try {
    const t = readFileSync(abs, 'utf8')
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_, s: string | undefined) => s ?? '') // strip comments, keep strings
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(t);
  } catch { return null; }
}

interface TsPaths { dir: string; baseUrl?: string; paths: [string, string[]][] }

/**
 * Resolves import specifiers to repo-relative files. `files` = all scanned repo-relative paths (posix).
 * Handles relative paths (+ extension / index / TS-ESM `.js`→`.ts`), tsconfig/jsconfig `paths` + `baseUrl`,
 * workspace package names (any package.json with a name), and Python relative / package-root absolute imports.
 */
export class ImportResolver {
  private files: Set<string>;
  private tsCache = new Map<string, TsPaths | null>();
  private pkgs = new Map<string, string>(); // package name -> dir
  private pySuffix = new Map<string, string>(); // "a/b/c" (no ext) suffix -> shortest file

  constructor(private root: string, files: string[]) {
    this.files = new Set(files);
    const dirs = new Set<string>(['']);
    for (const f of files) { let d = P.dirname(f); while (d !== '.' && !dirs.has(d)) { dirs.add(d); d = P.dirname(d); } }
    for (const d of dirs) {
      if (d.split('/').includes('node_modules')) continue;
      const pj = path.join(root, d, 'package.json');
      if (!existsSync(pj)) continue;
      const name = readJson(pj)?.name;
      if (typeof name === 'string') this.pkgs.set(name, d);
    }
    for (const f of files) {
      if (!/\.pyi?$/.test(f)) continue;
      const segs = f.replace(/\.pyi?$/, '').replace(/\/__init__$/, '').split('/');
      for (let i = 0; i < segs.length; i++) {
        const k = segs.slice(i).join('/');
        const cur = this.pySuffix.get(k);
        if (!cur || f.length < cur.length) this.pySuffix.set(k, f);
      }
    }
  }

  private file(p: string): string | null { return this.files.has(p) ? p : null; }

  /** Try `p` as file, with extensions, TS-ESM extension swap, and as directory index. */
  private probe(p: string): string | null {
    p = P.normalize(p).replace(/^\.\//, '');
    if (p.startsWith('..')) return null;
    if (this.file(p)) return p;
    const noJs = p.replace(/\.(m|c)?jsx?$/, '');
    for (const base of noJs !== p ? [noJs, p] : [p]) for (const e of JS_EXT) if (this.file(base + e)) return base + e;
    for (const e of JS_EXT) { const ix = P.join(p, 'index' + e); if (this.file(ix)) return ix; }
    return null;
  }

  private tsconfigFor(dir: string): TsPaths | null {
    if (this.tsCache.has(dir)) return this.tsCache.get(dir)!;
    let r: TsPaths | null = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const abs = path.join(this.root, dir, name);
      if (!existsSync(abs)) continue;
      let cfg = readJson(abs), cdir = dir;
      let co = cfg?.compilerOptions ?? {};
      // one level of relative `extends` for paths/baseUrl
      if (!co.paths && !co.baseUrl && typeof cfg?.extends === 'string' && cfg.extends.startsWith('.')) {
        const ext = P.normalize(P.join(dir, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json'));
        const ec = readJson(path.join(this.root, ext));
        if (ec?.compilerOptions) { co = ec.compilerOptions; cdir = P.dirname(ext); }
      }
      if (co.paths || co.baseUrl) {
        const baseUrl = co.baseUrl != null ? P.normalize(P.join(cdir, co.baseUrl)) : undefined;
        r = { dir: baseUrl ?? cdir, baseUrl, paths: Object.entries((co.paths ?? {}) as Record<string, string[]>) };
      }
      break;
    }
    if (!r && dir !== '' && dir !== '.') r = this.tsconfigFor(P.dirname(dir) === '.' ? '' : P.dirname(dir));
    this.tsCache.set(dir, r);
    return r;
  }

  private pkgEntry(dir: string, sub: string): string | null {
    if (sub) return this.probe(P.join(dir, sub)) ?? this.probe(P.join(dir, 'src', sub));
    const pj = readJson(path.join(this.root, dir, 'package.json')) ?? {};
    const cands: string[] = [];
    if (typeof pj.source === 'string') cands.push(pj.source);
    cands.push('src/index');
    for (const k of ['types', 'module', 'main']) if (typeof pj[k] === 'string') {
      cands.push(pj[k]);
      cands.push(pj[k].replace(/^(\.\/)?(dist|lib|build|out)\//, 'src/').replace(/\.d\.ts$/, '.ts'));
    }
    cands.push('index');
    for (const c of cands) { const r = this.probe(P.join(dir, c)); if (r) return r; }
    return null;
  }

  resolve(from: string, imp: ImportRef): string | null {
    const dir = P.dirname(from) === '.' ? '' : P.dirname(from);
    if (/\.pyi?$/.test(from)) return this.resolvePy(dir, imp);
    const s = imp.spec;
    if (s.startsWith('.')) return this.probe(P.join(dir, s));
    if (s.startsWith('/')) return this.probe(s.slice(1));
    const ts = this.tsconfigFor(dir);
    if (ts) {
      for (const [pat, targets] of ts.paths) {
        const star = pat.indexOf('*');
        let m: string | null = null;
        if (star < 0) { if (pat === s) m = ''; }
        else if (s.startsWith(pat.slice(0, star)) && s.endsWith(pat.slice(star + 1)) && s.length >= pat.length - 1) m = s.slice(star, s.length - (pat.length - star - 1));
        if (m == null) continue;
        for (const t of targets) { const r = this.probe(P.join(ts.dir, t.replace('*', m))); if (r) return r; }
      }
      if (ts.baseUrl != null) { const r = this.probe(P.join(ts.baseUrl, s)); if (r) return r; }
    }
    const parts = s.split('/');
    const name = s.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
    const pdir = this.pkgs.get(name);
    if (pdir != null) return this.pkgEntry(pdir, s.slice(name.length + 1));
    return null;
  }

  private resolvePy(dir: string, imp: ImportRef): string | null {
    const m = imp.spec.match(/^(\.*)(.*)$/)!;
    const dots = m[1]!.length, mod = m[2] ? m[2].split('.').join('/') : '';
    const tryMod = (base: string): string | null => this.file(base + '.py') ?? this.file(base + '.pyi') ?? this.file(P.join(base, '__init__.py'));
    if (dots) {
      let base = dir;
      for (let i = 1; i < dots; i++) base = P.dirname(base) === '.' ? '' : P.dirname(base);
      const b = mod ? P.join(base, mod) : base;
      for (const n of imp.names ?? []) { const r = tryMod(P.join(b, n)); if (r) return r; }
      return tryMod(b);
    }
    for (const n of imp.names ?? []) { const r = tryMod(P.join(mod, n)) ?? this.pySuffix.get(`${mod}/${n}`); if (r) return r; }
    return tryMod(mod) ?? this.pySuffix.get(mod) ?? null;
  }
}

/** Directed file→file import edges [from, to, statements]. */
export function importEdges(resolver: ImportResolver, perFile: Map<string, ImportRef[]>): { edges: [string, string, number][]; unresolved: Record<string, number> } {
  const acc = new Map<string, number>();
  const unresolved: Record<string, number> = {};
  for (const [f, imps] of perFile) {
    for (const imp of imps) {
      const t = resolver.resolve(f, imp);
      if (!t) { unresolved[f] = (unresolved[f] ?? 0) + 1; continue; }
      if (t === f) continue;
      const k = `${f}\0${t}`;
      acc.set(k, (acc.get(k) ?? 0) + 1);
    }
  }
  return { edges: [...acc].map(([k, w]) => { const [a, b] = k.split('\0'); return [a!, b!, w]; }), unresolved };
}

/**
 * Co-change pairs from per-file commit indices. Commits touching > `maxFiles` files are skipped.
 * Returns [a, b, shared, confidence] with confidence = shared / min(commitsA, commitsB), keeping shared ≥ minShared.
 */
export function coChange(files: Map<string, GitMetrics>, keep: Set<string>, maxFiles = 50, minShared = 2): [string, string, number, number][] {
  const byCommit = new Map<number, string[]>();
  for (const [f, m] of files) { if (!keep.has(f)) continue; for (const c of m.c) { let l = byCommit.get(c); if (!l) byCommit.set(c, (l = [])); l.push(f); } }
  const count = new Map<string, number>();
  const pairs = new Map<string, number>();
  for (const fs of byCommit.values()) {
    if (fs.length > maxFiles) continue;
    fs.sort();
    for (const f of fs) count.set(f, (count.get(f) ?? 0) + 1);
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) { const k = `${fs[i]}\0${fs[j]}`; pairs.set(k, (pairs.get(k) ?? 0) + 1); }
  }
  const out: [string, string, number, number][] = [];
  for (const [k, n] of pairs) {
    if (n < minShared) continue;
    const [a, b] = k.split('\0') as [string, string];
    out.push([a, b, n, Math.round((n / Math.min(count.get(a)!, count.get(b)!)) * 1000) / 1000]);
  }
  return out.sort((x, y) => y[2] - x[2]);
}
