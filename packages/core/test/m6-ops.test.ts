import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  parseGitUrl, parseBranches, matchBranch, isGitUrl, gitProgress, readHistory, scanTarget, analyzeAll, ParsePool, workerScript, walk, readTextFile, findFile,
} from '../src/index.js';

const coreDir = path.resolve(__dirname, '..');

describe('git URL normalisation', () => {
  it('normalises https / ssh / web URLs to one id', () => {
    const forms = [
      'https://github.com/Sindresorhus/Slugify', 'https://github.com/sindresorhus/slugify.git', 'git@github.com:sindresorhus/slugify.git',
      'ssh://git@github.com/sindresorhus/slugify.git', 'https://github.com/sindresorhus/slugify/tree/main', 'https://github.com/sindresorhus/slugify/blob/main/index.js',
    ];
    const ids = new Set(forms.map((f) => parseGitUrl(f).id));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toMatch(/^remote-[0-9a-f]{16}$/);
    expect(parseGitUrl('https://github.com/a/b').id).not.toBe(parseGitUrl('https://gitlab.com/a/b').id);
  });
  it('extracts clone URL, web URL and ref', () => {
    expect(parseGitUrl('https://github.com/o/r/tree/feat/x')).toMatchObject({ cloneUrl: 'https://github.com/o/r.git', webUrl: 'https://github.com/o/r', ref: 'feat/x', host: 'github.com' });
    expect(parseGitUrl('https://gitlab.com/g/sub/r/-/tree/dev')).toMatchObject({ cloneUrl: 'https://gitlab.com/g/sub/r.git', webUrl: 'https://gitlab.com/g/sub/r', ref: 'dev' });
    expect(parseGitUrl('https://bitbucket.org/o/r/src/main/lib')).toMatchObject({ cloneUrl: 'https://bitbucket.org/o/r.git', ref: 'main/lib' });
    expect(parseGitUrl('git@github.com:o/r.git')).toMatchObject({ cloneUrl: 'git@github.com:o/r.git', webUrl: 'https://github.com/o/r', ref: undefined });
    expect(isGitUrl('/Users/x/repo')).toBe(false);
    expect(isGitUrl('git@github.com:o/r')).toBe(true);
    expect(gitProgress('Receiving objects:  45% (9/20)')).toEqual({ phase: 'Receiving objects', pct: 0.45 });
  });
});

describe('branches', () => {
  it('parses remote branch listing', () => {
    expect(parseBranches('origin/HEAD -> origin/main\norigin/main\norigin/feat/x\norigin\n')).toEqual(['feat/x', 'main']);
    expect(parseBranches('origin/HEAD\norigin/dev\n')).toEqual(['dev']);
  });
  it('matches /tree/<branch>/<subpath> to the longest branch', () => {
    expect(matchBranch('feat/x/src/lib', ['main', 'feat/x', 'feat'])).toBe('feat/x');
    expect(matchBranch('nope', ['main'])).toBeNull();
  });
});

let dir: string;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const g = (...a: string[]) => execFileSync('git', a, { cwd: dir, env }).toString();
const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };
const commit = (m: string) => { g('add', '-A'); g('commit', '-q', '-m', m); };

beforeAll(() => {
  process.env.GRIM_REPO_HOME = mkdtempSync(path.join(tmpdir(), 'grim-home-'));
  dir = mkdtempSync(path.join(tmpdir(), 'grim-m6-'));
  g('init', '-q');
  w('src/a.ts', 'export function a(x: number) {\n  if (x) return 1;\n  return 2;\n}\n');
  w('src/b.py', 'def b(x):\n    return x\n');
  w('main.go', 'package main\n\nfunc main() {\n\tprintln(1)\n}\n');
  commit('one');
  w('src/a.ts', 'export function a(x: number) {\n  if (x) return 1;\n  return 3;\n}\n');
  commit('two');
});

describe('blob-SHA analysis cache', () => {
  it('misses on first scan, hits on rescan, re-analyses only dirty/untracked files', async () => {
    const s1 = (await scanTarget(dir, { workers: 0 })).snapshot;
    expect(s1.stats).toMatchObject({ cacheHits: 0, cacheMisses: 3 });
    const s2 = (await scanTarget(dir, { workers: 0 })).snapshot;
    expect(s2.stats).toMatchObject({ cacheHits: 3, cacheMisses: 0 });
    expect(s2.root).toEqual(s1.root);
    w('src/a.ts', 'export function a(x: number) {\n  return 9;\n}\n'); // dirty
    w('src/new.ts', 'export const n = 1;\n'); // untracked
    const s3 = (await scanTarget(dir, { workers: 0 })).snapshot;
    expect(s3.stats).toMatchObject({ cacheHits: 2, cacheMisses: 2 });
    const file = (p: string) => JSON.stringify(s3.root).includes(`"path":"${p}"`);
    expect(file('src/new.ts')).toBe(true);
    const hashOf = (s: typeof s1, p: string) => findFile(s.root, p)?.hash;
    expect(hashOf(s3, 'src/a.ts')).toMatch(/^c:/);
    expect(hashOf(s1, 'src/a.ts')).toMatch(/^[0-9a-f]{40}$/);
    // persisted snapshot for instant reopen
    const cached = JSON.parse(readFileSync(path.join(process.env.GRIM_REPO_HOME!, 'cache', (await scanTarget(dir, { workers: 0 })).target.id, 'snapshot.json'), 'utf8'));
    expect(cached.stats.files).toBe(4);
    g('checkout', '-q', '--', 'src/a.ts'); execFileSync('rm', [path.join(dir, 'src/new.ts')]);
  });
});

describe('incremental git history', () => {
  it('appends commits since the last-seen HEAD, matching a full read', async () => {
    const h1 = await readHistory(dir);
    expect(h1.mode).toBe('full');
    expect((await readHistory(dir, h1.rawHistory)).mode).toBe('unchanged');
    w('src/b.py', 'def b(x):\n    return x * 2\n'); commit('three');
    const inc = await readHistory(dir, h1.rawHistory);
    expect(inc.mode).toBe('incremental');
    const full = await readHistory(dir);
    expect(inc.commits).toEqual(full.commits);
    expect([...inc.files]).toEqual([...full.files]);
    expect(inc.rawHistory.raw.length).toBe(3);
  });
  it('recomputes fully when HEAD is not a descendant', async () => {
    const before = await readHistory(dir);
    g('reset', '-q', '--hard', 'HEAD~1');
    w('src/b.py', 'def b(x):\n    return -x\n'); commit('rewritten');
    const h = await readHistory(dir, before.rawHistory);
    expect(h.mode).toBe('full');
    expect(h.commits.length).toBe(3);
  });
});

describe('worker pool', () => {
  beforeAll(() => { if (!workerScript()) execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], { cwd: coreDir }); });
  it('produces identical results to the sync path', async () => {
    const files = await walk(path.join(coreDir, 'src'));
    const items = await Promise.all(files.map(async (f) => ({ rel: f.rel, text: (await readTextFile(f.abs))! })));
    const pool = ParsePool.create(3);
    expect(pool).not.toBeNull();
    try {
      const [a, b] = [await analyzeAll(items, pool), await analyzeAll(items, null)];
      expect(a).toEqual(b);
      expect(a.filter((x) => x.parsed).length).toBeGreaterThan(5);
    } finally { await pool!.close(); }
  }, 30000);
});
