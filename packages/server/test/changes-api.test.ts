import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const node20 = Number(process.versions.node.split('.')[0]) >= 20;

describe.skipIf(!node20)('changes API arg validation', () => {
  let srv: { close: () => Promise<void> }, base: string, dir: string;
  beforeAll(async () => {
    process.env.GRIM_REPO_HOME = mkdtempSync(path.join(tmpdir(), 'grim-api-home-'));
    dir = mkdtempSync(path.join(tmpdir(), 'grim-api-'));
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env }); execFileSync('git', ['commit', '-qm', 'one'], { cwd: dir, env });
    writeFileSync(path.join(dir, 'a.ts'), 'export const a = 2;\n');
    execFileSync('git', ['commit', '-qam', 'two'], { cwd: dir, env });
    const { startServer } = await import('../src/index.js');
    const s = await startServer({ webRoot: dir });
    srv = s; base = s.address;
    await fetch(`${base}/api/scan?path=${encodeURIComponent(dir)}`);
  });
  afterAll(() => srv?.close());
  const get = (p: string, q: Record<string, string>) => fetch(`${base}${p}?${new URLSearchParams({ root: dir, ...q })}`);

  it('lists commits and diffs a valid range', async () => {
    const c = await (await get('/api/commits', { branch: 'main' })).json();
    expect(c.commits.map((x: { subject: string }) => x.subject)).toEqual(['two', 'one']);
    const d = await get('/api/diff', { from: c.commits[1].sha, to: 'main' });
    expect(d.status).toBe(200);
    expect((await d.json()).files[0].path).toBe('a.ts');
  });
  it('rejects option-like or unknown refs and unscanned roots', async () => {
    for (const bad of ['--upload-pack=touch /tmp/pwned', '-c', 'main..HEAD', 'main;id', 'nope']) {
      expect((await get('/api/commits', { branch: bad })).status).toBe(400);
      expect((await get('/api/diff', { from: bad, to: 'main' })).status).toBe(400);
    }
    expect((await get('/api/diff', { root: '/', from: 'main', to: 'main' })).status).toBe(404);
  });
});
