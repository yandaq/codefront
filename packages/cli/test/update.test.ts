import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isNewer } from '../src/update.js';

describe('isNewer', () => {
  it('compares release versions numerically', () => {
    expect(isNewer('0.2.0', '0.1.0')).toBe(true);
    expect(isNewer('0.10.0', '0.9.9')).toBe(true);
    expect(isNewer('1.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1.0', '0.2.0')).toBe(false);
  });
  it('never offers prerelease or malformed versions', () => {
    expect(isNewer('0.0.0-stage', '0.1.0')).toBe(false);
    expect(isNewer('2.0.0-beta.1', '1.0.0')).toBe(false);
    expect(isNewer('garbage', '1.0.0')).toBe(false);
  });
});

describe('update notice (bundled CLI)', () => {
  const bin = path.resolve(__dirname, '../dist/index.js');
  const run = (env: Record<string, string>) => new Promise<string>((resolve) => {
    const home = mkdtempSync(path.join(tmpdir(), 'codefront-upd-home-'));
    writeFileSync(path.join(home, 'update-check.json'), JSON.stringify({ checkedAt: Date.now(), latest: '99.0.0' }));
    const dir = mkdtempSync(path.join(tmpdir(), 'codefront-upd-'));
    const { CI: _ci, npm_command: _npm, ...base } = process.env;
    const srv = spawn(process.execPath, [bin, '--no-open', '--port=0', dir], { env: { ...base, CODEFRONT_HOME: home, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    srv.stdout.on('data', (d) => { out += d; });
    setTimeout(() => { srv.kill(); resolve(out); }, 2500);
  });

  it('prints a notice when a newer version is cached', async () => {
    expect(await run({})).toMatch(/codefront 99\.0\.0 is available .* run `codefront update`/);
  });
  it('stays quiet when disabled', async () => {
    expect(await run({ CODEFRONT_NO_UPDATE_CHECK: '1' })).not.toMatch(/is available/);
  });
});
