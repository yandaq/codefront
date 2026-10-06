import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scan, blameTree, renameTarget } from '../src/index.js';
import { churnFor, SnapshotSchema, type Snapshot, type TreeNode } from '@grim-repo/schema';

const DAY = 86400;
const NOW = Math.floor(Date.now() / 1000);
let dir: string;
let snap: Snapshot;
const find = (n: TreeNode, p: string, kind = 'file'): TreeNode | undefined => (n.path === p && n.kind === kind ? n : n.children?.map((c) => find(c, p, kind)).find(Boolean));

function commit(daysAgo: number, msg: string) {
  const date = `${NOW - daysAgo * DAY} +0000`;
  const env = { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  execFileSync('git', ['add', '-A'], { cwd: dir, env });
  execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
}
const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'grim-git-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  w('src/a.ts', 'export function f() {\n  return 1;\n}\n\nexport function g() {\n  return 2;\n}\n');
  w('src/b.ts', 'export const b = 1;\n');
  commit(400, 'init');                 // a, b
  w('src/b.ts', 'export const b = 2;\n');
  commit(60, 'b again');               // b
  w('src/a.ts', 'export function f() {\n  return 1;\n}\n\nexport function g() {\n  return 3;\n}\n');
  commit(10, 'touch g');               // a (only g)
  w('src/b.ts', 'export const b = 3;\nexport const c = 4;\n');
  commit(5, 'b thrice');               // b
  snap = await scan(dir);
});

describe('git history', () => {
  it('parses into the snapshot schema', () => {
    SnapshotSchema.parse(snap);
    expect(snap.git?.available).toBe(true);
    expect(snap.git?.commits).toHaveLength(4);
  });

  it('computes file age from last commit', () => {
    const a = find(snap.root, 'src/a.ts')!, b = find(snap.root, 'src/b.ts')!;
    expect(Math.round((NOW - a.git!.last) / DAY)).toBe(10);
    expect(Math.round((NOW - b.git!.last) / DAY)).toBe(5);
  });

  it('computes churn per window with line churn', () => {
    const c = snap.git!.commits;
    const b = find(snap.root, 'src/b.ts')!;
    expect(churnFor(b.git, c, '30d', NOW)).toEqual({ commits: 1, lines: 3 });
    expect(churnFor(b.git, c, '90d', NOW).commits).toBe(2);
    expect(churnFor(b.git, c, '1y', NOW).commits).toBe(2);
    expect(churnFor(b.git, c, 'all', NOW)).toEqual({ commits: 3, lines: 1 + 2 + 3 });
  });

  it('aggregates folders as the union of commits', () => {
    const c = snap.git!.commits;
    const src = find(snap.root, 'src', 'folder')!;
    expect(churnFor(src.git, c, 'all', NOW).commits).toBe(4); // init counted once
    expect(churnFor(src.git, c, '30d', NOW).commits).toBe(2);
    expect(src.git!.last).toBe(find(snap.root, 'src/b.ts')!.git!.last);
    expect(snap.root.git!.c).toEqual(src.git!.c);
  });

  it('derives per-function age from blame', async () => {
    const ages: Record<string, number> = {};
    let last = { done: 0, total: 0 };
    await blameTree(dir, snap.root, (v, done, total) => { Object.assign(ages, v); last = { done, total }; });
    expect(last.done).toBe(last.total);
    const a = find(snap.root, 'src/a.ts')!;
    const fn = (name: string) => JSON.stringify(a.children).includes(name) && findFn(a, name)!;
    const findFn = (n: TreeNode, name: string): TreeNode | undefined => (n.name === name ? n : n.children?.map((c) => findFn(c, name)).find(Boolean));
    expect(Math.round((NOW - ages[(fn('f') as TreeNode).id]!) / DAY)).toBe(400);
    expect(Math.round((NOW - ages[(fn('g') as TreeNode).id]!) / DAY)).toBe(10);
  });

  it('handles non-git dirs gracefully', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'grim-nogit-'));
    writeFileSync(path.join(d, 'x.ts'), 'const x = 1;\n');
    const s = await scan(d);
    expect(s.git?.available).toBe(false);
    expect(s.root.git).toBeUndefined();
  });

  it('resolves rename notation', () => {
    expect(renameTarget('src/{a => b}/x.ts')).toBe('src/b/x.ts');
    expect(renameTarget('src/{a => }/x.ts')).toBe('src/x.ts');
    expect(renameTarget('old.ts => new.ts')).toBe('new.ts');
  });
});
