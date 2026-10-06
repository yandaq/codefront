import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Snapshot, TreeNode } from '@grim-repo/schema';

const node20 = Number(process.versions.node.split('.')[0]) >= 20;

describe.skipIf(!node20)('watch API', () => {
  let srv: { close: () => Promise<void> }, base: string, dir: string;

  const paths = (snapshot: Snapshot) => {
    const out: string[] = [];
    const visit = (node: TreeNode) => {
      if (node.kind === 'file') out.push(node.path);
      else node.children?.forEach(visit);
    };
    visit(snapshot.root);
    return out;
  };
  const cached = async () => (await (await fetch(`${base}/api/cached?path=${encodeURIComponent(dir)}`)).json()) as Snapshot;
  const eventually = async (check: (snapshot: Snapshot) => boolean, timeout = 10_000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      const snapshot = await cached();
      if (check(snapshot)) return snapshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error('watch snapshot did not reach the expected state');
  };

  beforeAll(async () => {
    process.env.GRIM_REPO_HOME = mkdtempSync(path.join(tmpdir(), 'grim-watch-home-'));
    dir = mkdtempSync(path.join(tmpdir(), 'grim-watch-api-'));
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    const { startServer } = await import('../src/index.js');
    const started = await startServer({ webRoot: dir });
    srv = started;
    base = started.address;
    expect((await fetch(`${base}/api/scan?path=${encodeURIComponent(dir)}`)).status).toBe(200);
    const watching = await fetch(`${base}/api/watch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: dir, on: true }),
    });
    expect(watching.status).toBe(200);
    expect(await watching.json()).toEqual({ watching: true });
  });

  afterAll(() => srv?.close());

  it('reconciles file creation, edits, and deletion', async () => {
    const created = path.join(dir, 'created.ts');
    writeFileSync(created, 'export const created = 1;\n');
    const first = await eventually((snapshot) => paths(snapshot).includes('created.ts'));
    const oldHash = first.root.children?.find((node) => node.path === 'created.ts')?.hash;

    writeFileSync(created, 'export const created = 2;\n');
    await eventually((snapshot) => snapshot.root.children?.find((node) => node.path === 'created.ts')?.hash !== oldHash);

    unlinkSync(created);
    await eventually((snapshot) => !paths(snapshot).includes('created.ts'));
  });

  it('rebuilds the watcher after ignore rules change', async () => {
    writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    mkdirSync(path.join(dir, 'ignored'));
    writeFileSync(path.join(dir, 'ignored', 'b.ts'), 'export const b = 1;\n');
    await new Promise((resolve) => setTimeout(resolve, 750));
    expect(paths(await cached())).not.toContain('ignored/b.ts');

    writeFileSync(path.join(dir, '.gitignore'), '');
    await eventually((snapshot) => paths(snapshot).includes('ignored/b.ts'));
  });
});
