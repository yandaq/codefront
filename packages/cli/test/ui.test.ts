import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

const bin = path.resolve(__dirname, '../dist/index.js');
// The server and playwright-core both need Node 20+ (pnpm may run vitest on an older Node via Volta).
const node20 = Number(process.versions.node.split('.')[0]) >= 20;
const { chromium } = node20 ? await import('playwright-core') : ({} as typeof import('playwright-core'));
const hasBrowser = node20 && (() => { try { return existsSync(chromium.executablePath()); } catch { return false; } })();

// Regression: function/class sub-squares must actually be drawn inside a file once zoomed in.
describe.skipIf(!existsSync(bin) || !existsSync(path.resolve(__dirname, '../dist/web/index.html')) || !hasBrowser)('treemap UI (headless Chromium)', () => {
  it('draws function tiles inside a zoomed file', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'grim-ui-'));
    const home = mkdtempSync(path.join(tmpdir(), 'grim-ui-home-'));
    mkdirSync(path.join(dir, 'src'));
    const fns = Array.from({ length: 4 }, (_, i) => `export function f${i}(x: number) {\n${'  x = x + 1;\n'.repeat(20)}  return x;\n}\n`).join('\n');
    writeFileSync(path.join(dir, 'src', 'big.ts'), `export class K {\n  m() { return 1; }\n}\n${fns}`);
    mkdirSync(path.join(dir, 'deep/a/b/c'), { recursive: true });
    writeFileSync(path.join(dir, 'deep/a/b/c/deep.ts'), Array.from({ length: 3 }, (_, i) => `export function d${i}(x: number) {\n${'  x = x + 1;\n'.repeat(12)}  return x;\n}\n`).join('\n'));
    writeFileSync(path.join(dir, 'small.ts'), 'export const y = 1;\n');
    const srv = spawn(process.execPath, [bin, '--no-open', '--port=0', dir], { env: { ...process.env, GRIM_REPO_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    const browser = await chromium.launch();
    try {
      const url = await new Promise<string>((res, rej) => {
        let out = '';
        srv.stdout.on('data', (d) => { out += d; const m = /running at (\S+)/.exec(out); if (m) res(m[1]!); });
        srv.on('exit', () => rej(new Error(`server exited: ${out}`)));
      });
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(url);
      const tiles = () => page.evaluate(() => Number(document.querySelector<HTMLElement>('[data-fn-tiles]')?.dataset.fnTiles ?? 0));
      await page.waitForFunction(() => Number(document.querySelector<HTMLElement>('[data-fn-tiles]')?.dataset.fnTiles ?? 0) > 0, null, { timeout: 15000 });
      // dive root -> src -> big.ts (the file dominates the canvas, so its centre stays under the cursor)
      const box = (await page.locator('canvas').boundingBox())!;
      for (let i = 0; i < 2; i++) { await page.mouse.dblclick(box.x + box.width * 0.4, box.y + box.height / 2); await page.waitForTimeout(1000); }
      await expect.poll(() => page.evaluate(() => document.body.innerText.includes('big.ts'))).toBe(true);
      expect(await tiles()).toBeGreaterThan(0);
      // a single double-click from the overview on a deep file lands straight on that file
      // (wide viewport so the inspector opened by the first click doesn't cover the deep file)
      const p2 = await browser.newPage({ viewport: { width: 2000, height: 800 } });
      await p2.goto(url);
      await p2.waitForFunction(() => Number(document.querySelector<HTMLElement>('[data-fn-tiles]')?.dataset.fnTiles ?? 0) > 0, null, { timeout: 15000 });
      await p2.waitForTimeout(1500);
      const b2 = (await p2.locator('canvas').boundingBox())!;
      await p2.mouse.dblclick(b2.x + b2.width * 0.72, b2.y + b2.height * 0.3);
      await expect.poll(() => p2.evaluate(() => document.querySelector<HTMLElement>('[data-focus]')?.dataset.focus)).toBe('deep/a/b/c/deep.ts');
      await p2.waitForTimeout(1000);
      expect(await p2.evaluate(() => Number(document.querySelector<HTMLElement>('[data-fn-tiles]')?.dataset.fnTiles ?? 0))).toBeGreaterThan(0);
      // Tab toggles the exploded view: data-exploded flips and the gap between sibling folders grows
      const p3 = await browser.newPage({ viewport: { width: 1200, height: 800 } });
      await p3.goto(url);
      await p3.waitForFunction(() => Number(document.querySelector<HTMLElement>('[data-fn-tiles]')?.dataset.fnTiles ?? 0) > 0, null, { timeout: 15000 });
      const gap = () => p3.evaluate(() => {
        const r = (document.querySelector('[data-treemap]') as HTMLElement & { __rect: (id: string) => number[] }).__rect;
        const a = r('src'), b = r('deep');
        return Math.max(a[0]! - b[2]!, b[0]! - a[2]!, a[1]! - b[3]!, b[1]! - a[3]!);
      });
      const exploded = () => p3.evaluate(() => document.querySelector<HTMLElement>('[data-treemap]')?.dataset.exploded);
      expect(await exploded()).toBe('0');
      const g0 = await gap();
      await p3.locator('body').click({ position: { x: 5, y: 790 } }).catch(() => {});
      await p3.keyboard.press('Tab');
      await expect.poll(exploded).toBe('1');
      expect(await gap()).toBeGreaterThan(g0 * 2);
      await p3.keyboard.press('Tab');
      await expect.poll(exploded).toBe('0');
    } finally {
      await browser.close();
      srv.kill();
    }
  }, 60000);
});
