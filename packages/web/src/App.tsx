import { useEffect, useState } from 'react';
import type { Snapshot } from '@grim-repo/schema';
import { Treemap } from './Treemap';

export function App() {
  const [path, setPath] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);

  const run = async (p: string) => {
    if (!p) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setSnap(body);
      const u = new URL(location.href); u.searchParams.set('path', p); history.replaceState(null, '', u);
    } catch (e) { setError(String((e as Error).message)); } finally { setLoading(false); }
  };

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('path');
    if (q) { setPath(q); run(q); return; }
    fetch('/api/config').then((r) => r.json()).then((c) => { if (c.defaultPath) { setPath(c.defaultPath); run(c.defaultPath); } }).catch(() => {});
  }, []);

  return (
    <div className="relative h-full w-full font-sans">
      {snap && <Treemap snapshot={snap} onFocusChange={setCrumbs} focusRequest={focusReq} />}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3">
        <form className="glass pointer-events-auto flex items-center gap-3 rounded-xl px-3 py-2" onSubmit={(e) => { e.preventDefault(); run(path); }}>
          <span className="font-mono text-sm font-semibold tracking-widest text-cyan-300">GRIM<span className="text-slate-500">·</span>REPO</span>
          <input className="flex-1 rounded-md border border-cyan-400/20 bg-slate-950/60 px-3 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-cyan-400/60 focus:shadow-[0_0_12px_rgba(34,211,238,0.25)]"
            placeholder="/path/to/local/repo" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-4 py-1.5 text-sm font-medium text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50" disabled={loading}>
            {loading ? 'Scanning…' : 'Scan'}
          </button>
          {snap && <span className="font-mono text-xs text-slate-400">{snap.stats.files.toLocaleString()} files · {snap.stats.sloc.toLocaleString()} SLOC · {snap.stats.durationMs}ms</span>}
        </form>
        {error && <div className="glass pointer-events-auto rounded-lg px-3 py-2 text-sm text-rose-300">{error}</div>}
        {crumbs.length > 0 && (
          <nav className="glass pointer-events-auto flex w-fit items-center gap-1 rounded-lg px-3 py-1.5 font-mono text-xs">
            {crumbs.map((c, i) => (
              <span key={c.id + i} className="flex items-center gap-1">
                {i > 0 && <span className="text-slate-600">/</span>}
                <button className={i === crumbs.length - 1 ? 'text-cyan-200' : 'text-slate-400 hover:text-cyan-300'} onClick={() => setFocusReq({ id: c.id, n: Date.now() })}>{c.name}</button>
              </span>
            ))}
          </nav>
        )}
      </div>
      {!snap && !loading && (
        <div className="flex h-full items-center justify-center text-slate-500"><p className="font-mono text-sm">Enter a local path to scan.</p></div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-slate-600">scroll to zoom · drag to pan · click to dive · right-click / Esc to go up</div>
    </div>
  );
}
