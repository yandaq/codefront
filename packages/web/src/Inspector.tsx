import { useEffect, useMemo, useState } from 'react';
import { contributors, type Hit, type Snapshot, type TreeNode } from '@grim-repo/schema';
import type { Index, MetricRow } from './metrics';
import { openUrl, saveEditor, type Editor } from './settings';
import { langOf, tokenize } from './highlight';
import type { ThemedToken } from 'shiki/core';

export interface PeekReq { path: string; line: number; start?: number; end?: number; language?: string }
interface Props {
  snap: Snapshot; node: TreeNode; ix: Index; rows: (n: TreeNode) => MetricRow[];
  onSelect: (id: string) => void; onPeek: (p: PeekReq) => void; onClose: () => void;
  editor: Editor; setEditor: (e: Editor) => void;
  /** +/- and touching commits within the Changes panel's selection, if any. */
  changes?: { a: number; d: number; commits: { sha: string; subject: string }[] } | null;
  /** Uncommitted local +/- for this node, if any. */
  uncommitted?: { a: number; d: number; added: boolean } | null;
}

const inside = (n: TreeNode, id?: string) => id != null && (id === n.id || (n.kind === 'folder' ? n.id === '' || id.startsWith(n.id + '/') : id.startsWith(n.id + '#') || id.startsWith(n.id + '/')));
const fmtDate = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-t border-cyan-400/10 px-4 py-3">
      <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-cyan-300/70">{title}</h3>
      {children}
    </section>
  );
}

function Sparkline({ times, from, to }: { times: number[]; from: number; to: number }) {
  const N = 48, bins = new Array(N).fill(0) as number[];
  const span = Math.max(1, to - from);
  for (const t of times) bins[Math.min(N - 1, Math.floor(((t - from) / span) * N))]++;
  const max = Math.max(1, ...bins);
  return (
    <svg viewBox={`0 0 ${N * 4} 28`} className="h-7 w-full" preserveAspectRatio="none" data-testid="sparkline">
      {bins.map((b, i) => b > 0 && <rect key={i} x={i * 4} y={28 - (b / max) * 26} width={3} height={(b / max) * 26} fill="#22d3ee" opacity={0.35 + 0.65 * (b / max)} />)}
    </svg>
  );
}

function Snippet({ code, path, language }: { code: string; path: string; language?: string }) {
  const [toks, setToks] = useState<ThemedToken[][] | null>(null);
  useEffect(() => { let on = true; tokenize(code, langOf(path, language)).then((t) => on && setToks(t)).catch(() => {}); return () => { on = false; }; }, [code, path, language]);
  return (
    <pre className="mt-1 max-h-28 overflow-auto rounded bg-slate-950/70 p-2 font-mono text-[10.5px] leading-4">
      {toks ? toks.map((l, i) => <div key={i}>{l.map((t, j) => <span key={j} style={{ color: t.color }}>{t.content}</span>)}{'\n'}</div>) : code}
    </pre>
  );
}

export function Inspector({ snap, node, ix, rows, onSelect, onPeek, onClose, editor, setEditor, changes, uncommitted }: Props) {
  const file = node.kind === 'folder' ? null : ix.fileOf.get(node.id) ?? null;
  const g = node.git ?? file?.git;
  const git = snap.git;
  const metrics = useMemo(() => rows(node), [rows, node]);
  const top = useMemo(() => contributors(g, git, 3), [g, git]);
  const lastIdx = g?.c[g.c.length - 1];
  const lastAuthor = lastIdx != null && git?.authors && git.commitAuthors ? git.authors[git.commitAuthors[lastIdx]!] : undefined;
  const coupling = useMemo(() => {
    const c = snap.coupling;
    if (!c || !file) return null;
    const me = c.files.indexOf(file.path);
    if (me < 0) return { imports: [], importedBy: [], cochange: [] };
    const imports = c.imports.filter(([a]) => a === me).map(([, b, w]) => ({ path: c.files[b]!, w }));
    const importedBy = c.imports.filter(([, b]) => b === me).map(([a, , w]) => ({ path: c.files[a]!, w }));
    const cochange = c.cochange.filter(([a, b]) => a === me || b === me).map(([a, b, n, conf]) => ({ path: c.files[a === me ? b : a]!, n, conf })).sort((x, y) => y.conf - x.conf || y.n - x.n).slice(0, 5);
    return { imports, importedBy, cochange };
  }, [snap, file]);
  const hits = useMemo(() => (snap.hits ?? []).filter((h) => inside(node, h.nodeId)).slice(0, 50), [snap, node]);
  const line = node.startLine ?? 1;
  const href = openUrl(snap, node.path, line, editor);
  const peekNode = () => file && onPeek({ path: file.path, line, start: node.startLine, end: node.endLine, language: file.language });
  const peekHit = (h: Hit) => onPeek({ path: h.file, line: h.startLine, start: h.startLine, end: h.endLine, language: ix.byId.get(h.file)?.language });

  const link = (p: string, extra: React.ReactNode) => (
    <li key={p}>
      <button className="flex w-full items-center justify-between gap-2 truncate rounded px-1 py-0.5 text-left hover:bg-cyan-400/10" onClick={() => onSelect(p)} title={p}>
        <span className="truncate text-slate-300">{p}</span><span className="shrink-0 text-slate-500">{extra}</span>
      </button>
    </li>
  );

  return (
    <aside data-testid="inspector" className="glass inspector-in fixed bottom-3 right-3 top-3 z-20 flex w-[380px] flex-col overflow-hidden rounded-xl font-mono text-xs text-slate-300">
      <header className="flex items-start gap-2 px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="break-all text-[13px] text-cyan-200">{node.kind === 'folder' || node.kind === 'file' ? node.path || '/' : node.name}</div>
          {node.kind !== 'folder' && node.kind !== 'file' && <div className="break-all text-slate-500">{node.path}{node.startLine ? `:${node.startLine}–${node.endLine}` : ''}</div>}
          <div className="mt-1 text-slate-400"><span className="rounded border border-cyan-400/20 px-1.5 py-px text-[10px] uppercase tracking-wider text-cyan-300">{node.kind}</span> {node.sloc.toLocaleString()} SLOC{node.language ? ` · ${node.language}` : ''}</div>
        </div>
        <button className="rounded px-1.5 text-slate-500 hover:text-cyan-200" onClick={onClose} aria-label="Close inspector">✕</button>
      </header>
      <div className="flex items-center gap-2 px-4 pb-3">
        {file && <button className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-2.5 py-1 text-cyan-200 hover:bg-cyan-400/20" onClick={peekNode}>Peek code</button>}
        {file && href && <a className="rounded-md border border-slate-500/40 px-2.5 py-1 text-slate-200 hover:bg-slate-400/10" href={href}>{snap.source.webUrl ? 'Open on host' : 'Open in editor'}</a>}
        {!snap.source.webUrl && (
          <select className="ml-auto rounded border border-slate-600/40 bg-slate-950/60 px-1 py-0.5 text-[10px] text-slate-400" value={editor} onChange={(e) => { const v = e.target.value as Editor; saveEditor(v); setEditor(v); }} aria-label="Editor">
            <option value="vscode">VS Code</option><option value="cursor">Cursor</option><option value="jetbrains">JetBrains</option><option value="none">None</option>
          </select>
        )}
      </div>
      <div className="flex-1 overflow-y-auto">
        {uncommitted && (
          <div data-inspector-uncommitted className="flex justify-between"><span className="text-slate-400">Uncommitted</span><span>{uncommitted.added && <span className="text-slate-400">added </span>}<span className="text-emerald-300">+{uncommitted.a}</span> <span className="text-rose-300">−{uncommitted.d}</span></span></div>
        )}
        {changes && (
          <Section title="In selected commits">
            <div className="flex justify-between"><span className="text-slate-400">Lines</span><span><span className="text-emerald-300">+{changes.a}</span> <span className="text-rose-300">−{changes.d}</span></span></div>
            <ul className="mt-1">{changes.commits.slice(0, 12).map((c) => <li key={c.sha} className="flex gap-2 truncate"><span className="text-cyan-300">{c.sha.slice(0, 7)}</span><span className="truncate text-slate-300">{c.subject}</span></li>)}</ul>
            {changes.commits.length > 12 && <div className="text-slate-500">+{changes.commits.length - 12} more</div>}
          </Section>
        )}
        <Section title="Layers">
          <ul className="space-y-1.5">
            {metrics.map((m) => (
              <li key={m.label}>
                <div className="flex justify-between gap-2"><span className="text-slate-400">{m.label}</span><span className="truncate text-slate-200">{m.value}</span></div>
                <div className="mt-0.5 h-1 rounded bg-slate-800">{m.pct != null && <div className="h-1 rounded bg-gradient-to-r from-cyan-500 to-fuchsia-400" style={{ width: `${Math.max(2, m.pct * 100)}%` }} title={`p${Math.round(m.pct * 100)}`} />}</div>
              </li>
            ))}
          </ul>
        </Section>
        {git?.available && (
          <Section title="Git">
            {g ? (
              <>
                <div className="flex justify-between"><span className="text-slate-400">Last edit</span><span>{fmtDate(g.last)}{lastAuthor ? ` · ${lastAuthor}` : ''}</span></div>
                <div className="flex justify-between"><span className="text-slate-400">Commits</span><span>{g.c.length}</span></div>
                {top.length > 0 && <div className="mt-1.5 text-slate-400">Top contributors</div>}
                <ul>{top.map((c) => <li key={c.name} className="flex justify-between"><span className="truncate text-slate-200">{c.name}</span><span className="text-slate-500">{c.commits} commits · {c.lines.toLocaleString()} lines</span></li>)}</ul>
                <div className="mt-2"><Sparkline times={g.c.map((i) => git.commits[i]!)} from={git.commits[0] ?? 0} to={Date.now() / 1000} /></div>
              </>
            ) : <div className="text-slate-500">untracked</div>}
          </Section>
        )}
        {coupling && (
          <Section title="Coupling">
            <div className="text-slate-400">Imports ({coupling.imports.length})</div>
            <ul className="mb-2">{coupling.imports.slice(0, 12).map((e) => link(e.path, `×${e.w}`))}</ul>
            <div className="text-slate-400">Imported by ({coupling.importedBy.length})</div>
            <ul className="mb-2">{coupling.importedBy.slice(0, 12).map((e) => link(e.path, `×${e.w}`))}</ul>
            <div className="text-slate-400">Co-change partners</div>
            <ul>{coupling.cochange.map((e) => link(e.path, `${Math.round(e.conf * 100)}% · ${e.n}`))}</ul>
          </Section>
        )}
        {hits.length > 0 && (
          <Section title={`Detections (${hits.length})`}>
            <ul className="space-y-2">
              {hits.map((h, i) => (
                <li key={i}>
                  <button className="w-full rounded p-1 text-left hover:bg-cyan-400/5" onClick={() => peekHit(h)}>
                    <div className="flex items-center gap-2">
                      <span className={h.kind === 'llm' ? 'text-cyan-300' : 'text-amber-400'}>● {h.kind.toUpperCase()}</span>
                      <span className="text-slate-400">{h.rule}</span>
                      <span className="ml-auto text-slate-500">{h.file.split('/').pop()}:{h.startLine}</span>
                    </div>
                    {h.sql && <div className="text-amber-200/80">{h.sql.style} {h.sql.op}{h.sql.tables.length ? ` · ${h.sql.tables.join(', ')}` : ''}</div>}
                    <Snippet code={h.snippet} path={h.file} />
                  </button>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </div>
    </aside>
  );
}
