import { createPortal } from 'react-dom';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Help text for every layer-dock control. Edit here. */
export const TIPS = {
  type: 'Plain view: tiles are coloured by file type / language, with functions and classes in their own palette. No metrics applied.',
  age: 'How long since code was last touched, from git blame (per line, rolled up to functions and files). Cyan-green is recent, violet is old, on a log scale up to 2+ years.',
  churn: 'How often a file changes: commits touching it in the selected window, from git log. Ranked by percentile; dark is stable, bright magma yellow is the most-changed.',
  hotspots: 'Churn × complexity: files that change often AND are complex, the likeliest places for bugs. Dark is cool, bright inferno yellow is hot; the top 5% glow.',
  complexity: 'Cognitive complexity of each function (branches, loops and nesting), parsed from the source; no git needed. Files show the max or SLOC-weighted mean of their functions. Green is simple, amber moderate, red complex.',
  coverage: 'Lines covered by tests, read from existing coverage reports (lcov, Istanbul, Cobertura, JaCoCo, Go cover); tests are never run. Red is 0%, green is 100%; hatched tiles have no data.',
  llm: 'Pins files containing LLM prompts or model API calls, detected by pattern matching the source. Shown as cyan dots; the number is the total hits.',
  sql: 'Pins files containing SQL or query-builder code, detected by pattern matching the source. Shown as amber dots; the number is the total hits.',
  coupling: 'Draws bundled edges between related files on top of the treemap; the strongest show faintly. Hover or select a tile to light up its edges, with particles flowing from source to target.',
  window: 'Time window for churn: only commits within this period are counted. Shorter windows show what is changing right now.',
  cxMax: 'File colour = its single most complex function. Good for spotting one monster function.',
  cxMean: 'File colour = average function complexity weighted by lines of code. Good for files that are complex throughout.',
  cxPct: 'Colour by rank within this repo, so the most complex files are always brightest.',
  cxAbs: 'Colour by fixed thresholds: ≤5 simple, 6–15 moderate, >15 complex, comparable across repos.',
  imports: 'Edges from static import/require statements between files in the repo.',
  cochange: 'Edges between files that are committed together, from git history. Hidden code dependencies show up here even with no import.',
  minConf: 'Minimum confidence: how often a change to one file also changed the other, as a percentage. Raise it to show only strong pairs.',
  minCommits: 'Minimum number of shared commits before a pair is drawn; filters out one-off coincidences.',
} as const;
export type TipId = keyof typeof TIPS;

/** Glass tooltip (portalled to body: the dock's backdrop-filter would otherwise trap position:fixed): opens after 300ms hover or on focus, to the left of / above its anchor, Esc dismisses. */
export function Tip({ id, children, className, block }: { id: TipId; children: ReactNode; className?: string; block?: boolean }) {
  const tipId = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number>();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const show = (delay: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => setOpen(true), delay); };
  const hide = () => { window.clearTimeout(timer.current); setOpen(false); setPos(null); };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open || !ref.current || !tipRef.current) return;
    const a = ref.current.getBoundingClientRect(), t = tipRef.current.getBoundingClientRect(), m = 8;
    let left = a.left - t.width - m, top = a.top + a.height / 2 - t.height / 2;
    if (left < m) { left = Math.min(Math.max(m, a.left), innerWidth - t.width - m); top = a.top - t.height - m; }
    top = Math.min(Math.max(m, top), innerHeight - t.height - m);
    setPos({ left, top });
  }, [open]);
  const Tag = block ? 'div' : 'span';
  return (
    <Tag ref={ref as never} className={className} aria-describedby={open ? tipId : undefined}
      onMouseEnter={() => show(300)} onMouseLeave={hide} onFocus={() => show(0)} onBlur={hide}
      onKeyDown={(e) => { if (open && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); hide(); } }}>
      {children}
      {open && createPortal(
        <div ref={tipRef} id={tipId} role="tooltip"
          className="glass pointer-events-none fixed z-50 w-60 rounded-lg px-3 py-2 font-mono text-[11px] normal-case leading-snug tracking-normal text-slate-200"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, background: 'rgba(15,23,42,0.92)' }}>{TIPS[id]}</div>, document.body,
      )}
    </Tag>
  );
}
