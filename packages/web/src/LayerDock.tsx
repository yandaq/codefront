import { CHURN_WINDOWS, type ChurnWindow } from '@grim-repo/schema';
import { LAYERS, legendGradient, type LayerId } from './layers';

interface Props {
  layer: LayerId; setLayer: (l: LayerId) => void;
  window: ChurnWindow; setWindow: (w: ChurnWindow) => void;
  gitAvailable: boolean;
  /** 0..1 progress for layers still loading (e.g. age while blame runs). */
  loading: Partial<Record<LayerId, number>>;
}

function Ring({ p }: { p: number }) {
  const r = 7, c = 2 * Math.PI * r;
  return (
    <svg width="18" height="18" className="-rotate-90" aria-label={`loading ${Math.round(p * 100)}%`}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="rgba(148,163,184,0.2)" strokeWidth="2" />
      <circle cx="9" cy="9" r={r} fill="none" stroke="#22d3ee" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - p)} style={{ transition: 'stroke-dashoffset 300ms' }} />
    </svg>
  );
}

const LEGEND: Record<Exclude<LayerId, 'type'>, [string, string, string]> = {
  age: ['today', 'log scale', '2y+'],
  churn: ['low', 'percentile', 'high'],
  hotspots: ['cool', 'churn × complexity*', 'hot'],
};

export function LayerDock({ layer, setLayer, window, setWindow, gitAvailable, loading }: Props) {
  return (
    <div className="glass pointer-events-auto absolute bottom-3 right-3 w-64 rounded-xl p-3 font-mono text-xs">
      <div className="mb-2 text-[10px] uppercase tracking-[0.2em] text-cyan-300/80">Layers</div>
      <div className="flex flex-col gap-1">
        {LAYERS.map((l) => {
          const active = l.id === layer;
          const p = loading[l.id];
          return (
            <button key={l.id} onClick={() => setLayer(l.id)}
              className={`flex items-center justify-between rounded-md border px-2 py-1.5 text-left transition-colors ${active ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-100 shadow-[0_0_12px_rgba(34,211,238,0.2)]' : 'border-transparent text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'}`}>
              <span className="flex items-center gap-2">
                <span className={`h-2.5 w-2.5 rounded-full border ${active ? 'border-cyan-300 bg-cyan-300' : 'border-slate-500'}`} />
                {l.id === 'type' ? 'None / Type' : l.label}
              </span>
              {p != null && p < 1 ? <Ring p={p} /> : l.id !== 'type' && !gitAvailable ? <span className="text-[10px] text-slate-500">no git</span> : null}
            </button>
          );
        })}
      </div>
      {(layer === 'churn' || layer === 'hotspots') && (
        <div className="mt-2 flex gap-1">
          {(Object.keys(CHURN_WINDOWS) as ChurnWindow[]).map((w) => (
            <button key={w} onClick={() => setWindow(w)}
              className={`flex-1 rounded border px-1 py-0.5 ${w === window ? 'border-cyan-400/50 bg-cyan-400/10 text-cyan-100' : 'border-slate-700 text-slate-400 hover:text-slate-200'}`}>{w}</button>
          ))}
        </div>
      )}
      {layer !== 'type' && (
        <div key={layer} className="legend-in mt-3">
          {gitAvailable ? (
            <>
              <div className="h-2.5 rounded-sm" style={{ background: legendGradient(layer) }} />
              <div className="mt-1 flex justify-between text-[10px] text-slate-400">{LEGEND[layer].map((t) => <span key={t}>{t}</span>)}</div>
              {layer === 'hotspots' && <div className="mt-1 text-[10px] text-slate-500">top 5% glow · *complexity = SLOC until M3</div>}
              {layer === 'age' && loading.age != null && loading.age < 1 && <div className="mt-1 text-[10px] text-slate-500">file-level · per-function blame {Math.round(loading.age * 100)}%</div>}
            </>
          ) : <div className="text-[11px] text-slate-500">No git data for this directory.</div>}
        </div>
      )}
    </div>
  );
}
