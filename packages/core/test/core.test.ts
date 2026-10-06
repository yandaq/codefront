import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scan } from '../src/index.js';
import type { TreeNode } from '@grim-repo/schema';
import { SnapshotSchema } from '@grim-repo/schema';

let dir: string;
const find = (n: TreeNode, p: string): TreeNode | undefined => n.path === p && n.kind === 'file' ? n : n.children?.map((c) => find(c, p)).find(Boolean);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'grim-fixture-'));
  const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };
  w('.gitignore', 'ignored.ts\nsecret/\n');
  w('ignored.ts', 'const a = 1;\n');
  w('secret/x.ts', 'const a = 1;\n');
  w('node_modules/pkg/index.js', 'module.exports = 1;\n');
  w('dist/out.js', 'x();\n');
  w('lib.min.js', 'x();\n');
  w('package-lock.json', '{}\n');
  w('README.md', '# hi\n');
  w('config.yaml', 'enabled: true\n');
  w('src/app.ts', [
    '// header comment',
    'import fs from "fs";',
    '',
    '/** doc */',
    'export class Greeter {',
    '  name = "x";',
    '  greet(who: string) {',
    '    // inner',
    '    const msg = "hi " + who;',
    '    return msg;',
    '  }',
    '  bye() {',
    '    return 1;',
    '  }',
    '}',
    '',
    'export function main() {',
    '  const g = new Greeter();',
    '  /* block',
    '     comment */',
    '  g.greet("a");',
    '  return g;',
    '}',
    '',
    'const helper = () => {',
    '  return 42;',
    '};',
    'console.log(main());',
    '',
  ].join('\n'));
  w('py/mod.py', [
    '"""Module docstring."""',
    'import os',
    '',
    'class Foo:',
    '    """Doc."""',
    '    def a(self):',
    '        # comment',
    '        x = 1',
    '        return x',
    '',
    '    def b(self):',
    '        return 2',
    '',
    'def top(y):',
    '    def nested():',
    '        return y',
    '    return nested()',
    '',
    'print(top(1))',
    '',
  ].join('\n'));
});

describe('scan', () => {
  it('respects exclusions and gitignore', async () => {
    const s = await scan(dir);
    SnapshotSchema.parse(s);
    const files: string[] = [];
    const walk = (n: TreeNode) => (n.kind === 'file' ? files.push(n.path) : n.children?.forEach(walk));
    walk(s.root);
    expect(files.sort()).toEqual(['.gitignore', 'README.md', 'config.yaml', 'py/mod.py', 'src/app.ts']);
    const hidden = await scan(dir, { showDocs: false });
    const hiddenFiles: string[] = [];
    const collect = (n: TreeNode) => (n.kind === 'file' ? hiddenFiles.push(n.path) : n.children?.forEach(collect));
    collect(hidden.root);
    expect(hiddenFiles.sort()).toEqual(['py/mod.py', 'src/app.ts']);
  });

  it('computes SLOC and splits TS into classes/functions', async () => {
    const s = await scan(dir);
    const f = find(s.root, 'src/app.ts')!;
    expect(f.sloc).toBe(20);
    const names = f.children!.map((c) => `${c.kind}:${c.name}:${c.sloc}`).sort();
    expect(names).toEqual(['class:Greeter:10', 'function:helper:3', 'function:main:5', 'module-scope:module scope:2'].sort());
    const greeter = f.children!.find((c) => c.name === 'Greeter')!;
    expect(greeter.children!.map((c) => `${c.name}:${c.sloc}`).sort()).toEqual(['bye:3', 'class scope:3', 'greet:4'].sort());
    expect(f.children!.reduce((a, c) => a + c.sloc, 0)).toBe(f.sloc);
  });

  it('splits Python, merges nested functions, strips docstrings', async () => {
    const s = await scan(dir);
    const f = find(s.root, 'py/mod.py')!;
    expect(f.sloc).toBe(12);
    const names = f.children!.map((c) => `${c.kind}:${c.name}:${c.sloc}`).sort();
    expect(names).toEqual(['class:Foo:6', 'function:top:4', 'module-scope:module scope:2'].sort());
  });
});
