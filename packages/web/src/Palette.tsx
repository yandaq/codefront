import { useEffect, useMemo, useRef, useState } from 'react';
import type { TreeNode } from '@codefront/schema';
import { fuzzySearch } from './fuzzy';

interface Item { node: TreeNode; label: string }

export function Palette({ all, onPick, onClose }: { all: TreeNode[]; onPick: (n: TreeNode) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const items = useMemo<Item[]>(() => all.filter((n) => n.kind === 'file' || n.kind === 'class' || n.kind === 'function')
    .map((n) => ({ node: n, label: n.kind === 'file' ? n.path : `${n.path} › ${n.name}` })), [all]);
  const res = useMemo(() => (q ? fuzzySearch(q, items, (i) => i.label, 50) : items.filter((i) => i.node.kind === 'file').slice(0, 50).map((item) => ({ item, score: 0, idx: [] as number[] }))), [q, items]);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => setSel(0), [q]);
  const pick = (i: number) => { const r = res[i]; if (r) onPick(r.item.node); };
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/30 pt-[12vh]" onMouseDown={onClose}>
      <div data-testid="palette" className="glass palette-in w-[640px] max-w-[92vw] overflow-hidden rounded-xl font-mono text-sm" onMouseDown={(e) => e.stopPropagation()}>
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search files, classes, functions…"
          className="w-full border-b border-cyan-400/15 bg-transparent px-4 py-3 text-slate-100 outline-none placeholder:text-slate-500"
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(res.length - 1, s + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
            else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
            else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
          }} />
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {res.map((r, i) => {
            const hit = new Set(r.idx);
            return (
              <li key={r.item.node.id} ref={i === sel ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                className={`flex cursor-pointer items-center gap-3 px-4 py-1.5 ${i === sel ? 'bg-cyan-400/15' : 'hover:bg-cyan-400/5'}`}
                onMouseEnter={() => setSel(i)} onClick={() => pick(i)}>
                <span className={`w-14 shrink-0 text-[10px] uppercase tracking-wider ${r.item.node.kind === 'function' ? 'text-cyan-300' : r.item.node.kind === 'class' ? 'text-violet-300' : 'text-slate-400'}`}>{r.item.node.kind === 'function' ? 'fn' : r.item.node.kind}</span>
                <span className="truncate text-slate-300">{[...r.item.label].map((ch, k) => hit.has(k) ? <b key={k} className="font-semibold text-cyan-200">{ch}</b> : ch)}</span>
              </li>
            );
          })}
          {!res.length && <li className="px-4 py-3 text-slate-500">No matches</li>}
        </ul>
      </div>
    </div>
  );
}
