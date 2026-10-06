import { useEffect, useMemo, useState } from 'react';
import type { ChurnWindow, ProgressMessage, Snapshot, TreeNode } from '@grim-repo/schema';
import { LayerDock, type PinState } from './LayerDock';
import { hitCounts, makePainter, type CxOptions, type LayerId } from './layers';
import { Treemap } from './Treemap';
import { Inspector, type PeekReq } from './Inspector';
import { CodePeek } from './CodePeek';
import { Palette } from './Palette';
import { indexTree, metricRows } from './metrics';
import { loadEditor, type Editor } from './settings';
import { couplingEdges, couplingStats, type CouplingOptions } from './coupling';

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
  const [cx, setCx] = useState<CxOptions>({ mode: 'max', absolute: false });
  const [pins, setPins] = useState<PinState>({ llm: true, sql: true });
  const [coup, setCoup] = useState<CouplingOptions>({ on: false, mode: 'imports', minConf: 30, minCommits: 5 });
  const edges = useMemo(() => (snap ? couplingEdges(snap, coup) : []), [snap, coup]);
  const hoverCoupling = useMemo(() => (hover && snap ? couplingStats(snap, hover.node) : null), [hover, snap]);
  const painter = useMemo(() => (snap ? makePainter(layer, snap, win, ages, cx) : null), [snap, layer, win, ages, cx]);
  const hits = useMemo(() => (snap ? hitCounts(snap) : new Map()), [snap]);
  const hitTotals = useMemo(() => ({ llm: snap?.hits?.filter((h) => h.kind === 'llm').length ?? 0, sql: snap?.hits?.filter((h) => h.kind === 'sql').length ?? 0 }), [snap]);
  const hoverHits = useMemo(() => {
    if (!hover || !snap?.hits) return null;
    const n = hover.node;
    const inside = (id?: string) => id != null && (id === n.id || (n.kind === 'folder' ? (n.id === '' || id.startsWith(n.id + '/')) : id.startsWith(n.id + '#')));
    const hs = snap.hits.filter((h) => inside(h.nodeId));
    return { llm: hs.filter((h) => h.kind === 'llm').length, sql: hs.filter((h) => h.kind === 'sql').length };
  }, [hover, snap]);
  const [focusReq, setFocusReq] = useState<{ id: string; n: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [peek, setPeek] = useState<PeekReq | null>(null);
  const [palette, setPalette] = useState(false);
  const [editor, setEditor] = useState<Editor>(loadEditor);
  const ix = useMemo(() => (snap ? indexTree(snap.root) : null), [snap]);
  const rows = useMemo(() => (snap && ix ? metricRows(snap, ix, win, ages) : null), [snap, ix, win, ages]);
  const selNode = selected != null ? ix?.byId.get(selected) ?? null : null;
  const select = (n: TreeNode | null) => { setSelected(n ? n.id : null); if (!n) setPeek(null); };
  const selectAndFly = (id: string) => { if (!ix?.byId.has(id)) return; setSelected(id); setFocusReq({ id, n: Date.now() }); };
  useEffect(() => { setSelected(null); setPeek(null); }, [snap]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      else if (e.key === 'Escape' && peek) { e.preventDefault(); setPeek(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek]);

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
      {snap && painter && <Treemap snapshot={snap} onFocusChange={setCrumbs} focusRequest={focusReq} painter={painter} onHover={setHover} pins={pins} hits={hits} edges={edges} edgeMode={coup.mode} selectedId={selected} onSelect={select} />}
      {snap && <LayerDock layer={layer} setLayer={setLayer} window={win} setWindow={setWin} gitAvailable={!!snap.git?.available} loading={{ age: ageProgress }}
        cx={cx} setCx={setCx} coverageAvailable={!!snap.coverage?.available} pins={pins} setPins={setPins} hitTotals={hitTotals}
        coupling={coup} setCoupling={setCoup} couplingAvailable={!!snap.coupling} />}
      {hover && painter && (
        <div className="glass pointer-events-none fixed z-10 max-w-sm rounded-lg px-3 py-2 font-mono text-xs" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="truncate text-cyan-200">{hover.node.path || '/'}{hover.node.kind !== 'file' && hover.node.kind !== 'folder' ? ` › ${hover.node.name}` : ''}</div>
          <div className="mt-0.5 text-slate-400">{hover.node.kind} · {hover.node.sloc.toLocaleString()} SLOC</div>
          {layer !== 'type' && <div className="mt-0.5 text-slate-200">{layer}: {painter.describe(hover.node) ?? '—'}</div>}
          {hoverCoupling && (hoverCoupling.inc > 0 || hoverCoupling.out > 0) && <div className="mt-0.5 text-sky-300">imports: {hoverCoupling.out} out · {hoverCoupling.inc} in</div>}
          {hoverCoupling?.top && <div className="mt-0.5 truncate text-fuchsia-300">co-change: {hoverCoupling.top.path} ({Math.round(hoverCoupling.top.conf * 100)}%, {hoverCoupling.top.n} commits)</div>}
          {hoverHits && (hoverHits.llm > 0 || hoverHits.sql > 0) && (
            <div className="mt-0.5 flex gap-3">
              {hoverHits.llm > 0 && <span className="text-cyan-300">● {hoverHits.llm} LLM prompt{hoverHits.llm > 1 ? 's' : ''}</span>}
              {hoverHits.sql > 0 && <span className="text-amber-400">● {hoverHits.sql} SQL quer{hoverHits.sql > 1 ? 'ies' : 'y'}</span>}
            </div>
          )}
        </div>
      )}
      {snap && ix && rows && selNode && <Inspector snap={snap} node={selNode} ix={ix} rows={rows} onSelect={selectAndFly} onPeek={setPeek} onClose={() => select(null)} editor={editor} setEditor={setEditor} />}
      {snap && peek && <CodePeek snap={snap} req={peek} editor={editor} onClose={() => setPeek(null)} />}
      {snap && ix && palette && <Palette all={ix.all} onClose={() => setPalette(false)} onPick={(n) => { setPalette(false); selectAndFly(n.id); }} />}
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
      <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-slate-600">scroll to zoom · drag to pan · click to inspect · double-click to dive · right-click / Esc to go up · ⌘K search</div>
    </div>
  );
}
