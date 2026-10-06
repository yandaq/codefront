import { STAGES, type Stage } from '@grim-repo/schema';
import type { LayerId } from './layers';

const LABEL: Record<Stage, string> = { clone: 'clone', walk: 'walk', sloc: 'SLOC', git: 'git history', parse: 'parse', detect: 'detectors', coverage: 'coverage', blame: 'blame', fetch: 'fetch' };

/** Which layers wait on which scan stages (for the layer dock's progress rings). */
export function stageLoading(st: Partial<Record<Stage, number>>): Partial<Record<LayerId, number>> {
  const pending = (s: Stage) => (Object.keys(st).length ? st[s] ?? 0 : undefined);
  const out: Partial<Record<LayerId, number>> = {};
  const set = (l: LayerId, v: number | undefined) => { if (v != null && v < 1) out[l] = v; };
  set('churn', pending('git')); set('hotspots', Math.min(pending('git') ?? 1, pending('parse') ?? 1)); set('age', pending('git'));
  set('complexity', pending('parse')); set('coverage', pending('coverage'));
  return out;
}

function Ring({ p }: { p: number }) {
  const r = 6, c = 2 * Math.PI * r;
  return (
    <svg width="16" height="16" className="-rotate-90">
      <circle cx="8" cy="8" r={r} fill="none" stroke="rgba(148,163,184,0.2)" strokeWidth="2" />
      <circle cx="8" cy="8" r={r} fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - p)} style={{ transition: 'stroke-dashoffset 250ms' }} />
    </svg>
  );
}

/** Top status bar: per-stage progress rings while a scan runs. */
export function StatusBar({ stages, message }: { stages: Partial<Record<Stage, number>>; message?: string }) {
  const shown = STAGES.filter((s) => s !== 'blame' && s !== 'fetch' && (s !== 'clone' || stages.clone != null));
  return (
    <div data-testid="status-bar" className="glass pointer-events-auto flex w-fit flex-wrap items-center gap-3 rounded-lg px-3 py-1.5 font-mono text-[11px] text-slate-400">
      {shown.map((s) => {
        const p = stages[s];
        return (
          <span key={s} className={`flex items-center gap-1 ${p == null ? 'opacity-40' : p >= 1 ? 'text-cyan-200' : 'text-slate-200'}`}>
            {p != null && p < 1 ? <Ring p={p} /> : <span className={`inline-block h-2 w-2 rounded-full ${p != null ? 'bg-cyan-300' : 'bg-slate-600'}`} />}
            {LABEL[s]}
          </span>
        );
      })}
      {message && <span className="text-slate-500">{message}</span>}
    </div>
  );
}
