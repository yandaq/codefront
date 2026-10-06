import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ThemedToken } from 'shiki/core';
import { decodeRanges, type Snapshot } from '@grim-repo/schema';
import { langOf, tokenize } from './highlight';
import type { PeekReq } from './Inspector';
import { openUrl, type Editor } from './settings';

export function CodePeek({ snap, req, editor, onClose }: { snap: Snapshot; req: PeekReq; editor: Editor; onClose: () => void }) {
  const [lines, setLines] = useState<ThemedToken[][] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let on = true;
    setLines(null); setErr(null);
    fetch(`/api/file?root=${encodeURIComponent(snap.source.path)}&path=${encodeURIComponent(req.path)}`)
      .then(async (r) => { if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? r.statusText); return r.text(); })
      .then((t) => tokenize(t.replace(/\n$/, ''), langOf(req.path, req.language)))
      .then((t) => on && setLines(t))
      .catch((e) => on && setErr(String(e.message ?? e)));
    return () => { on = false; };
  }, [snap, req.path, req.language]);
  const cov = useMemo(() => {
    const f = snap.coverage?.files[req.path];
    return f ? { c: new Set(decodeRanges(f.covered)), u: new Set(decodeRanges(f.uncovered)) } : null;
  }, [snap, req.path]);
  useLayoutEffect(() => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-line="${req.line}"]`);
    if (el && scroller.current) scroller.current.scrollTop = Math.max(0, el.offsetTop - scroller.current.clientHeight / 3);
  }, [lines, req.line]);
  const lo = req.start ?? req.line, hi = req.end ?? req.line;
  const href = openUrl(snap, req.path, req.line, editor);
  return (
    <div data-testid="code-peek" className="glass peek-in fixed bottom-3 left-3 right-[396px] top-20 z-20 flex flex-col overflow-hidden rounded-xl font-mono text-xs">
      <header className="flex items-center gap-3 border-b border-cyan-400/10 px-4 py-2">
        <span className="truncate text-cyan-200">{req.path}<span className="text-slate-500">:{req.line}</span></span>
        {cov && <span className="text-[10px] text-slate-500"><span className="text-emerald-400">▍</span>covered <span className="text-rose-400">▍</span>uncovered</span>}
        {href && <a className="ml-auto rounded border border-slate-500/40 px-2 py-0.5 text-slate-200 hover:bg-slate-400/10" href={href}>Open</a>}
        <button className={`${href ? '' : 'ml-auto '}px-1.5 text-slate-500 hover:text-cyan-200`} onClick={onClose} aria-label="Close code peek">✕</button>
      </header>
      <div ref={scroller} className="relative flex-1 overflow-auto bg-[#0a0e17]/80 py-2 leading-[18px]">
        {err && <div className="px-4 text-rose-300">{err}</div>}
        {!lines && !err && <div className="px-4 text-slate-500">Loading…</div>}
        {lines?.map((l, i) => {
          const n = i + 1, sel = n >= lo && n <= hi;
          const g = cov?.c.has(n) ? 'bg-emerald-400' : cov?.u.has(n) ? 'bg-rose-500' : '';
          return (
            <div key={i} data-line={n} className={`flex whitespace-pre ${sel ? 'bg-cyan-400/10' : ''}`}>
              <span className={`w-[3px] shrink-0 ${g}`} />
              <span className={`w-12 shrink-0 select-none pr-3 text-right ${sel ? 'text-cyan-300' : 'text-slate-600'}`}>{n}</span>
              <span className={sel ? 'border-l border-cyan-400/60 pl-2' : 'border-l border-transparent pl-2'}>{l.map((t, j) => <span key={j} style={{ color: t.color, fontStyle: t.fontStyle === 1 ? 'italic' : undefined }}>{t.content}</span>)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
