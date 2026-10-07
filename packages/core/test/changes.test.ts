import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scan, findFile, diffRange, listCommits, mapLine, resolveRef, refShapeOk, gitBranches, EMPTY_TREE } from '../src/index.js';
import type { Snapshot, TreeNode } from '@codefront/schema';

let dir: string;
let snap: Snapshot;
const sha: Record<string, string> = {};
const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };
const fn = (name: string, body: number) => `export function ${name}(x: number) {\n${'  x = x + 1;\n'.repeat(body)}  return x;\n}\n`;
function commit(name: string) {
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', name], { cwd: dir, env });
  sha[name] = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
}
const ff = (rel: string) => findFile(snap.root, rel);
const fnId = (file: string, name: string) => {
  const hit = (n: TreeNode): TreeNode | undefined => (n.name === name && n.kind !== 'file' ? n : n.children?.map(hit).find(Boolean));
  return hit(ff(file)!)!.id;
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'codefront-changes-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  w('a.ts', fn('f', 3) + '\n' + fn('g', 3));
  w('old.ts', 'export const gone = [\n' + Array.from({ length: 6 }, (_, i) => `  'item-${i}',\n`).join('') + '];\n');
  w('mv.ts', fn('moved', 8));
  commit('c1');
  // c2: modify g (line 9 = first body line of g), add new.ts
  w('a.ts', fn('f', 3) + '\n' + fn('g', 3).replace('x = x + 1;', 'x = x * 2;'));
  w('new.ts', fn('h', 4));
  commit('c2');
  // c3: delete old.ts, rename mv.ts -> moved.ts
  rmSync(path.join(dir, 'old.ts'));
  renameSync(path.join(dir, 'mv.ts'), path.join(dir, 'moved.ts'));
  commit('c3');
  // c4: insert a new function above f, shifting everything in a.ts down by 6 lines
  w('a.ts', fn('pre', 2) + fn('f', 3) + '\n' + fn('g', 3).replace('x = x + 1;', 'x = x * 2;'));
  commit('c4');
  snap = await scan(dir);
});

describe('changes / diff', () => {
  it('lists commits newest first with numstat totals', async () => {
    const cs = await listCommits(dir, 'main');
    expect(cs.map((c) => c.subject)).toEqual(['c4', 'c3', 'c2', 'c1']);
    expect(cs[2]!.parents).toEqual([sha.c1]);
    expect(cs[2]!.added).toBeGreaterThan(0);
    expect((await listCommits(dir, 'main', 1, 2)).map((c) => c.subject)).toEqual(['c3', 'c2']);
    expect((await gitBranches(dir)).current).toBe('main');
  });

  it('single commit vs first parent: statuses and per-function attribution (to = HEAD)', async () => {
    const r = await diffRange(dir, sha.c3!, sha.c4!, ff);
    const a = r.files.find((f) => f.path === 'a.ts')!;
    expect(a.status).toBe('M');
    expect(r.nodes[fnId('a.ts', 'pre')]).toMatchObject({ s: 'A', a: 5 });
    expect(r.nodes[fnId('a.ts', 'f')]).toBeUndefined();
    expect(r.commits).toBe(1);
  });

  it('range diff with add/delete/rename statuses and "not on map" files', async () => {
    const r = await diffRange(dir, sha.c1!, sha.c3!, ff);
    const by = Object.fromEntries(r.files.map((f) => [f.path, f]));
    expect(by['new.ts']!.status).toBe('A');
    expect(by['old.ts']!.status).toBe('D');
    expect(by['old.ts']!.mapPath).toBeNull();
    expect(by['moved.ts']!).toMatchObject({ status: 'R', oldPath: 'mv.ts', mapPath: 'moved.ts' });
    expect(r.nodes[fnId('new.ts', 'h')]!.s).toBe('A');
    expect(r.commits).toBe(2);
    expect(r.touched['new.ts']).toEqual([sha.c2]);
  });

  it('translates to-side lines into HEAD lines when later commits shift them', async () => {
    // c2 changed g's first body line (line 9 at c2); c4 inserted 6 lines above, so in HEAD it is inside g, not f/pre
    const r = await diffRange(dir, sha.c1!, sha.c2!, ff);
    const g = fnId('a.ts', 'g');
    expect(r.nodes[g]).toMatchObject({ s: 'M', a: 1, d: 1 });
    expect(r.nodes[fnId('a.ts', 'f')]).toBeUndefined();
    expect(r.nodes[fnId('a.ts', 'pre')]).toBeUndefined();
    expect(r.files.find((f) => f.path === 'a.ts')!.fns.map((x) => x.name)).toEqual(['g']);
  });

  it('root commit diffs against the empty tree', async () => {
    const r = await diffRange(dir, EMPTY_TREE, sha.c1!, ff);
    expect(r.files.every((f) => f.status === 'A')).toBe(true);
  });

  it('mapLine shifts, and snaps changed lines to the nearest survivor', () => {
    expect(mapLine(5, [[2, 0, 3, 4]])).toEqual({ line: 9, exact: true });
    expect(mapLine(2, [[2, 0, 3, 4]])).toEqual({ line: 2, exact: true });
    expect(mapLine(4, [[3, 3, 3, 1]])).toEqual({ line: 3, exact: false });
    expect(mapLine(10, [[3, 3, 3, 1]])).toEqual({ line: 8, exact: true });
  });

  it('rejects option-like and malformed refs', async () => {
    for (const bad of ['--upload-pack=touch /tmp/x', '-n', 'a..b', 'HEAD@{1}', 'x y', 'a;b', '', 'main~1']) expect(refShapeOk(bad)).toBe(false);
    await expect(resolveRef(dir, '--output=/tmp/x')).rejects.toThrow(/invalid/);
    await expect(resolveRef(dir, 'nope')).rejects.toThrow(/unknown/);
    expect(await resolveRef(dir, 'main')).toBe(sha.c4);
  });
});

describe('uncommitted changes', () => {
  it('maps untracked documentation in an unborn repository by default', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'codefront-unborn-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: d });
    writeFileSync(path.join(d, 'README.md'), '# New repository\n\nInitial notes.\n');
    const { scanTarget } = await import('../src/index.js');
    const { snapshot } = await scanTarget(d, { useCache: false });
    expect(snapshot.git).toMatchObject({ available: true, commits: [] });
    expect(findFile(snapshot.root, 'README.md')).toBeTruthy();
    expect(snapshot.uncommitted?.files).toContainEqual(expect.objectContaining({ path: 'README.md', status: 'A', mapPath: 'README.md' }));
    const hidden = (await scanTarget(d, { useCache: false, showDocs: false })).snapshot;
    expect(findFile(hidden.root, 'README.md')).toBeNull();
    expect(hidden.uncommitted?.files).toContainEqual(expect.objectContaining({ path: 'README.md', status: 'A', mapPath: null }));
  });

  it('modified, staged, untracked and deleted files; empty after commit', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'codefront-unc-'));
    const wr = (rel: string, s: string) => writeFileSync(path.join(d, rel), s);
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    const g = (...a: string[]) => execFileSync('git', a, { cwd: d, env });
    g('init', '-q', '-b', 'main');
    wr('mod.ts', fn('f', 3) + '\n' + fn('g', 3));
    wr('staged.ts', fn('s', 3));
    wr('del.ts', fn('gone', 3));
    g('add', '-A'); g('commit', '-q', '-m', 'c1');
    wr('mod.ts', fn('f', 3) + '\n' + fn('g', 3).replace('x = x + 1;', 'x = x * 2;')); // unstaged: one line in g
    wr('staged.ts', fn('s', 3) + fn('s2', 2)); g('add', 'staged.ts'); // staged: new function appended
    wr('untracked.ts', fn('u', 2));
    rmSync(path.join(d, 'del.ts'));
    const { scanTarget } = await import('../src/index.js');
    const { snapshot: s } = await scanTarget(d, { useCache: false });
    const u = s.uncommitted!;
    expect(u).toBeTruthy();
    const by = Object.fromEntries(u.files.map((f) => [f.path, f]));
    expect(by['mod.ts']).toMatchObject({ status: 'M', added: 1, deleted: 1 });
    expect(by['mod.ts']!.fns.map((x) => [x.name, x.a, x.d, x.s])).toEqual([['g', 1, 1, 'M']]);
    expect(by['staged.ts']).toMatchObject({ status: 'M', added: 5, deleted: 0 });
    expect(by['staged.ts']!.fns.find((x) => x.name === 's2')).toMatchObject({ a: 5, s: 'A' });
    expect(by['untracked.ts']).toMatchObject({ status: 'A', added: 5, mapPath: 'untracked.ts' });
    expect(u.nodes[findFile(s.root, 'untracked.ts')!.id]!.s).toBe('A');
    expect(by['del.ts']).toMatchObject({ status: 'D', mapPath: null });
    g('add', '-A'); g('commit', '-q', '-m', 'c2');
    const { snapshot: s2 } = await scanTarget(d, { useCache: false });
    expect(s2.uncommitted!.files).toEqual([]);
  });
});
