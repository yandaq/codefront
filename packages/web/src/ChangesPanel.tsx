import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '@grim-repo/schema';
import type { NodeChange } from './layers';
import { Tip } from './Tip';

export interface CommitInfo { sha: string; parents: string[]; subject: string; author: string; date: number; added: number; deleted: number }
export interface DiffFile { path: string; oldPath?: string; status: 'A' | 'M' | 'D' | 'R'; added: number; deleted: number; mapPath: string | null; fns: { id: string; name: string; a: number; d: number; s: 'A' | 'M' }[] }
export interface DiffResult { from: string; to: string; commits: number; files: DiffFile[]; nodes: Record<string, NodeChange>; touched: Record<string, string[]> }
export interface ChangeSel { diff: DiffResult; label: string; subjects: Map<string, CommitInfo> }

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const PAGE = 100, ROW = 38;
const short = (s: string) => s.slice(0, 7);
export const relDate = (secs: number) => {
  const d = (Date.now() / 1000 - secs) / 86400;
  return d < 1 / 24 ? `${Math.max(1, Math.round(d * 1440))}m ago` : d < 1 ? `${Math.round(d * 24)}h ago` : d < 60 ? `${Math.round(d)}d ago` : d < 730 ? `${Math.round(d / 30.4)}mo ago` : `${(d / 365).toFixed(1)}y ago`;
};
const Counts = ({ a, d }: { a: number; d: number }) => <span className="shrink-0 tabular-nums"><span className="text-emerald-300">+{a}</span> <span className="text-rose-300">−{d}</span></span>;
const STATUS: Record<DiffFile['status'], string> = { A: 'text-emerald-300', M: 'text-amber-300', D: 'text-rose-300', R: 'text-sky-300' };

interface Props { snap: Snapshot; onChange: (c: ChangeSel | null) => void; onFly: (id: string) => void; active: ChangeSel | null; showLocal: boolean; setShowLocal: (v: boolean) => void }

/** Mission-control "Changes" panel: branch → commit list → selection (one commit, or a shift-click range) → changed files/functions. */
export function ChangesPanel({ snap, onChange, onFly, active, showLocal, setShowLocal }: Props) {
  const unc = snap.uncommitted && snap.uncommitted.files.length ? snap.uncommitted : null;
  const [local, setLocal] = useState(false);
  useEffect(() => { if (!unc) setLocal(false); }, [unc]);
  const root = snap.source.path;
  const [open, setOpen] = useState(() => { try { return localStorage.getItem('grim.changes.open') !== '0'; } catch { return true; } });
  useEffect(() => { try { localStorage.setItem('grim.changes.open', open ? '1' : '0'); } catch { /* blocked */ } }, [open]);
  const [git, setGit] = useState<boolean | null>(null);
  const [branches, setBranches] = useState<string[]>([]);
  const [branch, setBranch] = useState<string>('');
  const [commits, setCommits] = useState<CommitInfo[]>([]);
  const [done, setDone] = useState(false);
  const loadingMore = useRef(false);
  const [sel, setSel] = useState<{ a: number; b?: number } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [listH, setListH] = useState(200);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const [remotes, setRemotes] = useState<string[]>([]);
  const [fetching, setFetching] = useState<{ msg: string; pct: number } | null>(null);
  const [fetchMsg, setFetchMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const loadBranches = useCallback((keep?: string) => fetch(`/api/git/branches?root=${encodeURIComponent(root)}`).then((r) => r.json()).then((b) => {
    const list: string[] = b.branches ?? [];
    setGit(!!b.git); setBranches(list); setRemotes(b.remotes ?? []);
    const next: string = keep && list.includes(keep) ? keep : b.current ?? list[0] ?? 'HEAD';
    setBranch(next); return next;
  }), [root]);
  useEffect(() => {
    if (!snap.git?.available) { setGit(false); return; }
    loadBranches().catch(() => setGit(false));
  }, [root, snap.git?.available, loadBranches]);

  const canFetch = snap.source.type !== 'remote' && remotes.length > 0;
  const doFetch = async () => {
    if (fetching) return;
    setFetching({ msg: 'connecting', pct: 0 }); setFetchMsg(null);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/progress`);
    ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.stage === 'fetch' && m.root === root) setFetching({ msg: m.message ?? '', pct: m.done / (m.total || 100) }); } catch { /* ignore */ } };
    try {
      const r = await fetch(`/api/git/fetch?root=${encodeURIComponent(root)}`, { method: 'POST' });
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      const by = (xs: string[], n: string) => xs.filter((x) => x.startsWith(n + '/')).length;
      const parts = (b.remotes as { name: string; ok: boolean; error?: string; authHint?: string }[]).map((x) => x.ok
        ? `${x.name}: ${by(b.updated, x.name)} updated, ${by(b.added, x.name)} new, ${by(b.pruned, x.name)} pruned`
        : `${x.name}: ${x.error}${x.authHint ? ` (for https, run \`gh auth login\` or rescan ${x.authHint} as a URL to save an access token)` : ''}`);
      setFetchMsg({ ok: b.remotes.every((x: { ok: boolean }) => x.ok), text: parts.join(' · ') || 'no remotes' });
      const keepSel = sel && commits[sel.a] ? commits[sel.a]!.sha : null;
      const cur = branch;
      if ((await loadBranches(cur)) === cur) await loadMoreReset(keepSel);
    } catch (e) { setFetchMsg({ ok: false, text: String((e as Error).message) }); }
    finally { ws.close(); setFetching(null); }
  };

  const loadMore = useCallback(async (reset = false) => {
    if (!branch || loadingMore.current || (!reset && done)) return;
    loadingMore.current = true;
    try {
      const offset = reset ? 0 : commits.length;
      const r = await fetch(`/api/commits?${new URLSearchParams({ root, branch, offset: String(offset), limit: String(PAGE) })}`);
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      setCommits((c) => (reset ? b.commits : [...c, ...b.commits]));
      setDone(b.commits.length < PAGE);
    } catch (e) { setErr(String((e as Error).message)); } finally { loadingMore.current = false; }
  }, [root, branch, commits.length, done]);
  useEffect(() => { setSel(null); setCommits([]); setDone(false); if (branch) loadMore(true); }, [branch, root]);
  // After a fetch: reload the first page, keeping the selected commit if it is still listed.
  const loadMoreReset = async (keepSha: string | null) => {
    const r = await fetch(`/api/commits?${new URLSearchParams({ root, branch, offset: '0', limit: String(PAGE) })}`);
    const b = await r.json(); if (!r.ok) return;
    setCommits(b.commits); setDone(b.commits.length < PAGE);
    const i = keepSha ? (b.commits as CommitInfo[]).findIndex((c) => c.sha === keepSha) : -1;
    setSel((s) => (i >= 0 && s && s.b == null ? { a: i } : i >= 0 ? s : null));
  }; // eslint-disable-line react-hooks/exhaustive-deps

  // Fetch the diff for the selection (refetched when the snapshot changes: the server cache is per snapshot).
  useEffect(() => {
    if (!sel || !commits[sel.a]) { onChange(null); return; }
    const lo = Math.max(sel.a, sel.b ?? sel.a), hi = Math.min(sel.a, sel.b ?? sel.a); // list is newest-first
    const older = commits[lo]!, newer = commits[hi]!;
    const from = older.parents[0] ?? EMPTY_TREE;
    const label = lo === hi ? `${short(newer.sha)} vs parent` : `${short(older.sha)}^..${short(newer.sha)}, __N__ commits`;
    let on = true;
    setBusy(true); setErr(null);
    fetch(`/api/diff?${new URLSearchParams({ root, from, to: newer.sha })}`).then(async (r) => {
      const b = await r.json();
      if (!r.ok) throw new Error(b.error);
      if (on) onChange({ diff: b, label: label.replace("__N__", String(b.commits)), subjects: new Map(commits.map((c) => [c.sha, c])) });
    }).catch((e) => on && setErr(String(e.message))).finally(() => on && setBusy(false));
    return () => { on = false; };
  }, [sel, snap]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { const el = listRef.current; if (!el) return; const ro = new ResizeObserver(() => setListH(el.clientHeight)); ro.observe(el); return () => ro.disconnect(); }, [open, git]);
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 4), last = Math.min(commits.length, Math.ceil((scrollTop + listH) / ROW) + 4);
  useEffect(() => { if (last >= commits.length - 10 && commits.length && !done) loadMore(); }, [last, commits.length, done, loadMore]);

  const clear = () => { setSel(null); setLocal(false); setExpanded(new Set()); };
  const inRange = (i: number) => sel != null && i >= Math.min(sel.a, sel.b ?? sel.a) && i <= Math.max(sel.a, sel.b ?? sel.a);
  const shown = local && unc ? unc.files : active?.diff.files;
  const files = shown ?? [];
  const onMap = useMemo(() => files.filter((f) => f.mapPath).sort((x, y) => y.added + y.deleted - x.added - x.deleted), [files]);
  const offMap = useMemo(() => files.filter((f) => !f.mapPath), [files]);
  const toggle = (p: string) => setExpanded((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n; });

  return (
    <div data-changes-panel tabIndex={-1} onKeyDown={(e) => { if (e.key === 'Escape' && sel) { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); clear(); } }}
      className="glass pointer-events-auto flex min-h-0 w-80 shrink flex-col rounded-xl p-3 font-mono text-xs outline-none">
      <div className="flex items-center gap-2">
        <Tip id="changes" className="shrink-0"><button className="whitespace-nowrap text-[10px] uppercase tracking-[0.2em] text-cyan-300/80 hover:text-cyan-200" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{open ? '▾' : '▸'} Changes</button></Tip>
        {active && <span className="min-w-0 flex-1 truncate text-[10px] text-amber-200/90" title={active.label} data-changes-label>{active.label}</span>}
        {(sel || local) && <Tip id="changesClear" className="ml-auto shrink-0"><button data-changes-clear onClick={clear} className="rounded border border-slate-600 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-cyan-400/50 hover:text-cyan-200">Clear</button></Tip>}
      </div>
      {open && git === false && <div className="mt-2 text-slate-500">No git history</div>}
      {open && git && (
        <>
          <div className="mt-2 flex items-center gap-2">
            <Tip id="changesBranch" block className="min-w-0 flex-1">
              <select aria-label="changes branch" value={branch} onChange={(e) => setBranch(e.target.value)} className="w-full rounded border border-cyan-400/20 bg-slate-950/60 px-2 py-1 text-slate-200">
                {branches.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </Tip>
            {canFetch && <Tip id="changesFetch" className="shrink-0"><button data-git-fetch onClick={doFetch} disabled={!!fetching}
              className="flex items-center gap-1 whitespace-nowrap rounded border border-cyan-400/30 px-2 py-1 text-[11px] text-cyan-200 hover:border-cyan-300/60 disabled:opacity-60">
              <span className={fetching ? 'inline-block animate-spin' : ''}>⟳</span> Fetch</button></Tip>}
          </div>
          {fetching && <div data-fetch-progress className="mt-1 truncate text-[10px] text-cyan-200/80">{fetching.msg} {Math.round(fetching.pct * 100)}%</div>}
          {fetchMsg && <div data-fetch-result className={`mt-1 flex gap-1 text-[10px] ${fetchMsg.ok ? 'text-emerald-300' : 'text-rose-300'}`}><span className="min-w-0 flex-1 break-words">{fetchMsg.text}</span><button aria-label="dismiss" className="text-slate-500 hover:text-slate-300" onClick={() => setFetchMsg(null)}>×</button></div>}
          {unc && (
            <Tip id="changesUncommitted" block className="mt-2">
              <button data-uncommitted-row onClick={() => { setSel(null); setLocal((l) => !l); }}
                className={`flex w-full flex-col rounded border px-2 py-1 text-left ${local ? 'border-white/40 bg-white/10' : 'border-white/15 hover:bg-white/5'}`}>
                <div className="flex w-full items-center gap-2"><span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-white shadow-[0_0_6px_rgba(255,255,255,0.9)]" /><span className="text-slate-100">Uncommitted</span>
                  <span className="ml-auto text-[10px] text-slate-400"><Counts a={unc.added} d={unc.deleted} /> · {unc.files.length} file{unc.files.length === 1 ? '' : 's'}</span></div>
              </button>
            </Tip>
          )}
          <Tip id="changesShowLocal" block className="mt-1">
            <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-slate-400"><input type="checkbox" data-show-local checked={showLocal} onChange={(e) => setShowLocal(e.target.checked)} className="accent-white" />Show local changes</label>
          </Tip>
          <Tip id="changesCommits" block className="mt-2 flex min-h-[76px] shrink flex-col" >
            <div ref={listRef} data-commit-list onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} className="h-56 min-h-[76px] shrink overflow-y-auto rounded border border-slate-700/60 bg-slate-950/40">
              <div style={{ height: commits.length * ROW, position: 'relative' }}>
                {commits.slice(first, last).map((c, k) => {
                  const i = first + k;
                  return (
                    <button key={c.sha} data-commit={c.sha} onClick={(e) => { setLocal(false); setSel((s) => (e.shiftKey && s ? { a: s.a, b: i } : { a: i })); }}
                      style={{ position: 'absolute', top: i * ROW, height: ROW, left: 0, right: 0 }}
                      className={`flex flex-col justify-center border-b border-slate-800/60 px-2 text-left ${inRange(i) ? 'bg-amber-400/15' : 'hover:bg-cyan-400/5'}`}>
                      <div className="flex w-full items-center gap-2"><span className="text-cyan-300">{short(c.sha)}</span><span className="truncate text-slate-200">{c.subject}</span></div>
                      <div className="flex w-full items-center gap-2 text-[10px] text-slate-500"><span className="truncate">{c.author} · {relDate(c.date)}</span><span className="ml-auto"><Counts a={c.added} d={c.deleted} /></span></div>
                    </button>
                  );
                })}
              </div>
              {!commits.length && <div className="p-2 text-slate-500">{done ? 'No commits' : 'Loading…'}</div>}
            </div>
          </Tip>
          {!sel && !local && commits.length > 0 && <div className="mt-1 text-[10px] text-slate-500">click a commit · shift-click a second for a range</div>}
          {err && <div className="mt-1 text-rose-300">{err}</div>}
          {(sel || local) && (
            <div data-changed-files className="mt-2 min-h-[60px] shrink overflow-y-auto" style={{ maxHeight: 220 }}>
              {busy && !shown && <div className="text-slate-500">Diffing…</div>}
              {shown && (
                <>
                  <div className="mb-1 text-[10px] text-slate-400">{files.length} files · <Counts a={files.reduce((s, f) => s + f.added, 0)} d={files.reduce((s, f) => s + f.deleted, 0)} /></div>
                  {onMap.map((f) => (
                    <div key={f.path}>
                      <div className="flex items-center gap-1">
                        <button className="w-3 text-slate-500" onClick={() => toggle(f.path)} aria-label="expand">{f.fns.length ? (expanded.has(f.path) ? '▾' : '▸') : ''}</button>
                        <span className={`w-3 ${STATUS[f.status]}`}>{f.status}</span>
                        <button className="min-w-0 flex-1 truncate text-left text-slate-200 hover:text-cyan-200" title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} onClick={() => onFly(f.mapPath!)}>{f.mapPath}</button>
                        <Counts a={f.added} d={f.deleted} />
                      </div>
                      {expanded.has(f.path) && f.fns.map((fn) => (
                        <div key={fn.id} className="flex items-center gap-1 pl-7">
                          <span className={`w-3 ${fn.s === 'A' ? 'text-emerald-300' : 'text-amber-300'}`}>{fn.s}</span>
                          <button className="min-w-0 flex-1 truncate text-left text-slate-300 hover:text-cyan-200" onClick={() => onFly(fn.id)}>{fn.name}</button>
                          <Counts a={fn.a} d={fn.d} />
                        </div>
                      ))}
                    </div>
                  ))}
                  {offMap.length > 0 && (
                    <>
                      <Tip id="changesOffMap" block><div className="mt-2 text-[10px] uppercase tracking-[0.15em] text-slate-500">Not on map ({offMap.length})</div></Tip>
                      {offMap.map((f) => (
                        <div key={f.path} className="flex items-center gap-1 pl-4 text-slate-500">
                          <span className={`w-3 ${STATUS[f.status]}`}>{f.status}</span>
                          <span className="min-w-0 flex-1 truncate" title={f.path}>{f.oldPath && f.status === 'R' ? `${f.oldPath} → ${f.path}` : f.path}</span>
                          <Counts a={f.added} d={f.deleted} />
                        </div>
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
