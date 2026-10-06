import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SnapshotSchema } from '@grim-repo/schema';

const bin = path.resolve(__dirname, '../dist/index.js');

describe.skipIf(!existsSync(bin))('headless scan (bundled CLI)', () => {
  it('writes a valid snapshot without starting a server, using the cache on rerun', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'grim-cli-'));
    const home = mkdtempSync(path.join(tmpdir(), 'grim-cli-home-'));
    writeFileSync(path.join(dir, 'a.ts'), 'export function f(x: number) {\n  return x ? 1 : 2;\n}\n');
    writeFileSync(path.join(dir, 'b.rs'), 'fn main() {\n    let x = 1;\n}\n');
    writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
    writeFileSync(path.join(dir, 'config.yaml'), 'enabled: true\n');
    const out = path.join(home, 'snap.json');
    const run = (...extra: string[]) => execFileSync(process.execPath, [bin, 'scan', dir, '--out', out, ...extra], { env: { ...process.env, GRIM_REPO_HOME: home }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    run();
    const snap = SnapshotSchema.parse(JSON.parse(readFileSync(out, 'utf8')));
    expect(snap.stats.files).toBe(4);
    expect(snap.stats.parsedFiles).toBe(2);
    expect(snap.source).toMatchObject({ type: 'local', path: dir });
    run();
    expect(JSON.parse(readFileSync(out, 'utf8')).stats).toMatchObject({ cacheHits: 4, cacheMisses: 0 });
    run('--no-docs');
    expect(JSON.parse(readFileSync(out, 'utf8')).stats.files).toBe(2);
  }, 30000);
});
