import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSource, scan, ImportResolver, cognitiveComplexity } from '../src/index.js';
import { SnapshotSchema, type Snapshot } from '@grim-repo/schema';

const mk = (files: Record<string, string>) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'grim-m4-'));
  for (const [rel, s] of Object.entries(files)) { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); }
  return dir;
};

describe('import extraction', () => {
  it('TS: import, re-export, require, dynamic import', async () => {
    const r = await parseSource(`import a from './a'; export * from "./b"; const c = require('./c'); const d = await import('./d'); import type { T } from './t';`, 'typescript');
    expect(r.imports.map((i) => i.spec)).toEqual(expect.arrayContaining(['./a', './b', './c', './d', './t']));
  });
  it('Python: import and from-import', async () => {
    const r = await parseSource(`import os, pkg.mod as m\nfrom . import sib\nfrom ..up import x, y\nfrom pkg.sub import thing\n`, 'python');
    expect(r.imports).toEqual(expect.arrayContaining([{ spec: 'os' }, { spec: 'pkg.mod' }, { spec: '.', names: ['sib'] }, { spec: '..up', names: ['x', 'y'] }, { spec: 'pkg.sub', names: ['thing'] }]));
  });
});

describe('import resolution', () => {
  const files = {
    'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"], "~cfg": ["src/config.ts"] }, }\n}',
    'src/main.ts': '', 'src/util/index.ts': '', 'src/app/x.tsx': '', 'src/config.ts': '', 'src/esm.ts': '',
    'packages/lib/package.json': '{ "name": "@ws/lib", "main": "dist/index.js" }', 'packages/lib/src/index.ts': '', 'packages/lib/src/deep.ts': '',
    'py/pkg/__init__.py': '', 'py/pkg/a.py': '', 'py/pkg/sub/b.py': '', 'py/pkg/sub/__init__.py': '',
  };
  let r: ImportResolver;
  beforeAll(() => { const dir = mk(files); r = new ImportResolver(dir, Object.keys(files).filter((f) => !f.endsWith('.json'))); });
  it('relative + extension + index + TS-ESM .js', () => {
    expect(r.resolve('src/main.ts', { spec: './util' })).toBe('src/util/index.ts');
    expect(r.resolve('src/app/x.tsx', { spec: '../config' })).toBe('src/config.ts');
    expect(r.resolve('src/main.ts', { spec: './esm.js' })).toBe('src/esm.ts');
    expect(r.resolve('src/main.ts', { spec: 'react' })).toBeNull();
  });
  it('tsconfig paths + baseUrl', () => {
    expect(r.resolve('src/main.ts', { spec: '@app/x' })).toBe('src/app/x.tsx');
    expect(r.resolve('src/main.ts', { spec: '~cfg' })).toBe('src/config.ts');
    expect(r.resolve('src/main.ts', { spec: 'src/util' })).toBe('src/util/index.ts');
  });
  it('workspace package names → source entry', () => {
    expect(r.resolve('src/main.ts', { spec: '@ws/lib' })).toBe('packages/lib/src/index.ts');
    expect(r.resolve('src/main.ts', { spec: '@ws/lib/deep' })).toBe('packages/lib/src/deep.ts');
  });
  it('Python relative and absolute', () => {
    expect(r.resolve('py/pkg/sub/b.py', { spec: '..', names: ['a'] })).toBe('py/pkg/a.py');
    expect(r.resolve('py/pkg/a.py', { spec: '.sub.b' })).toBe('py/pkg/sub/b.py');
    expect(r.resolve('py/pkg/a.py', { spec: '.', names: ['sub'] })).toBe('py/pkg/sub/__init__.py');
    expect(r.resolve('py/pkg/a.py', { spec: 'pkg.sub', names: ['b'] })).toBe('py/pkg/sub/b.py');
    expect(r.resolve('py/pkg/a.py', { spec: 'pkg' })).toBe('py/pkg/__init__.py');
    expect(r.resolve('py/pkg/a.py', { spec: 'os' })).toBeNull();
  });
});

describe('coupling in snapshot', () => {
  let snap: Snapshot; let dir: string;
  const commit = (msg: string) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
    execFileSync('git', ['add', '-A'], { cwd: dir, env }); execFileSync('git', ['commit', '-q', '-m', msg], { cwd: dir, env });
  };
  const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };
  beforeAll(async () => {
    dir = mk({ 'a.ts': `import { b } from './b';\nimport { b as b2 } from './b';\nimport x from 'lodash';\nexport const a = b;\n`, 'b.ts': 'export const b = 1;\n', 'c.ts': 'export const c = 1;\n' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    commit('init'); // a b c
    w('a.ts', `import { b } from './b';\nimport { b as b2 } from './b';\nimport x from 'lodash';\nexport const a = b + 1;\n`); w('b.ts', 'export const b = 2;\n'); commit('ab');
    w('a.ts', `import { b } from './b';\nimport { b as b2 } from './b';\nimport x from 'lodash';\nexport const a = b + 2;\n`); w('b.ts', 'export const b = 3;\n'); commit('ab2');
    w('c.ts', 'export const c = 2;\n'); commit('c');
    for (let i = 0; i < 51; i++) w(`bulk/f${i}.ts`, `export const v = ${i};\n`);
    w('a.ts', 'export const a = 0;\n'); w('c.ts', 'export const c = 3;\n'); commit('bulk'); // skipped (>50 files)
    w('a.ts', `import { b } from './b';\nimport { b as b2 } from './b';\nimport x from 'lodash';\nexport const a = b;\n`); commit('restore');
    snap = await scan(dir);
  });
  it('import edges with statement weights and unresolved counts', () => {
    SnapshotSchema.parse(snap);
    const c = snap.coupling!;
    const e = c.imports.map(([a, b, n]) => [c.files[a], c.files[b], n]);
    expect(e).toEqual([['a.ts', 'b.ts', 2]]);
    expect(c.unresolved['a.ts']).toBe(1);
  });
  it('co-change pairs + confidence, skipping bulk commits', () => {
    const c = snap.coupling!;
    const pairs = Object.fromEntries(c.cochange.map(([a, b, n, conf]) => [`${c.files[a]}|${c.files[b]}`, [n, conf]]));
    // a: init, ab, ab2, restore = 4 (bulk skipped); b: init, ab, ab2 = 3; shared = 3 → 3/3
    expect(pairs['a.ts|b.ts']).toEqual([3, 1]);
    // a/c share only init (bulk skipped) → dropped (< 2)
    expect(pairs['a.ts|c.ts']).toBeUndefined();
  });
});

describe('complexity option 2: named inner functions scored separately', () => {
  const items = async (src: string, lang: 'typescript' | 'python') => Object.fromEntries((await parseSource(src, lang)).items.map((i) => [i.name, i.cx]));
  it('TS: named inners excluded from parent, anonymous callbacks included; displayed = max', async () => {
    const r = await items(`
function outer(xs: number[]) {
  if (xs) {}                                   // +1
  xs.forEach((x) => { if (x) {} });            // anonymous: if at nesting 1 → +2
  function inner(a: number) { if (a) { if (a) {} if (a) {} if (a) {} } } // named: 1+2+2+2 = 7 (separate)
  const helper = (b: number) => b ? 1 : 0;     // named arrow: 1 (separate)
  const o = { m: () => { if (xs) {} } };       // object property: separate
}`, 'typescript');
    expect(r.outer).toBe(7); // own = 3, max with inner 7
  });
  it('own score excludes named inners', async () => {
    const r = await parseSource(`function outer(x) { if (x) {} function inner() { if (x) {} } }`, 'javascript');
    expect(r.items[0]!.cx).toBe(1); // own 1, inner 1 → max 1 (would be 3 if rolled up)
  });
  it('Python: nested def separate, lambda counts', async () => {
    const r = await items(`
def top(y):
    if y:                 # +1
        pass
    f = lambda v: 1 if v else 0   # anonymous: ternary at nesting 1 → +2
    def nested():
        if y:
            if y:
                pass      # 1 + 2 = 3 separate
    return nested
`, 'python');
    expect(r.top).toBe(3);
  });
});
