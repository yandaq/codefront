import path from 'node:path';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { codefrontHome } from '@codefront/core';

const PKG = 'codefront';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Installed version, read from the package.json next to dist/ (or src/ in development). */
export const currentVersion = (): string =>
  JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/** True if `latest` is a newer release than `current`. Prerelease versions are never offered. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string) => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined);
  const a = parse(latest), b = parse(current.split('-')[0]!);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! > b[i]!;
  return false;
}

async function fetchLatest(timeoutMs: number): Promise<string | undefined> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${PKG}/latest`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? ((await res.json()) as { version?: string }).version : undefined;
  } catch { return undefined; }
}

/** npx runs a fresh copy anyway, so update hints only make sense for installed copies. */
const viaNpx = () => process.env.npm_command === 'exec' || /[\\/]_npx[\\/]/.test(process.argv[1] ?? '');

/**
 * Print a one-line notice if a newer version is on npm. Checks at most once a day (state in
 * ~/.codefront/update-check.json), never blocks for long, and stays silent on any failure.
 * Disabled under npx, in CI, or with CODEFRONT_NO_UPDATE_CHECK=1.
 */
export async function notifyIfOutdated(): Promise<void> {
  if (process.env.CODEFRONT_NO_UPDATE_CHECK || process.env.CI || viaNpx()) return;
  const file = path.join(codefrontHome(), 'update-check.json');
  let state: { checkedAt?: number; latest?: string } = {};
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch { /* first run */ }
  if (!state.checkedAt || Date.now() - state.checkedAt > CHECK_INTERVAL_MS) {
    const latest = await fetchLatest(1500);
    if (latest) {
      state = { checkedAt: Date.now(), latest };
      try { await mkdir(codefrontHome(), { recursive: true }); await writeFile(file, JSON.stringify(state)); } catch { /* read-only home */ }
    }
  }
  const current = currentVersion();
  if (state.latest && isNewer(state.latest, current)) {
    console.log(`codefront ${state.latest} is available (you have ${current}) — run \`codefront update\``);
  }
}

/** `codefront update`: reinstall the latest version globally with npm. Returns the exit code. */
export async function runUpdate(): Promise<number> {
  const current = currentVersion();
  const latest = await fetchLatest(10_000);
  if (latest && !isNewer(latest, current)) {
    console.log(`codefront ${current} is already the latest version.`);
    return 0;
  }
  console.log(latest ? `Updating codefront ${current} → ${latest}…` : 'Updating codefront…');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const code = await new Promise<number>((resolve) => {
    const child = spawn(npm, ['install', '-g', `${PKG}@latest`], { stdio: 'inherit', shell: process.platform === 'win32' });
    child.on('error', () => resolve(1));
    child.on('exit', (c) => resolve(c ?? 1));
  });
  if (code !== 0) console.error(`Update failed. Try running it yourself: npm install -g ${PKG}@latest`);
  return code;
}
