import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignoreMod, { type Ignore } from 'ignore';
const ignore = ignoreMod as unknown as () => Ignore;

export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'vendor', 'vendors', 'third_party', 'bower_components', '__pycache__', '.venv', 'venv', '.next', '.turbo', 'coverage', '.cache']);
const LOCKFILES = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'Cargo.lock', 'poetry.lock', 'Pipfile.lock', 'composer.lock', 'Gemfile.lock', 'go.sum', 'bun.lockb', 'uv.lock']);
const DOC_EXT = new Set(['.md', '.mdx', '.txt', '.rst', '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.xml', '.csv', '.lock', '.env', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp']);
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip', '.gz', '.tar', '.wasm', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.mp3', '.mp4', '.mov', '.so', '.dylib', '.dll', '.exe', '.bin', '.class', '.jar', '.pyc', '.o', '.a']);
const MAX_BYTES = 1_000_000;

export interface WalkOptions { showDocs?: boolean }
export interface WalkedFile { rel: string; abs: string }

export function isExcludedName(name: string, showDocs = false): boolean {
  if (LOCKFILES.has(name)) return true;
  if (/\.min\.[a-z0-9]+$/i.test(name) || /\.generated\.[a-z0-9]+$/i.test(name)) return true;
  const ext = path.extname(name).toLowerCase();
  if (BINARY_EXT.has(ext)) return true;
  if (!showDocs && (DOC_EXT.has(ext) || name.startsWith('.'))) return true;
  return false;
}

async function readIgnore(file: string): Promise<string | null> {
  try { return await fs.readFile(file, 'utf8'); } catch { return null; }
}

/** Parse linguist-generated paths from .gitattributes. */
function linguistGenerated(text: string): string[] {
  return text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/\s+/)).filter((p) => p.slice(1).some((a) => a === 'linguist-generated' || a === 'linguist-generated=true' || a === 'linguist-vendored'))
    .map((p) => p[0]!);
}

export async function walk(root: string, opts: WalkOptions = {}): Promise<WalkedFile[]> {
  const out: WalkedFile[] = [];
  type Rule = { base: string; ig: Ignore };
  const recurse = async (dirRel: string, rules: Rule[]) => {
    const dirAbs = path.join(root, dirRel);
    const local = ignore();
    let has = false;
    const gi = await readIgnore(path.join(dirAbs, '.gitignore'));
    if (gi) { local.add(gi); has = true; }
    const ga = await readIgnore(path.join(dirAbs, '.gitattributes'));
    if (ga) { const g = linguistGenerated(ga); if (g.length) { local.add(g); has = true; } }
    const myRules = has ? [...rules, { base: dirRel, ig: local }] : rules;
    let entries;
    try { entries = await fs.readdir(dirAbs, { withFileTypes: true }); } catch { return; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const rel = dirRel ? `${dirRel}/${e.name}` : e.name;
      const isDir = e.isDirectory();
      if (!isDir && !e.isFile()) continue;
      if (isDir && (SKIP_DIRS.has(e.name) || e.name.startsWith('.'))) continue;
      if (!isDir && isExcludedName(e.name, opts.showDocs)) continue;
      const ignored = myRules.some((r) => {
        const sub = r.base ? path.posix.relative(r.base, rel) : rel;
        return r.ig.ignores(isDir ? sub + '/' : sub);
      });
      if (ignored) continue;
      if (isDir) await recurse(rel, myRules);
      else out.push({ rel, abs: path.join(root, rel) });
    }
  };
  await recurse('', []);
  return out;
}

export async function readTextFile(abs: string): Promise<string | null> {
  const st = await fs.stat(abs);
  if (st.size > MAX_BYTES) return null;
  const buf = await fs.readFile(abs);
  if (buf.subarray(0, 8000).includes(0)) return null; // binary
  return buf.toString('utf8');
}

/** Predicate for watchers: true if an absolute path under `root` should be ignored (skip dirs, dot dirs, root .gitignore). */
export async function ignoreFilter(root: string): Promise<(abs: string) => boolean> {
  const ig = ignore();
  const gi = await readIgnore(path.join(root, '.gitignore'));
  if (gi) ig.add(gi);
  return (abs: string) => {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return false;
    if (rel.split('/').some((s) => SKIP_DIRS.has(s) || s.startsWith('.'))) return true;
    return ig.ignores(rel);
  };
}
