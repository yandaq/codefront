import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { scan } from '../src/index.js';
import type { TreeNode } from '@codefront/schema';

const file = (n: TreeNode, p: string): TreeNode | undefined => (n.kind === 'file' && n.path === p ? n : n.children?.map((c) => file(c, p)).find(Boolean));
const flat = (n: TreeNode): TreeNode[] => [n, ...(n.children ?? []).flatMap(flat)];
const depthIn = (n: TreeNode): number => (n.children?.length ? 1 + Math.max(...n.children.map(depthIn)) : 0);
const body = (k: number) => '    x = x + 1;\n'.repeat(k);

describe('named inner functions become child tiles', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'codefront-nest-'));
  writeFileSync(path.join(dir, 'w.tsx'), `export default function Workspace() {
  let x = 0;
  x = x + 1;
  x = x + 1;
  function sendQuestion() {
${body(5)}    if (x) { x = 2; }
  }
  const toggleLeft = () => {
${body(4)}  };
  const handlers = {
    onOpen: () => {
${body(4)}    },
  };
  [1, 2].forEach((v) => {
${body(4)}  });
  return <div onClick={() => { x = x + 1; x = x + 2; x = x + 3; }}>{x}</div>;
}
`);
  writeFileSync(path.join(dir, 'k.ts'), `export class K {
  method() {
    let x = 0;
    function level3() {
${body(4)}      function level4() {
${body(4)}        if (x) { x = 1; }
      }
    }
${body(3)}  }
}
`);
  const s = await scan(dir);

  it('splits a TSX component into named inners + body, merges anonymous callbacks', () => {
    const f = file(s.root, 'w.tsx')!;
    const ws = f.children!.find((c) => c.name === 'Workspace')!;
    const names = flat(ws).slice(1).map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['sendQuestion', 'toggleLeft', 'onOpen', 'Workspace body']));
    expect(names.some((n) => n.includes('anonymous'))).toBe(false);
    expect(ws.sloc).toBe(f.sloc);
    expect(ws.children!.reduce((a, c) => a + c.sloc, 0)).toBe(ws.sloc);
    const body = ws.children!.find((c) => c.name === 'Workspace body')!;
    expect(body.kind).toBe('module-scope');
    expect(body.sloc).toBeGreaterThanOrEqual(10); // own lines + forEach callback + JSX arrow
    const sq = ws.children!.find((c) => c.name === 'sendQuestion')!;
    expect(sq.cx).toBe(1);
    expect(sq.startLine).toBe(5);
  });

  it('caps nesting at 3 levels inside a file', () => {
    const f = file(s.root, 'k.ts')!;
    expect(depthIn(f)).toBe(3);
    const all = flat(f).map((n) => n.name);
    expect(all).toContain('level3');
    expect(all).not.toContain('level4');
    const l3 = flat(f).find((n) => n.name === 'level3')!;
    expect(l3.children).toBeUndefined();
    expect(l3.cx).toBe(1); // merged level4's own score
    expect(l3.sloc).toBeGreaterThanOrEqual(11);
  });
});
