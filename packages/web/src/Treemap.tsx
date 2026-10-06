import { useEffect, useRef } from 'react';
import { Application, Graphics } from 'pixi.js';
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
import type { Snapshot, TreeNode } from '@grim-repo/schema';
import type { HitCounts, Painter } from './layers';
import type { PinState } from './LayerDock';
import type { Edge } from './coupling';

type RNode = HierarchyRectangularNode<TreeNode>;
interface Cam { x: number; y: number; k: number }
interface Props {
  snapshot: Snapshot;
  onFocusChange: (crumbs: { id: string; name: string }[]) => void;
  focusRequest: { id: string; n: number } | null;
  painter: Painter;
  onHover: (h: { node: TreeNode; x: number; y: number } | null) => void;
  pins: PinState;
  hits: Map<string, HitCounts>;
  edges: Edge[];
  edgeMode: 'imports' | 'cochange';
  selectedId: string | null;
  onSelect: (n: TreeNode | null) => void;
}
const FADE_MS = 400;
const DIFF_MS = 600; // rescan: layout tween
const PULSE_MS = 1500; // rescan: changed-file pulse
type Rect = [number, number, number, number];
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

const WORLD_W = 1600;
const INTRO_MS = 1400;
const DEPTH_STAGGER = 140;
const MIN_PX = 2;
const LABEL_H = 16;
const DETAIL_PX = 60; // a file must be this wide on screen before its classes/functions appear
const DETAIL_PY = 36; // ...and this tall

const LANG_COLOURS: Record<string, number> = { typescript: 0x3b82f6, tsx: 0x0ea5e9, javascript: 0xeab308, python: 0x22c55e };
const KIND_COLOURS: Record<string, number> = { class: 0x8b5cf6, function: 0x22d3ee, 'module-scope': 0x334155, 'small-group': 0x475569 };

function colourFor(n: RNode): number {
  const d = n.data;
  if (d.kind === 'folder') return mix(0x0f2a44, 0x0a0e17, Math.min(0.7, n.depth * 0.12));
  if (d.kind === 'file') return d.language ? LANG_COLOURS[d.language] ?? 0x64748b : 0x64748b;
  return KIND_COLOURS[d.kind] ?? 0x64748b;
}

function mix(a: number, b: number, t: number): number {
  const ch = (c: number, s: number) => (c >> s) & 255;
  const m = (s: number) => Math.round(ch(a, s) * (1 - t) + ch(b, s) * t) << s;
  return m(16) | m(8) | m(0);
}

const ease = (t: number) => 1 - Math.pow(1 - t, 3);

const EDGE_PX = 14; // a tile must be this big on screen to be an edge endpoint; otherwise aggregate to its folder
const IDLE_EDGES = 200;
const BUNDLE_BETA = 0.85;
const isAncOrSelf = (a: string, b: string) => a === '' || a === b || b.startsWith(a + '/') || b.startsWith(a + '#');

/** Hierarchical edge bundling: straighten control points by beta (as d3.curveBundle) then sample a clamped uniform cubic B-spline. */
function bundle(pts: [number, number][], beta: number, steps = 6): [number, number][] {
  const n = pts.length - 1, [x0, y0] = pts[0]!, [xn, yn] = pts[n]!;
  const p = pts.map(([x, y], i) => [beta * x + (1 - beta) * (x0 + ((xn - x0) * i) / n), beta * y + (1 - beta) * (y0 + ((yn - y0) * i) / n)] as [number, number]);
  const c = [p[0]!, p[0]!, ...p, p[n]!, p[n]!];
  const out: [number, number][] = [];
  for (let i = 0; i + 3 < c.length; i++) {
    const [a, b, d, e] = [c[i]!, c[i + 1]!, c[i + 2]!, c[i + 3]!];
    for (let k = i === 0 ? 0 : 1; k <= steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const w0 = (1 - t) ** 3 / 6, w1 = (3 * t3 - 6 * t2 + 4) / 6, w2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6, w3 = t3 / 6;
      out.push([w0 * a[0] + w1 * b[0] + w2 * d[0] + w3 * e[0], w0 * a[1] + w1 * b[1] + w2 * d[1] + w3 * e[1]]);
    }
  }
  return out;
}

export function Treemap({ snapshot, onFocusChange, focusRequest, painter, onHover, pins, hits, edges, edgeMode, selectedId, onSelect }: Props) {
  const selRef = useRef(selectedId); selRef.current = selectedId;
  const selectCb = useRef(onSelect); selectCb.current = onSelect;
  useEffect(() => { kick.current(); }, [selectedId]);
  const edgeRef = useRef({ edges, edgeMode, v: 0 });
  if (edgeRef.current.edges !== edges || edgeRef.current.edgeMode !== edgeMode) edgeRef.current = { edges, edgeMode, v: edgeRef.current.v + 1 };
  const pinRef = useRef({ pins, hits }); pinRef.current = { pins, hits };
  useEffect(() => { kick.current(); }, [pins, hits]);
  const paint = useRef({ cur: painter, prev: painter, t0: 0 });
  const hoverCb = useRef(onHover); hoverCb.current = onHover;
  const kick = useRef<() => void>(() => {});
  useEffect(() => {
    const p = paint.current;
    if (p.cur === painter) return;
    // a painter replaced within the same layer (e.g. blame batch) shouldn't restart the fade from scratch
    p.prev = p.cur; p.cur = painter; p.t0 = performance.now();
    kick.current();
  }, [painter]);
  const host = useRef<HTMLDivElement>(null);
  const api = useRef<{ focusId: (id: string) => void; load: (s: Snapshot) => void } | null>(null);
  const snapRef = useRef(snapshot);
  // a new snapshot of the same repo (rescan / watch / progressive render) animates in place; a new repo replays the intro
  useEffect(() => { if (snapRef.current === snapshot) return; snapRef.current = snapshot; api.current?.load(snapshot); }, [snapshot]);

  useEffect(() => {
    const el = host.current!;
    const labelsEl = document.createElement('div');
    labelsEl.style.cssText = 'position:absolute;inset:0;pointer-events:none;overflow:hidden';
    let disposed = false;
    const app = new Application();
    let cleanup = () => {};

    (async () => {
      await app.init({ resizeTo: el, background: '#0a0e17', antialias: true, autoDensity: true, resolution: window.devicePixelRatio || 1, preference: 'webgpu' });
      if (disposed) { app.destroy(true); return; }
      el.appendChild(app.canvas);
      el.appendChild(labelsEl);

      // ---- layout (world space) ----
      const worldH = WORLD_W * (el.clientHeight / Math.max(1, el.clientWidth));
      const layout = (s: Snapshot): RNode => treemap<TreeNode>()
        .tile(treemapSquarify.ratio(1.2))
        .size([WORLD_W, worldH])
        .paddingTop((d) => (d.data.kind === 'folder' ? Math.max(1.5, 18 * Math.pow(0.62, d.depth)) : Math.max(0.4, 6 * Math.pow(0.6, d.depth))))
        .paddingRight((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingBottom((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingLeft((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingInner((d) => Math.max(0.3, 2 * Math.pow(0.62, d.depth)))(
          hierarchy(s.root, (d) => d.children).sum((d) => (d.children?.length ? 0 : d.sloc)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0)));
      let laid = layout(snapRef.current);
      let byId = new Map<string, RNode>();
      const index = () => { byId = new Map(); laid.each((n) => byId.set(n.data.id, n)); };
      index();
      // subtree hit totals for pin aggregation
      const subHits = new Map<RNode, HitCounts>();
      const sumHits = () => {
        const h = pinRef.current.hits;
        laid.eachAfter((n) => {
          const own = h.get(n.data.id);
          const t = { llm: own?.llm ?? 0, sql: own?.sql ?? 0 };
          for (const c of n.children ?? []) { const ct = subHits.get(c)!; t.llm += ct.llm; t.sql += ct.sql; }
          subHits.set(n, t);
        });
      };
      sumHits();
      let hitsSeen = pinRef.current.hits;
      let maxDepth = laid.height;

      // ---- camera ----
      const fit = (n: RNode): Cam => {
        const w = n.x1 - n.x0, h = n.y1 - n.y0;
        const k = Math.min(app.screen.width / w, app.screen.height / h) * 0.94;
        return { k, x: n.x0 + w / 2 - app.screen.width / 2 / k, y: n.y0 + h / 2 - app.screen.height / 2 / k };
      };
      let cam: Cam = fit(laid);
      let anim: { from: Cam; to: Cam; t0: number; dur: number } | null = null;
      let focus: RNode = laid;
      let t0 = performance.now();
      let dirty = true;
      let diff: { t0: number; prev: Map<string, Rect>; removed: Rect[] } | null = null;
      let pulse: { t0: number; changed: Set<string> } | null = null;
      let loadedRoot = snapRef.current.source.path;

      const flyTo = (n: RNode) => {
        focus = n;
        anim = { from: { ...cam }, to: fit(n), t0: performance.now(), dur: 750 };
        onFocusChange(n.ancestors().reverse().map((a) => ({ id: a.data.id, name: a.data.name })));
      };
      onFocusChange([{ id: laid.data.id, name: laid.data.name }]);
      const load = (s: Snapshot) => {
        const old = laid;
        laid = layout(s); index(); subHits.clear(); sumHits(); maxDepth = laid.height;
        edgeBuilt.v = -1; hoverNode = null; dirty = true;
        if (s.source.path !== loadedRoot) {
          loadedRoot = s.source.path; diff = null; pulse = null;
          cam = fit(laid); anim = null; focus = laid; t0 = performance.now(); introWas = true;
          onFocusChange([{ id: laid.data.id, name: laid.data.name }]);
          return;
        }
        const prev = new Map<string, Rect>(), prevHash = new Map<string, string | undefined>();
        old.each((n) => { prev.set(n.data.id, [n.x0, n.y0, n.x1, n.y1]); if (n.data.kind === 'file') prevHash.set(n.data.id, n.data.hash); });
        const changed = new Set<string>();
        laid.each((n) => { if (n.data.kind === 'file' && prevHash.has(n.data.id) && prevHash.get(n.data.id) !== n.data.hash) changed.add(n.data.id); });
        const removed: Rect[] = [];
        old.each((n) => { if (!byId.has(n.data.id) && (n.data.kind === 'file' || n.data.kind === 'folder') && n.parent && byId.has(n.parent.data.id)) removed.push([n.x0, n.y0, n.x1, n.y1]); });
        const now = performance.now();
        diff = { t0: now, prev, removed };
        // progressive render delivers several snapshots in a row: keep an active pulse going
        if (changed.size) { if (pulse && now - pulse.t0 < PULSE_MS) pulse.changed.forEach((id) => changed.add(id)); pulse = { t0: now, changed }; }
        focus = byId.get(focus.data.id) ?? laid;
      };
      api.current = { focusId: (id) => { const n = byId.get(id); if (n) flyTo(n); }, load };

      // ---- rendering ----
      const g = new Graphics();
      app.stage.addChild(g);
      // coupling filaments + particles, drawn in world space under a camera transform; additive for the neon look
      const eg = new Graphics(), pg = new Graphics();
      eg.blendMode = 'add'; pg.blendMode = 'add';
      app.stage.addChild(eg, pg);
      let hoverNode: RNode | null = null;
      let edgeBuilt = { v: -1, k: 0, x: 0, y: 0, hover: null as RNode | null };
      const litNode = () => hoverNode ?? (selRef.current != null ? byId.get(selRef.current) ?? null : null);
      let camChangedAt = 0;
      let introWas = true;
      let flows: { pts: [number, number][]; cum: number[]; len: number; col: number }[] = [];

      const visibleTile = (n: RNode): RNode | null => {
        let pick: RNode | null = null;
        for (const a of n.ancestors().reverse()) {
          if ((a.x1 - a.x0) * cam.k < EDGE_PX || (a.y1 - a.y0) * cam.k < EDGE_PX) break;
          pick = a;
        }
        return pick;
      };
      const buildEdges = () => {
        const { edges, edgeMode, v } = edgeRef.current;
        const lit0 = litNode();
        edgeBuilt = { v, k: cam.k, x: cam.x, y: cam.y, hover: lit0 };
        eg.clear(); flows = [];
        if (!edges.length) return;
        const agg = new Map<string, { a: RNode; b: RNode; w: number }>();
        for (const e of edges) {
          const fa = byId.get(e.a), fb = byId.get(e.b);
          if (!fa || !fb) continue;
          const a = visibleTile(fa), b = visibleTile(fb);
          if (!a || !b || isAncOrSelf(a.data.id, b.data.id) || isAncOrSelf(b.data.id, a.data.id)) continue;
          const k = `${a.data.id}\0${b.data.id}`;
          const cur = agg.get(k);
          if (cur) cur.w += e.w; else agg.set(k, { a, b, w: e.w });
        }
        const all = [...agg.values()].sort((x, y) => y.w - x.w);
        const h = lit0?.data.id;
        const touches = (n: RNode) => h != null && (isAncOrSelf(h, n.data.id) || isAncOrSelf(n.data.id, h));
        const lit = h != null ? all.filter((e) => touches(e.a) || touches(e.b)).slice(0, 400) : [];
        const litSet = new Set(lit);
        const idle = all.slice(0, IDLE_EDGES).filter((e) => !litSet.has(e));
        const maxW = all[0]?.w ?? 1;
        const col = edgeMode === 'imports' ? 0x38bdf8 : 0xe879f9;
        const px = 1 / cam.k;
        const centre = (n: RNode): [number, number] => [(n.x0 + n.x1) / 2, (n.y0 + n.y1) / 2];
        const curve = (e: { a: RNode; b: RNode }) => bundle(e.a.path(e.b).map(centre), BUNDLE_BETA);
        const stroke = (pts: [number, number][], width: number, alpha: number, c: number) => {
          eg.moveTo(pts[0]![0], pts[0]![1]);
          for (let i = 1; i < pts.length; i++) eg.lineTo(pts[i]![0], pts[i]![1]);
          eg.stroke({ width: width * px, color: c, alpha, cap: 'round', join: 'round' });
        };
        const dimF = h != null ? 0.25 : 1;
        for (const e of idle) {
          const t = Math.sqrt(e.w / maxW);
          const pts = curve(e);
          stroke(pts, 3, 0.03 * dimF, col);
          stroke(pts, 1, (0.08 + 0.22 * t) * dimF, col);
        }
        for (const e of lit) {
          const t = Math.sqrt(e.w / maxW);
          const pts = curve(e);
          const c = edgeMode === 'imports' && touches(e.b) && !touches(e.a) ? 0x34d399 : col; // incoming imports in green
          stroke(pts, 7, 0.06, c);
          stroke(pts, 3.5, 0.16, c);
          stroke(pts, 1.4, 0.55 + 0.4 * t, mix(c, 0xffffff, 0.35));
          const cum = [0];
          for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
          flows.push({ pts, cum, len: cum[cum.length - 1]!, col: c });
        }
      };
      const drawParticles = (now: number) => {
        pg.clear();
        if (!flows.length) return;
        const px = 1 / cam.k;
        for (const f of flows) {
          const spacing = 60 * px, count = Math.max(1, Math.min(12, Math.floor(f.len / spacing)));
          for (let i = 0; i < count; i++) {
            const d = (((now / 1000) * 90 * px + (i * f.len) / count) % f.len + f.len) % f.len;
            let j = 1;
            while (j < f.cum.length - 1 && f.cum[j]! < d) j++;
            const s0 = f.cum[j - 1]!, s1 = f.cum[j]!, t = s1 > s0 ? (d - s0) / (s1 - s0) : 0;
            const [ax, ay] = f.pts[j - 1]!, [bx, by] = f.pts[j]!;
            const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
            pg.circle(x, y, 3.2 * px).fill({ color: f.col, alpha: 0.18 });
            pg.circle(x, y, 1.4 * px).fill({ color: 0xffffff, alpha: 0.85 });
          }
        }
      };
      const labelPool: HTMLDivElement[] = [];
      const pinPool: HTMLDivElement[] = [];

      const draw = (now: number) => {
        if (anim) {
          const t = Math.min(1, (now - anim.t0) / anim.dur), e = ease(t);
          // zoom interpolated in log space for a smooth "dive"
          const k = Math.exp(Math.log(anim.from.k) * (1 - e) + Math.log(anim.to.k) * e);
          const cx = (anim.from.x + app.screen.width / 2 / anim.from.k) * (1 - e) + (anim.to.x + app.screen.width / 2 / anim.to.k) * e;
          const cy = (anim.from.y + app.screen.height / 2 / anim.from.k) * (1 - e) + (anim.to.y + app.screen.height / 2 / anim.to.k) * e;
          cam = { k, x: cx - app.screen.width / 2 / k, y: cy - app.screen.height / 2 / k };
          if (t >= 1) anim = null;
          dirty = true;
        }
        const fadeT = Math.min(1, (now - paint.current.t0) / FADE_MS);
        const fading = fadeT < 1;
        const introT = (now - t0) / (INTRO_MS + maxDepth * DEPTH_STAGGER);
        const intro = introT < 1;
        // edges: follow the camera via transform; rebuild geometry on data/hover change or once the camera settles
        eg.visible = pg.visible = !intro;
        eg.scale.set(cam.k); eg.position.set(-cam.x * cam.k, -cam.y * cam.k);
        pg.scale.set(cam.k); pg.position.set(-cam.x * cam.k, -cam.y * cam.k);
        if (!intro) {
          const camMoved = edgeBuilt.k !== cam.k || edgeBuilt.x !== cam.x || edgeBuilt.y !== cam.y;
          if (camMoved && !camChangedAt) camChangedAt = now;
          if (edgeBuilt.v !== edgeRef.current.v || edgeBuilt.hover !== litNode() || (camMoved && !anim && now - camChangedAt > 120)) { buildEdges(); camChangedAt = 0; }
          drawParticles(now);
        }
        if (introWas && !intro) { introWas = false; dirty = true; } // final frame after the intro: draw labels/pins
        const dT = diff ? Math.min(1, (now - diff.t0) / DIFF_MS) : 1;
        const tweening = !!diff && dT < 1;
        const pulseT = pulse ? (now - pulse.t0) / PULSE_MS : 1;
        if (diff && !tweening) { diff = null; dirty = true; }
        if (pulse && pulseT >= 1) { pulse = null; dirty = true; }
        const animState = tweening ? 'diff' : pulse ? 'pulse' : '';
        if (el.dataset.anim !== animState) el.dataset.anim = animState; // test/debug hook
        if (!dirty && !intro && !fading && !diff && !pulse) return;
        const eD = ease(dT);
        /** World rect, tweened from the previous layout during a rescan (new tiles grow from their centre). */
        const wr = (n: RNode): Rect => {
          if (!tweening) return [n.x0, n.y0, n.x1, n.y1];
          const p = diff!.prev.get(n.data.id);
          if (p) return [lerp(p[0], n.x0, eD), lerp(p[1], n.y0, eD), lerp(p[2], n.x1, eD), lerp(p[3], n.y1, eD)];
          const cx = (n.x0 + n.x1) / 2, cy = (n.y0 + n.y1) / 2, hw = ((n.x1 - n.x0) / 2) * eD, hh = ((n.y1 - n.y0) / 2) * eD;
          return [cx - hw, cy - hh, cx + hw, cy + hh];
        };
        dirty = false;

        g.clear();
        const W = app.screen.width, H = app.screen.height;
        let li = 0, pi = 0;
        const cands: { x: number; y: number; maxW: number; area: number; folder: boolean; dim: boolean; text: string }[] = [];
        if (hitsSeen !== pinRef.current.hits) { hitsSeen = pinRef.current.hits; sumHits(); }
        const { pins } = pinRef.current;
        const ZERO: HitCounts = { llm: 0, sql: 0 };
        const placePin = (kind: 'llm' | 'sql', count: number, x: number, y: number) => {
          let el = pinPool[pi];
          if (!el) { el = document.createElement('div'); pinPool.push(el); labelsEl.appendChild(el); }
          pi++;
          el.className = `pin ${kind}`;
          el.textContent = String(count);
          el.style.display = 'block';
          el.style.transform = `translate(${x}px, ${y}px)`;
        };
        /** Returns hits accounted for (pinned here/below, or off-screen); unaccounted hits bubble up to the parent's pin. */
        const visit = (n: RNode): HitCounts => {
          const [rx0, ry0, rx1, ry1] = wr(n);
          let x0 = (rx0 - cam.x) * cam.k, y0 = (ry0 - cam.y) * cam.k;
          let w = (rx1 - rx0) * cam.k, h = (ry1 - ry0) * cam.k;
          if (x0 > W || y0 > H || x0 + w < 0 || y0 + h < 0) return subHits.get(n)!;
          if (w < MIN_PX || h < MIN_PX) return ZERO;
          // grow-in: each depth starts later and scales up from its centre
          let alpha = tweening && !diff!.prev.has(n.data.id) ? eD : 1;
          if (intro) {
            const p = Math.max(0, Math.min(1, (now - t0 - n.depth * DEPTH_STAGGER) / (INTRO_MS * 0.6)));
            if (p <= 0) return ZERO;
            const s = ease(p);
            x0 += (w * (1 - s)) / 2; y0 += (h * (1 - s)) / 2; w *= s; h *= s; alpha = s;
          }
          const d = n.data;
          if (d.kind !== 'file' && d.kind !== 'folder') fnTiles++;
          const def = colourFor(n);
          const { cur, prev } = paint.current;
          const cc = cur.colour(d) ?? def;
          const base = fading ? mix(prev.colour(d) ?? def, cc, ease(fadeT)) : cc;
          const glow = cur.glow(d);
          const isCode = d.kind !== 'folder';
          const dim = d.kind === 'module-scope' || d.kind === 'small-group';
          // glass body + depth "terrain" shading
          const layered = cur.colour(d) != null;
          const fillA = d.kind === 'folder' ? 0.55 : layered ? (dim ? 0.6 : 0.78) : dim ? 0.35 : 0.42;
          g.rect(x0, y0, w, h).fill({ color: mix(base, 0x0a0e17, Math.min(0.6, n.depth * 0.06)), alpha: fillA * alpha });
          if (cur.hatch?.(d) && w > 4 && h > 4 && (!n.children || d.kind === 'file')) {
            // diagonal hatch = no data: lines x + y = const clipped to the rect
            for (let s2 = 6; s2 < w + h; s2 += 6) {
              g.moveTo(x0 + Math.min(s2, w), y0 + Math.max(0, s2 - w)).lineTo(x0 + Math.max(0, s2 - h), y0 + Math.min(s2, h));
            }
            g.stroke({ width: 1, color: 0x64748b, alpha: 0.45 * alpha });
          }
          if (h > 6) g.rect(x0, y0, w, Math.min(h * 0.35, 18)).fill({ color: 0xffffff, alpha: 0.035 * alpha }); // top sheen
          if (w > 8 && h > 8) g.rect(x0 + 1, y0 + h - Math.min(h * 0.25, 10), w - 2, Math.min(h * 0.25, 10) - 1).fill({ color: 0x000000, alpha: 0.12 * alpha }); // inset shadow
          // luminous 1px border
          const borderCol = isCode ? mix(base, 0xffffff, 0.35) : 0x38bdf8;
          g.rect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1)).stroke({ width: 1, color: borderCol, alpha: (dim ? 0.18 : isCode ? 0.55 : 0.22 + 0.25 / (1 + n.depth)) * alpha });

          if (glow && w > 3 && h > 3) {
            g.rect(x0 - 1.5, y0 - 1.5, w + 3, h + 3).stroke({ width: 3, color: 0xfde68a, alpha: 0.35 * alpha * (fading ? fadeT : 1) });
            g.rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1).stroke({ width: 1.5, color: 0xfffbeb, alpha: 0.8 * alpha * (fading ? fadeT : 1) });
          }
          if (pulse && pulseT < 1 && d.kind === 'file' && pulse.changed.has(d.id)) {
            // changed on rescan: a few bright pulses that decay
            const a = Math.pow(Math.sin(pulseT * Math.PI * 3), 2) * (1 - pulseT);
            g.rect(x0, y0, w, h).fill({ color: 0xa5f3fc, alpha: 0.28 * a });
            g.rect(x0 - 1, y0 - 1, w + 2, h + 2).stroke({ width: 2, color: 0x22d3ee, alpha: 0.9 * a });
          }
          // labels
          if (!intro && w > 44 && h > 16 && cands.length < 3000) {
            const lx = Math.max(0, x0), ly = Math.max(0, y0);
            const maxW = x0 + w - lx, maxH = y0 + h - ly;
            if (maxW > 30 && maxH >= LABEL_H) cands.push({ x: lx, y: ly, maxW, area: w * h, folder: d.kind === 'folder', dim, text: d.kind === 'file' && w > 140 && h > 34 ? `${d.name}  ${d.sloc}` : d.name });
          }

          const covered = { llm: 0, sql: 0 };
          // semantic zoom: hide inner-file structure until the file is big on screen
          if (n.children && !(d.kind === 'file' && (w < DETAIL_PX || h < DETAIL_PY))) {
            for (const c of n.children) { const r = visit(c); covered.llm += r.llm; covered.sql += r.sql; }
          }
          const tot = subHits.get(n)!;
          if (!intro && w >= 8 && h >= 8) {
            let px = Math.min(W - 16, x0 + w - 16);
            const py = Math.max(0, y0 + 2);
            if (pins.llm && tot.llm > covered.llm) { placePin('llm', tot.llm - covered.llm, px, py); px -= 20; covered.llm = tot.llm; }
            if (pins.sql && tot.sql > covered.sql) { placePin('sql', tot.sql - covered.sql, px, py); covered.sql = tot.sql; }
          }
          return covered;
        };
        let fnTiles = 0;
        visit(laid);
        if (el.dataset.fnTiles !== String(fnTiles)) el.dataset.fnTiles = String(fnTiles); // test hook: inner-file tiles drawn
        if (tweening) for (const [a, b, c, d2] of diff!.removed) {
          const x0 = (a - cam.x) * cam.k, y0 = (b - cam.y) * cam.k, w = (c - a) * cam.k, h = (d2 - b) * cam.k;
          if (w < MIN_PX || h < MIN_PX) continue;
          g.rect(x0, y0, w, h).fill({ color: 0x64748b, alpha: 0.4 * (1 - eD) }).stroke({ width: 1, color: 0xf87171, alpha: 0.6 * (1 - eD) });
        }
        // persistent selection highlight
        const sn = selRef.current != null ? byId.get(selRef.current) : undefined;
        if (sn && !intro) {
          const sx = (sn.x0 - cam.x) * cam.k, sy = (sn.y0 - cam.y) * cam.k, sw = (sn.x1 - sn.x0) * cam.k, sh = (sn.y1 - sn.y0) * cam.k;
          g.rect(sx - 2, sy - 2, sw + 4, sh + 4).stroke({ width: 4, color: 0x22d3ee, alpha: 0.25 });
          g.rect(sx + 0.5, sy + 0.5, Math.max(1, sw - 1), Math.max(1, sh - 1)).stroke({ width: 1.5, color: 0xa5f3fc, alpha: 0.95 });
        }
        // labels: larger tiles first; skip any label that would collide with one already placed
        cands.sort((a, b) => b.area - a.area);
        const placed: [number, number, number, number][] = [];
        for (const c of cands) {
          if (li >= 400) break;
          const lw = Math.min(c.maxW, c.text.length * (c.folder ? 6.6 : 6.8) + 8);
          const r: [number, number, number, number] = [c.x, c.y, c.x + lw, c.y + LABEL_H];
          if (placed.some((p) => r[0] < p[2] && r[2] > p[0] && r[1] < p[3] && r[3] > p[1])) continue;
          placed.push(r);
          let lab = labelPool[li];
          if (!lab) { lab = document.createElement('div'); labelPool.push(lab); labelsEl.appendChild(lab); }
          li++;
          lab.className = 'tile-label' + (c.folder ? ' folder' : '');
          lab.textContent = c.text;
          lab.style.display = 'block';
          lab.style.transform = `translate(${c.x}px, ${c.y}px)`;
          lab.style.maxWidth = `${c.maxW}px`;
          lab.style.opacity = c.dim ? '0.55' : '1';
        }
        for (let i = li; i < labelPool.length; i++) labelPool[i]!.style.display = 'none';
        for (let i = pi; i < pinPool.length; i++) pinPool[i]!.style.display = 'none';
      };
      app.ticker.add(() => draw(performance.now()));
      kick.current = () => { dirty = true; };

      // ---- interaction ----
      const toWorld = (sx: number, sy: number) => ({ x: sx / cam.k + cam.x, y: sy / cam.k + cam.y });
      const hit = (wx: number, wy: number): RNode[] => {
        const path: RNode[] = [];
        let n: RNode | undefined = laid;
        while (n) {
          path.push(n);
          n = n.children?.find((c) => wx >= c.x0 && wx <= c.x1 && wy >= c.y0 && wy <= c.y1);
        }
        return path;
      };
      // deepest node that is actually drawn (respect semantic zoom)
      const pickAt = (sx: number, sy: number): RNode => {
        const w = toWorld(sx, sy);
        const path = hit(w.x, w.y);
        let pick = path[0]!;
        for (const n of path) {
          const pw = (n.x1 - n.x0) * cam.k, ph = (n.y1 - n.y0) * cam.k;
          if (pw < MIN_PX || ph < MIN_PX) break;
          pick = n;
          if (n.data.kind === 'file' && (pw < DETAIL_PX || ph < DETAIL_PY)) break;
        }
        return pick;
      };
      const canvas = app.canvas;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        anim = null;
        const r = canvas.getBoundingClientRect();
        const sx = e.clientX - r.left, sy = e.clientY - r.top;
        const w = toWorld(sx, sy);
        const k = Math.max(0.2, Math.min(5000, cam.k * Math.exp(-e.deltaY * 0.0015)));
        cam = { k, x: w.x - sx / k, y: w.y - sy / k };
        dirty = true;
        // keep breadcrumb in sync with the deepest node filling most of the view
        const centre = hit(...(Object.values(toWorld(r.width / 2, r.height / 2)) as [number, number]));
        const f = [...centre].reverse().find((n) => (n.x1 - n.x0) * k >= r.width * 0.6 || (n.y1 - n.y0) * k >= r.height * 0.6) ?? laid;
        if (f !== focus) { focus = f; onFocusChange(f.ancestors().reverse().map((a) => ({ id: a.data.id, name: a.data.name }))); }
      };
      let drag: { x: number; y: number; moved: boolean } | null = null;
      const onDown = (e: PointerEvent) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, moved: false }; };
      const onMove = (e: PointerEvent) => {
        if (!drag) {
          const r = canvas.getBoundingClientRect();
          const sx = e.clientX - r.left, sy = e.clientY - r.top;
          if (sx < 0 || sy < 0 || sx > r.width || sy > r.height || e.target !== canvas) { hoverNode = null; hoverCb.current(null); return; }
          const pick = pickAt(sx, sy);
          hoverNode = pick === laid ? null : pick;
          hoverCb.current({ node: pick.data, x: e.clientX, y: e.clientY });
          return;
        }
        hoverCb.current(null);
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        if (!drag.moved && Math.hypot(dx, dy) < 4) return;
        drag.moved = true; anim = null;
        cam = { ...cam, x: cam.x - dx / cam.k, y: cam.y - dy / cam.k };
        drag.x = e.clientX; drag.y = e.clientY; dirty = true;
      };
      const onUp = (e: PointerEvent) => {
        if (!drag) return;
        const wasClick = !drag.moved;
        drag = null;
        if (!wasClick) return;
        // single click selects (inspector); double-click dives
        const r = canvas.getBoundingClientRect();
        const pick = pickAt(e.clientX - r.left, e.clientY - r.top);
        selectCb.current(pick === laid ? null : pick.data);
        dirty = true;
      };
      const onDbl = (e: MouseEvent) => {
        const r = canvas.getBoundingClientRect();
        const w = toWorld(e.clientX - r.left, e.clientY - r.top);
        const path = hit(w.x, w.y);
        const idx = path.indexOf(focus);
        const next = idx >= 0 ? path[idx + 1] : path[1];
        if (next) flyTo(next);
      };
      const up = () => { if (focus.parent) flyTo(focus.parent); };
      const onContext = (e: MouseEvent) => { e.preventDefault(); up(); };
      const onKey = (e: KeyboardEvent) => {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.defaultPrevented) return;
        if (e.key === 'Escape') { if (selRef.current != null) selectCb.current(null); else up(); }
        else if (e.key === 'Backspace') up();
      };
      const onResize = () => { dirty = true; };
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      canvas.addEventListener('contextmenu', onContext);
      canvas.addEventListener('dblclick', onDbl);
      window.addEventListener('keydown', onKey);
      window.addEventListener('resize', onResize);
      cleanup = () => {
        canvas.removeEventListener('wheel', onWheel);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('resize', onResize);
      };
    })();

    return () => {
      disposed = true;
      cleanup();
      api.current = null;
      labelsEl.remove();
      try { app.destroy(true, { children: true }); } catch { /* not initialised yet */ }
    };
  }, []);

  useEffect(() => { if (focusRequest) api.current?.focusId(focusRequest.id); }, [focusRequest]);

  return <div ref={host} className="absolute inset-0" />;
}
