import { useEffect, useMemo, useState } from 'react';
import type { ChurnWindow, ProgressMessage, Snapshot, TreeNode } from '@grim-repo/schema';
import { LayerDock } from './LayerDock';
import { makePainter, type LayerId } from './layers';
import { Treemap } from './Treemap';

export function App() {
  const [path, setPath] = useState('');
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crumbs, setCrumbs] = useState<{ id: string; name: string }[]>([]);
  const [layer, setLayer] = useState<LayerId>('type');
  const [win, setWin] = useState<ChurnWindow>('90d');
  const [ages, setAges] = useState<Record<string, number>>({});
  const [ageProgress, setAgeProgress] = useState<number | undefined>(undefined);
  const [hover, setHover] = useState<{ node: TreeNode; x: number; y: number } | null>(null);
  const painter = useMemo(() => (snap ? makePainter(layer, snap, win, ages) : null), [snap, layer, win, ages]);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);

  const run = async (p: string) => {
    if (!p) return;
    setLoading(true); setError(null);
    try {
      const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      setAges({}); setAgeProgress(body.git?.available ? 0 : undefined);
      setSnap(body);
      const u = new URL(location.href); u.searchParams.set('path', p); history.replaceState(null, '', u);
    } catch (e) { setError(String((e as Error).message)); } finally { setLoading(false); }
  };

  // Progress channel: background blame delivers per-function ages as layer updates.
  useEffect(() => {
    if (!snap?.git?.available) return;
    const root = snap.source.path;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/progress`);
    let buf: Record<string, number> = {}, timer = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ProgressMessage;
      if (!('type' in m) || m.type !== 'layer' || m.root !== root) return;
      Object.assign(buf, m.values);
      setAgeProgress(m.total ? m.done / m.total : 1);
      if (!timer) timer = window.setTimeout(() => { const b = buf; buf = {}; timer = 0; setAges((a) => ({ ...a, ...b })); }, 500);
    };
    // catch up on anything delivered before the socket opened
    fetch(`/api/layers/age?path=${encodeURIComponent(root)}`).then((r) => r.json()).then((v) => setAges((a) => ({ ...v, ...a }))).catch(() => {});
    return () => { ws.close(); clearTimeout(timer); };
  }, [snap]);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('path');
    if (q) { setPath(q); run(q); return; }
    fetch('/api/config').then((r) => r.json()).then((c) => { if (c.defaultPath) { setPath(c.defaultPath); run(c.defaultPath); } }).catch(() => {});
  }, []);

  return (
    <div className="relative h-full w-full font-sans">
      {snap && painter && <Treemap snapshot={snap} onFocusChange={setCrumbs} focusRequest={focusReq} painter={painter} onHover={setHover} />}
      {snap && <LayerDock layer={layer} setLayer={setLayer} window={win} setWindow={setWin} gitAvailable={!!snap.git?.available} loading={{ age: ageProgress }} />}
      {hover && painter && (
        <div className="glass pointer-events-none fixed z-10 max-w-sm rounded-lg px-3 py-2 font-mono text-xs" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="truncate text-cyan-200">{hover.node.path || '/'}{hover.node.kind !== 'file' && hover.node.kind !== 'folder' ? ` › ${hover.node.name}` : ''}</div>
          <div className="mt-0.5 text-slate-400">{hover.node.kind} · {hover.node.sloc.toLocaleString()} SLOC</div>
          {layer !== 'type' && <div className="mt-0.5 text-slate-200">{layer}: {painter.describe(hover.node) ?? '—'}</div>}
        </div>
      )}
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
