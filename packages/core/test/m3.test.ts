import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSource, scan, detectSource, sqlConfidence, parseLcov, parseIstanbul, parseCobertura, parseJacoco, parseGoCover, makeResolver, ingestCoverage } from '../src/index.js';
import { decodeRanges, type TreeNode } from '@grim-repo/schema';

const cx = async (src: string, lang: 'typescript' | 'python') => {
  const r = await parseSource(src, lang);
  return Object.fromEntries(r.items.flatMap((i) => [i, ...i.children]).map((i) => [i.name, i.cx]));
};

describe('cognitive complexity', () => {
  it('TS: nesting, else-if chains, loops, catch, ternary, boolean sequences', async () => {
    const r = await cx(`
function flat() { return 1; }
function a(x: number) {
  if (x > 0) {            // +1
    for (const i of [1]) { // +2 (nesting 1)
      if (i) {}            // +3 (nesting 2)
    }
  } else if (x < 0) {     // +1
  } else {}               // +1
}
function b(p: boolean, q: boolean, r: boolean) {
  try { return p && q && r; } // +1 (one && sequence)
  catch (e) { return p || q && r; } // catch +1, || +1, && +1
}
const c = (x: number) => x ? 1 : 2; // +1
function d(x: number) {
  switch (x) { case 1: break; }  // +1
  while (x) { const f = () => (x ? 1 : 0); } // while +1, ternary inside nested fn: +1 + nesting 2 = 3
}`, 'typescript');
    expect(r.flat).toBe(0);
    expect(r.a).toBe(8);
    expect(r.b).toBe(4);
    expect(r.c).toBe(1);
    expect(r.d).toBe(5);
  });

  it('Python: if/elif/else, loops, except, boolean ops, conditional expression', async () => {
    const r = await cx(`
def f(xs, y):
    for x in xs:          # +1
        if x and y:       # +2 (nesting 1), and +1
            pass
        elif x or y:      # +1, or +1
            pass
        else:             # +1
            pass
    try:
        v = 1 if y else 2 # +1
    except Exception:     # +1
        pass

class K:
    def m(self, a):
        while a:          # +1
            a -= 1
`, 'python');
    expect(r.f).toBe(9);
    expect(r.m).toBe(1);
  });
});

describe('coverage parsers', () => {
  it('lcov', () => {
    const m = parseLcov('TN:\nSF:src/a.ts\nDA:1,1\nDA:2,0\nend_of_record\n');
    expect([...m.get('src/a.ts')!]).toEqual([[1, 1], [2, 0]]);
  });
  it('istanbul json', () => {
    const m = parseIstanbul(JSON.stringify({ '/r/src/a.ts': { path: '/r/src/a.ts', statementMap: { 0: { start: { line: 3 }, end: { line: 3 } }, 1: { start: { line: 5 }, end: { line: 6 } } }, s: { 0: 2, 1: 0 } } }));
    expect([...m.get('/r/src/a.ts')!]).toEqual([[3, 2], [5, 0]]);
  });
  it('cobertura', () => {
    const m = parseCobertura(`<?xml version="1.0"?><coverage><sources><source>/r/pkg</source></sources><packages><package><classes>
      <class name="a" filename="mod/a.py"><lines><line number="1" hits="1"/><line number="2" hits="0"/></lines></class></classes></package></packages></coverage>`);
    expect([...m.get('/r/pkg/mod/a.py')!]).toEqual([[1, 1], [2, 0]]);
  });
  it('jacoco', () => {
    const m = parseJacoco(`<report name="x"><package name="com/acme"><sourcefile name="A.java"><line nr="4" mi="0" ci="3" mb="0" cb="0"/><line nr="5" mi="2" ci="0"/></sourcefile></package></report>`);
    expect([...m.get('com/acme/A.java')!]).toEqual([[4, 3], [5, 0]]);
  });
  it('go cover.out', () => {
    const m = parseGoCover('mode: set\ngithub.com/x/y/main.go:3.10,5.2 2 1\ngithub.com/x/y/main.go:7.1,7.9 1 0\n');
    expect([...m.get('github.com/x/y/main.go')!]).toEqual([[3, 1], [4, 1], [5, 1], [7, 0]]);
  });
  it('path normalisation by suffix', () => {
    const r = makeResolver('/r', ['src/a.ts', 'main.go', 'pkg/mod/a.py']);
    expect(r('/r/src/a.ts')).toBe('src/a.ts');
    expect(r('github.com/x/y/main.go')).toBe('main.go');
    expect(r('/elsewhere/pkg/mod/a.py')).toBe('pkg/mod/a.py');
    expect(r('nope.ts')).toBeNull();
  });
});

describe('detectors', () => {
  const run = async (src: string, lang: 'typescript' | 'python' = 'typescript') => {
    const r = await parseSource(src, lang);
    return detectSource({ file: 'x', lang: lang === 'python' ? 'py' : 'js', strings: r.strings, calls: r.calls });
  };
  it('LLM SDK calls', async () => {
    const h = await run(`
await client.messages.create({ model: 'm', system: 'be nice', messages: [] });
await openai.chat.completions.create({ messages });
await openai.responses.create({ input: 'hi' });
const r = await generateText({ model, prompt: 'x' });`);
    expect(h.filter((x) => x.kind === 'llm').map((x) => x.rule)).toEqual(['anthropic.messages', 'openai.chat', 'openai.responses', 'vercel-ai']);
  });
  it('long prompt literal', async () => {
    const h = await run('const P = `You are a helpful assistant. ' + 'Be concise and accurate. '.repeat(10) + ' Respond in JSON with {{name}}.`;');
    expect(h).toHaveLength(1);
    expect(h[0]!.rule).toBe('prompt-literal');
    expect(h[0]!.confidence).toBeGreaterThan(0.8);
  });
  it('raw SQL with tables and op', async () => {
    const h = await run(`db.query("SELECT id, name FROM users u JOIN orgs o ON o.id = u.org WHERE u.id = $1");\nconst q = 'INSERT INTO audit_log (a, b) VALUES (?, ?)';`);
    const sql = h.filter((x) => x.kind === 'sql');
    expect(sql).toHaveLength(2);
    expect(sql[0]!.sql).toEqual({ style: 'raw', op: 'read', tables: ['users', 'orgs'] });
    expect(sql[1]!.sql!.op).toBe('write');
  });
  it('ORM calls (Prisma, Django, SQLAlchemy)', async () => {
    const js = await run('await prisma.user.findMany({ where: {} }); await prisma.post.create({ data });');
    expect(js.map((x) => [x.rule, x.sql!.op, x.sql!.tables[0]])).toEqual([['prisma', 'read', 'user'], ['prisma', 'write', 'post']]);
    const py = await run('users = User.objects.filter(active=True)\nsession.add(Order())\n', 'python');
    expect(py.map((x) => [x.rule, x.sql!.op])).toEqual([['django', 'read'], ['sqlalchemy', 'write']]);
  });
  it('false-positive guards', async () => {
    const h = await run(`
const a = "Please select an item from the list";
const b = "Update your profile settings";
const c = "delete from the cart";
const d = "You are short"; // prompt marker but too short
log.messages.push('x');`);
    expect(h).toEqual([]);
    expect(sqlConfidence('select the best option from the menu below')).toBe(0);
  });
});

describe('scan integration', () => {
  it('adds complexity, hits (incl. hidden prompts/*.md), coverage', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'grim-m3-'));
    const w = (rel: string, s: string) => { mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); writeFileSync(path.join(dir, rel), s); };
    w('src/a.ts', 'export function f(x: number) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\nexport function g() {\n  return 3;\n}\n');
    w('prompts/system.md', 'You are a bot.\n');
    w('schema.sql', 'CREATE TABLE users (id int);\n');
    w('coverage/lcov.info', `SF:${dir}/src/a.ts\nDA:2,1\nDA:3,1\nDA:5,0\nDA:8,0\nend_of_record\n`);
    const snap = await scan(dir);
    const find = (n: TreeNode, p: string): TreeNode | undefined => (n.path === p && n.kind === 'file' ? n : n.children?.map((c) => find(c, p)).find(Boolean));
    const a = find(snap.root, 'src/a.ts')!;
    expect(a.cx).toBe(1);
    expect(a.cov).toBeCloseTo(0.5);
    expect(snap.coverage!.available).toBe(true);
    expect(decodeRanges(snap.coverage!.files['src/a.ts']!.uncovered)).toEqual([5, 8]);
    expect(snap.root.cov).toBeCloseTo(0.5);
    const rules = snap.hits!.map((h) => h.rule).sort();
    expect(rules).toEqual(['prompts-dir', 'sql-file']);
    expect(snap.hits!.find((h) => h.rule === 'prompts-dir')!.nodeId).toBe('');
    const none = await ingestCoverage(dir, [], 'missing.info');
    expect(none.available).toBe(false);
  });
});
