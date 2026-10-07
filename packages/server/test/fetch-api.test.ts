import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const node20 = Number(process.versions.node.split('.')[0]) >= 20;
const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, env }).toString().trim();

describe.skipIf(!node20)('POST /api/git/fetch (fetch only)', () => {
  let srv: { close: () => Promise<void> }, base: string, local: string, other: string, plain: string;
  beforeAll(async () => {
    process.env.CODEFRONT_HOME = mkdtempSync(path.join(tmpdir(), 'codefront-fetch-home-'));
    const t = mkdtempSync(path.join(tmpdir(), 'codefront-fetch-'));
    const bare = path.join(t, 'remote.git'); local = path.join(t, 'local'); other = path.join(t, 'other'); plain = path.join(t, 'plain');
    git(t, 'init', '-q', '--bare', '-b', 'main', bare);
    git(t, 'clone', '-q', bare, other);
    writeFileSync(path.join(other, 'a.ts'), 'export const a = 1;\n');
    git(other, 'add', '-A'); git(other, 'commit', '-qm', 'one'); git(other, 'push', '-q', 'origin', 'main');
    git(other, 'push', '-q', 'origin', 'main:doomed');
    git(t, 'clone', '-q', bare, local);
    git(t, 'init', '-q', '-b', 'main', plain);
    writeFileSync(path.join(plain, 'p.ts'), 'export const p = 1;\n');
    git(plain, 'add', '-A'); git(plain, 'commit', '-qm', 'p');
    const { startServer } = await import('../src/index.js');
    const s = await startServer({ webRoot: t });
    srv = s; base = s.address;
    for (const d of [local, plain]) await fetch(`${base}/api/scan?path=${encodeURIComponent(d)}`);
  });
  afterAll(() => srv?.close());

  it('reports remotes; unscanned root is 404', async () => {
    expect((await (await fetch(`${base}/api/git/remotes?root=${encodeURIComponent(local)}`)).json()).remotes).toEqual(['origin']);
    expect((await (await fetch(`${base}/api/git/remotes?root=${encodeURIComponent(plain)}`)).json()).remotes).toEqual([]);
    expect((await (await fetch(`${base}/api/git/branches?root=${encodeURIComponent(local)}`)).json()).branches).toContain('origin/doomed');
    expect((await fetch(`${base}/api/git/fetch?root=${encodeURIComponent('/')}`, { method: 'POST' })).status).toBe(404);
    expect((await fetch(`${base}/api/git/fetch`, { method: 'POST' })).status).toBe(404);
  });

  it('fetches new refs and prunes, leaving HEAD, work tree and local branches alone', async () => {
    const head = git(local, 'rev-parse', 'HEAD'), heads = git(local, 'for-each-ref', 'refs/heads'), status = git(local, 'status', '--porcelain');
    writeFileSync(path.join(other, 'a.ts'), 'export const a = 2;\n');
    git(other, 'commit', '-qam', 'two'); git(other, 'push', '-q', 'origin', 'main');
    git(other, 'push', '-q', 'origin', 'main:feature');
    const post = () => fetch(`${base}/api/git/fetch?root=${encodeURIComponent(local)}`, { method: 'POST' }).then((r) => r.json());
    let r = await post();
    expect(r.remotes[0]).toMatchObject({ name: 'origin', ok: true });
    expect(r.added).toEqual(['origin/feature']);
    expect(r.updated).toEqual(['origin/main']);
    expect(git(local, 'rev-parse', 'origin/main')).toBe(git(other, 'rev-parse', 'HEAD'));
    expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(local, 'for-each-ref', 'refs/heads')).toBe(heads);
    expect(git(local, 'status', '--porcelain')).toBe(status);
    expect(readFileSync(path.join(local, 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const c = await (await fetch(`${base}/api/commits?root=${encodeURIComponent(local)}&branch=origin/feature`)).json();
    expect(c.commits.map((x: { subject: string }) => x.subject)).toEqual(['two', 'one']);
    git(other, 'push', '-q', 'origin', '--delete', 'doomed');
    r = await post();
    expect(r.pruned).toEqual(['origin/doomed']);
    expect(git(local, 'rev-parse', 'HEAD')).toBe(head);
  });
});
