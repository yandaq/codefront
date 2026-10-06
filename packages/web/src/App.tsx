import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChurnWindow, ProgressMessage, Snapshot, TreeNode, Stage } from '@grim-repo/schema';
import { StatusBar, stageLoading } from './StatusBar';
import { LayerDock, type PinState } from './LayerDock';
import { aggregateChanges, hitCounts, makePainter, type CxOptions, type LayerId } from './layers';
import { ChangesPanel, type ChangeSel } from './ChangesPanel';
import { Treemap } from './Treemap';
import { mergeWsSnapshot } from './snapshot';
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
  const [stages, setStages] = useState<Partial<Record<Stage, number>>>({});
  const [stageMsg, setStageMsg] = useState<string | undefined>(undefined);
  const [branches, setBranches] = useState<string[]>([]);
  const [watching, setWatching] = useState(false);
  const [keytar, setKeytar] = useState<boolean | null>(null);
  const [pat, setPat] = useState<{ host: string; token: string } | null>(null);
  /** The target the user asked for (path or URL); progress messages are tagged with it. */
  const target = useRef('');
  const loadingRef = useRef(false);
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
  const [changes, setChanges] = useState<ChangeSel | null>(null);
  const changeAgg = useMemo(() => (snap && changes ? aggregateChanges(snap.root, changes.diff.nodes) : null), [snap, changes]);
  const layerPainter = useMemo(() => (snap ? makePainter(layer, snap, win, ages, cx) : null), [snap, layer, win, ages, cx]);
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
  // exploded view level: 0 off, 1 medium, 2 large (Tab cycles forward, Shift+Tab back)
  const [exploded, setExploded] = useState(() => { try { const raw = localStorage.getItem('grim.exploded'); if (raw == null) return 1; const v = Number(raw); return v === 0 || v === 2 ? v : 1; } catch { return 1; } });
  useEffect(() => { try { localStorage.setItem('grim.exploded', String(exploded)); } catch { /* storage blocked */ } }, [exploded]);
  const [editor, setEditor] = useState<Editor>(loadEditor);
  const ix = useMemo(() => (snap ? indexTree(snap.root) : null), [snap]);
  const rows = useMemo(() => (snap && ix ? metricRows(snap, ix, win, ages) : null), [snap, ix, win, ages]);
  const painter = layerPainter; // the Changes overlay is drawn on top by the Treemap; it never replaces the fill
  const changeInfo = (n: TreeNode | null) => {
    if (!n || !changes || !changeAgg || !ix) return null;
    const v = changeAgg.get(n.id);
    const file = n.kind === 'folder' ? null : ix.fileOf.get(n.id) ?? n;
    const shas = new Set<string>();
    for (const [p, cs] of Object.entries(changes.diff.touched)) if (file ? p === file.path : n.id === '' || p.startsWith(n.path + '/')) cs.forEach((c) => shas.add(c));
    return { a: v?.a ?? 0, d: v?.d ?? 0, commits: [...shas].map((s) => changes.subjects.get(s) ?? { sha: s, subject: '' }) };
  };
  const selNode = selected != null ? ix?.byId.get(selected) ?? null : null;
  const select = (n: TreeNode | null) => { setSelected(n ? n.id : null); if (!n) setPeek(null); };
  const selectAndFly = (id: string) => { if (!ix?.byId.has(id)) return; setSelected(id); setFocusReq({ id, n: Date.now() }); };
  useEffect(() => { setSelected(null); setPeek(null); }, [snap]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((p) => !p); }
      else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && !palette) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        e.preventDefault(); setExploded((x) => (x + (e.shiftKey ? 2 : 1)) % 3);
      }
      else if (e.key === 'Escape' && peek) { e.preventDefault(); setPeek(null); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [peek, palette]);

  const run = async (p: string, o: { ref?: string; fetch?: boolean; rescan?: boolean } = {}) => {
    if (!p) return;
    const fresh = target.current !== p;
    if (fresh && watching) { setWatching(false); }
    target.current = p;
    setLoading(true); loadingRef.current = true; setError(null); setStages({}); setStageMsg(undefined);
    try {
      // instant reopen from the on-disk cache, then refresh below
      if (fresh && !o.ref) {
        const c = await fetch(`/api/cached?path=${encodeURIComponent(p)}`).catch(() => null);
        if (c?.ok && target.current === p) setSnap(await c.json());
      }
      const res = await fetch('/api/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p, ref: o.ref, fetch: o.fetch }) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? res.statusText);
      if (target.current !== p) return;
      setAgeProgress(body.git?.available ? 0 : undefined);
      if (fresh) setAges({});
      setSnap(body);
      if (body.source?.type === 'remote') fetch(`/api/branches?path=${encodeURIComponent(p)}`).then((r) => r.json()).then((b) => setBranches(b.branches ?? [])).catch(() => {});
      else setBranches([]);
      const u = new URL(location.href); u.searchParams.set('path', p); history.replaceState(null, '', u);
    } catch (e) {
      const msg = String((e as Error).message);
      setError(msg);
      if (/auth|credential|username|terminal prompts|403|401|not found|could not read/i.test(msg) && /^(https?|ssh|git):|@/.test(p)) {
        try { setPat({ host: new URL(p.replace(/^git@([^:]+):/, 'https://$1/')).hostname, token: '' }); } catch { /* ignore */ }
      }
    } finally { setLoading(false); loadingRef.current = false; setStages({}); }
  };
  const toggleWatch = async () => {
    if (!snap) return;
    const on = !watching;
    const r = await fetch('/api/watch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ root: snap.source.path, on }) });
    const b = await r.json();
    if (!r.ok) { setError(b.error); return; }
    setWatching(b.watching);
  };
  const savePat = async () => {
    if (!pat?.token) return;
    const r = await fetch('/api/auth/pat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pat) });
    const b = await r.json();
    if (!r.ok) { setError(b.error); return; }
    setPat(null); run(path);
  };
  // Large repos ship without sub-file structure: fetch a file's detail when it's selected.
  useEffect(() => {
    if (!snap?.stats.lite || !selNode || selNode.kind !== 'file' || selNode.children) return;
    fetch(`/api/detail?root=${encodeURIComponent(snap.source.path)}&path=${encodeURIComponent(selNode.path)}`).then((r) => (r.ok ? r.json() : null)).then((f: TreeNode | null) => {
      if (!f?.children) return;
      const patch = (n: TreeNode): TreeNode => (n.kind === 'file' ? (n.path === f.path ? f : n) : f.path.startsWith(n.path) ? { ...n, children: n.children?.map(patch) } : n);
      setSnap((s) => (s ? { ...s, root: patch(s.root) } : s));
    }).catch(() => {});
  }, [selNode, snap]);

  // Progress channel: stage progress, progressive/watch snapshots, background blame ages.
  const root = snap?.source.path;
  useEffect(() => {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/progress`);
    let buf: Record<string, number> = {}, timer = 0;
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data) as ProgressMessage;
      if ('type' in m && m.type === 'snapshot') {
        if (m.root !== target.current) return;
        const loading = loadingRef.current;
        setSnap((s) => mergeWsSnapshot(s, m.snapshot, !!m.partial, loading));
        return;
      }
      if (!('type' in m) || m.type !== 'layer') {
        if (m.root !== target.current || m.stage === 'done') return;
        setStages((st) => ({ ...st, [m.stage]: m.total ? m.done / m.total : 1 }));
        setStageMsg(m.message);
        return;
      }
      if (m.root !== root) return;
      Object.assign(buf, m.values);
      setAgeProgress(m.total ? m.done / m.total : 1);
      if (!timer) timer = window.setTimeout(() => { const b = buf; buf = {}; timer = 0; setAges((a) => ({ ...a, ...b })); }, 500);
    };
    // catch up on anything delivered before the socket opened
    if (root) fetch(`/api/layers/age?path=${encodeURIComponent(root)}`).then((r) => r.json()).then((v) => setAges((a) => ({ ...v, ...a }))).catch(() => {});
    return () => { ws.close(); clearTimeout(timer); };
  }, [root]);

  useEffect(() => {
    const q = new URLSearchParams(location.search).get('path');
    fetch('/api/config').then((r) => r.json()).then((c) => { setKeytar(!!c.keytar); if (c.defaultPath && !q) { setPath(c.defaultPath); run(c.defaultPath); } }).catch(() => {});
    if (q) { setPath(q); run(q); }
  }, []);

  return (
    <div className="relative h-full w-full font-sans" data-changed-tiles={changeAgg ? changeAgg.size : 0} data-fill={layer}>
      {snap && painter && <Treemap snapshot={snap} onFocusChange={setCrumbs} focusRequest={focusReq} painter={painter} onHover={setHover} pins={pins} hits={hits} edges={edges} edgeMode={coup.mode} selectedId={selected} onSelect={select} exploded={exploded} changes={changeAgg} />}
      {snap && <div className="pointer-events-none absolute bottom-8 left-3 top-32 flex flex-col items-start justify-start">
      <ChangesPanel snap={snap} active={changes} onChange={setChanges} onFly={selectAndFly} />
      </div>}
      {snap && <div className="pointer-events-none absolute bottom-3 right-3 top-36 flex flex-col items-end justify-end gap-2">
      <LayerDock layer={layer} setLayer={setLayer} window={win} setWindow={setWin} gitAvailable={!!snap.git?.available} loading={{ ...stageLoading(stages), ...(ageProgress != null && ageProgress < 1 ? { age: ageProgress } : {}) }}
        cx={cx} setCx={setCx} coverageAvailable={!!snap.coverage?.available} pins={pins} setPins={setPins} hitTotals={hitTotals}
        coupling={coup} setCoupling={setCoup} couplingAvailable={!!snap.coupling} />
      </div>}
      {hover && painter && (
        <div className="glass pointer-events-none fixed z-10 max-w-sm rounded-lg px-3 py-2 font-mono text-xs" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="truncate text-cyan-200">{hover.node.path || '/'}{hover.node.kind !== 'file' && hover.node.kind !== 'folder' ? ` › ${hover.node.name}` : ''}</div>
          <div className="mt-0.5 text-slate-400">{hover.node.kind} · {hover.node.sloc.toLocaleString()} SLOC</div>
          {changeAgg && (() => { const v = changeAgg.get(hover.node.id); return <div className={`mt-0.5 ${v ? 'text-white' : 'text-slate-500'}`}>selected commits: {v ? `${v.s === 'A' ? 'added ' : ''}+${v.a} −${v.d}` : 'unchanged'}</div>; })()}
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
      {snap && ix && rows && selNode && <Inspector snap={snap} node={selNode} ix={ix} rows={rows} onSelect={selectAndFly} onPeek={setPeek} onClose={() => select(null)} editor={editor} setEditor={setEditor} changes={changeInfo(selNode)} />}
      {snap && peek && <CodePeek snap={snap} req={peek} editor={editor} onClose={() => setPeek(null)} />}
      {snap && ix && palette && <Palette all={ix.all} onClose={() => setPalette(false)} onPick={(n) => { setPalette(false); selectAndFly(n.id); }} />}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-2 p-3">
        <form className="glass pointer-events-auto flex items-center gap-3 rounded-xl px-3 py-2" onSubmit={(e) => { e.preventDefault(); run(path); }}>
          <span className="font-mono text-sm font-semibold tracking-widest text-cyan-300">GRIM<span className="text-slate-500">·</span>REPO</span>
          <input className="flex-1 rounded-md border border-cyan-400/20 bg-slate-950/60 px-3 py-1.5 font-mono text-sm text-slate-200 outline-none focus:border-cyan-400/60 focus:shadow-[0_0_12px_rgba(34,211,238,0.25)]"
            placeholder="/path/to/local/repo or git URL (https, ssh, …/tree/branch)" value={path} onChange={(e) => setPath(e.target.value)} />
          <button className="rounded-md border border-cyan-400/40 bg-cyan-400/10 px-4 py-1.5 text-sm font-medium text-cyan-200 hover:bg-cyan-400/20 disabled:opacity-50" disabled={loading}>
            {loading ? 'Scanning…' : 'Scan'}
          </button>
          {snap && snap.source.type === 'remote' && branches.length > 0 && (
            <select aria-label="branch" className="rounded-md border border-cyan-400/20 bg-slate-950/60 px-2 py-1.5 font-mono text-xs text-slate-200" value={snap.source.ref ?? ''} disabled={loading}
              onChange={(e) => run(target.current, { ref: e.target.value })}>
              {branches.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          )}
          {snap && (
            <button type="button" title={snap.source.type === 'remote' ? 'git fetch + reset, then incremental rescan' : 'Incremental rescan'} disabled={loading}
              className="rounded-md border border-slate-600 px-3 py-1.5 text-xs text-slate-300 hover:border-cyan-400/50 hover:text-cyan-200 disabled:opacity-50"
              onClick={() => run(target.current || path, { fetch: snap.source.type === 'remote', ref: snap.source.ref, rescan: true })}>↻ Rescan</button>
          )}
          {snap && snap.source.type !== 'remote' && (
            <button type="button" aria-pressed={watching} data-testid="watch-toggle" onClick={toggleWatch} title="Watch mode: rescan on file changes"
              className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs ${watching ? 'border-emerald-400/50 bg-emerald-400/10 text-emerald-200' : 'border-slate-600 text-slate-400 hover:text-slate-200'}`}>
              <span className={`h-2 w-2 rounded-full ${watching ? 'animate-pulse bg-emerald-300' : 'bg-slate-600'}`} />Watch
            </button>
          )}
          {snap && <span className="font-mono text-xs text-slate-400">{snap.stats.files.toLocaleString()} files · {snap.stats.sloc.toLocaleString()} SLOC · {snap.stats.durationMs}ms</span>}
        </form>
        {loading && <StatusBar stages={stages} message={stageMsg} />}
        {error && <div className="glass pointer-events-auto whitespace-pre-wrap rounded-lg px-3 py-2 text-sm text-rose-300">{error}</div>}
        {pat && (
          <form className="glass pointer-events-auto flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs text-slate-300" onSubmit={(e) => { e.preventDefault(); savePat(); }}>
            {keytar ? (
              <>
                <span>Access token for <b className="text-cyan-200">{pat.host}</b> (stored in OS keychain):</span>
                <input type="password" autoComplete="off" className="w-72 rounded border border-slate-600 bg-slate-950/60 px-2 py-1 font-mono" value={pat.token} onChange={(e) => setPat({ ...pat, token: e.target.value })} />
                <button className="rounded border border-cyan-400/40 px-2 py-1 text-cyan-200">Save &amp; retry</button>
              </>
            ) : <span>Personal access tokens need the OS keychain (keytar), which isn't available here. Use <code className="text-cyan-200">gh auth login</code>, SSH, or a git credential helper.</span>}
            <button type="button" className="ml-auto text-slate-500 hover:text-slate-300" onClick={() => setPat(null)}>✕</button>
          </form>
        )}
        {crumbs.length > 0 && (
          <div className="flex items-center gap-2">
          <nav data-focus={crumbs[crumbs.length - 1]?.id} className="glass pointer-events-auto flex w-fit items-center gap-1 rounded-lg px-3 py-1.5 font-mono text-xs">
            {crumbs.map((c, i) => (
              <span key={c.id + i} className="flex items-center gap-1">
                {i > 0 && <span className="text-slate-600">/</span>}
                <button className={i === crumbs.length - 1 ? 'text-cyan-200' : 'text-slate-400 hover:text-cyan-300'} onClick={() => setFocusReq({ id: c.id, n: Date.now() })}>{c.name}</button>
              </span>
            ))}
          </nav>
          <button type="button" data-explode-toggle title="Exploded view: off / medium / large (Tab cycles, Shift+Tab back)" onClick={() => setExploded((x) => (x + 1) % 3)}
            className={`glass pointer-events-auto rounded-lg px-2.5 py-1.5 font-mono text-xs ${exploded ? 'text-cyan-200 ring-1 ring-cyan-400/40' : 'text-slate-400 hover:text-cyan-300'}`}>
            {exploded ? `Exploded ${exploded === 1 ? 'medium' : 'large'} · Tab` : '⊞ Explode · Tab'}
          </button>
          </div>
        )}
      </div>
      {!snap && !loading && (
        <div className="flex h-full items-center justify-center text-slate-500"><p className="font-mono text-sm">Enter a local path or git URL to scan.</p></div>
      )}
      <div className="pointer-events-none absolute bottom-3 left-3 font-mono text-[10px] text-slate-600">scroll to zoom · drag to pan · click to inspect · double-click to dive · right-click / Esc to go up · ⌘K search</div>
    </div>
  );
}
