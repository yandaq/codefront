import { useEffect, useRef } from 'react';
import { Application, Graphics } from 'pixi.js';
import { hierarchy, treemap, treemapSquarify, type HierarchyRectangularNode } from 'd3-hierarchy';
import type { Snapshot, TreeNode } from '@grim-repo/schema';
import type { Painter } from './layers';

type RNode = HierarchyRectangularNode<TreeNode>;
interface Cam { x: number; y: number; k: number }
interface Props {
  snapshot: Snapshot;
  onFocusChange: (crumbs: { id: string; name: string }[]) => void;
  focusRequest: { id: string; n: number } | null;
  painter: Painter;
  onHover: (h: { node: TreeNode; x: number; y: number } | null) => void;
}
const FADE_MS = 400;

const WORLD_W = 1600;
const INTRO_MS = 1400;
const DEPTH_STAGGER = 140;
const MIN_PX = 2;
const DETAIL_PX = 90; // a file must be this big on screen before its classes/functions appear

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

export function Treemap({ snapshot, onFocusChange, focusRequest, painter, onHover }: Props) {
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
  const api = useRef<{ focusId: (id: string) => void } | null>(null);

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
      const root = hierarchy(snapshot.root, (d) => d.children).sum((d) => (d.children?.length ? 0 : d.sloc)).sort((a, b) => (b.value ?? 0) - (a.value ?? 0));
      const laid = treemap<TreeNode>()
        .tile(treemapSquarify.ratio(1.2))
        .size([WORLD_W, worldH])
        .paddingTop((d) => (d.data.kind === 'folder' ? Math.max(1.5, 18 * Math.pow(0.62, d.depth)) : Math.max(0.4, 6 * Math.pow(0.6, d.depth))))
        .paddingRight((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingBottom((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingLeft((d) => Math.max(0.3, 3 * Math.pow(0.62, d.depth)))
        .paddingInner((d) => Math.max(0.3, 2 * Math.pow(0.62, d.depth)))(root);
      const byId = new Map<string, RNode>();
      laid.each((n) => byId.set(n.data.id, n));
      const maxDepth = laid.height;

      // ---- camera ----
      const fit = (n: RNode): Cam => {
        const w = n.x1 - n.x0, h = n.y1 - n.y0;
        const k = Math.min(app.screen.width / w, app.screen.height / h) * 0.94;
        return { k, x: n.x0 + w / 2 - app.screen.width / 2 / k, y: n.y0 + h / 2 - app.screen.height / 2 / k };
      };
      let cam: Cam = fit(laid);
      let anim: { from: Cam; to: Cam; t0: number; dur: number } | null = null;
      let focus: RNode = laid;
      const t0 = performance.now();
      let dirty = true;

      const flyTo = (n: RNode) => {
        focus = n;
        anim = { from: { ...cam }, to: fit(n), t0: performance.now(), dur: 750 };
        onFocusChange(n.ancestors().reverse().map((a) => ({ id: a.data.id, name: a.data.name })));
      };
      onFocusChange([{ id: laid.data.id, name: laid.data.name }]);
      api.current = { focusId: (id) => { const n = byId.get(id); if (n) flyTo(n); } };

      // ---- rendering ----
      const g = new Graphics();
      app.stage.addChild(g);
      const labelPool: HTMLDivElement[] = [];

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
        if (!dirty && !intro && !fading) return;
        dirty = false;

        g.clear();
        const W = app.screen.width, H = app.screen.height;
        let li = 0;
        const visit = (n: RNode) => {
          let x0 = (n.x0 - cam.x) * cam.k, y0 = (n.y0 - cam.y) * cam.k;
          let w = (n.x1 - n.x0) * cam.k, h = (n.y1 - n.y0) * cam.k;
          if (x0 > W || y0 > H || x0 + w < 0 || y0 + h < 0) return;
          if (w < MIN_PX || h < MIN_PX) return;
          // grow-in: each depth starts later and scales up from its centre
          let alpha = 1;
          if (intro) {
            const p = Math.max(0, Math.min(1, (now - t0 - n.depth * DEPTH_STAGGER) / (INTRO_MS * 0.6)));
            if (p <= 0) return;
            const s = ease(p);
            x0 += (w * (1 - s)) / 2; y0 += (h * (1 - s)) / 2; w *= s; h *= s; alpha = s;
          }
          const d = n.data;
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
          if (h > 6) g.rect(x0, y0, w, Math.min(h * 0.35, 18)).fill({ color: 0xffffff, alpha: 0.035 * alpha }); // top sheen
          if (w > 8 && h > 8) g.rect(x0 + 1, y0 + h - Math.min(h * 0.25, 10), w - 2, Math.min(h * 0.25, 10) - 1).fill({ color: 0x000000, alpha: 0.12 * alpha }); // inset shadow
          // luminous 1px border
          const borderCol = isCode ? mix(base, 0xffffff, 0.35) : 0x38bdf8;
          g.rect(x0 + 0.5, y0 + 0.5, Math.max(0, w - 1), Math.max(0, h - 1)).stroke({ width: 1, color: borderCol, alpha: (dim ? 0.18 : isCode ? 0.55 : 0.22 + 0.25 / (1 + n.depth)) * alpha });

          if (glow && w > 3 && h > 3) {
            g.rect(x0 - 1.5, y0 - 1.5, w + 3, h + 3).stroke({ width: 3, color: 0xfde68a, alpha: 0.35 * alpha * (fading ? fadeT : 1) });
            g.rect(x0 + 0.5, y0 + 0.5, w - 1, h - 1).stroke({ width: 1.5, color: 0xfffbeb, alpha: 0.8 * alpha * (fading ? fadeT : 1) });
          }
          // labels
          if (!intro && w > 44 && h > 16 && li < 400) {
            let lab = labelPool[li];
            if (!lab) { lab = document.createElement('div'); labelPool.push(lab); labelsEl.appendChild(lab); }
            li++;
            lab.className = 'tile-label' + (d.kind === 'folder' ? ' folder' : '');
            lab.textContent = d.kind === 'file' && w > 140 && h > 34 ? `${d.name}  ${d.sloc}` : d.name;
            lab.style.display = 'block';
            lab.style.transform = `translate(${Math.max(0, x0)}px, ${Math.max(0, y0)}px)`;
            lab.style.maxWidth = `${w}px`;
            lab.style.opacity = dim ? '0.55' : '1';
          }

          if (!n.children) return;
          // semantic zoom: hide inner-file structure until the file is big on screen
          if (d.kind === 'file' && (w < DETAIL_PX || h < DETAIL_PX * 0.6)) return;
          for (const c of n.children) visit(c);
        };
        visit(laid);
        for (let i = li; i < labelPool.length; i++) labelPool[i]!.style.display = 'none';
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
          if (sx < 0 || sy < 0 || sx > r.width || sy > r.height || e.target !== canvas) { hoverCb.current(null); return; }
          const w = toWorld(sx, sy);
          // deepest node that is actually drawn (respect semantic zoom)
          const path = hit(w.x, w.y);
          let pick = path[0]!;
          for (const n of path) {
            const pw = (n.x1 - n.x0) * cam.k, ph = (n.y1 - n.y0) * cam.k;
            if (pw < MIN_PX || ph < MIN_PX) break;
            pick = n;
            if (n.data.kind === 'file' && (pw < DETAIL_PX || ph < DETAIL_PX * 0.6)) break;
          }
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
        const r = canvas.getBoundingClientRect();
        const w = toWorld(e.clientX - r.left, e.clientY - r.top);
        const path = hit(w.x, w.y);
        const idx = path.indexOf(focus);
        const next = idx >= 0 ? path[idx + 1] : path[1];
        if (next) flyTo(next);
      };
      const up = () => { if (focus.parent) flyTo(focus.parent); };
      const onContext = (e: MouseEvent) => { e.preventDefault(); up(); };
      const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' || e.key === 'Backspace') { if ((e.target as HTMLElement)?.tagName !== 'INPUT') up(); } };
      const onResize = () => { dirty = true; };
      canvas.addEventListener('wheel', onWheel, { passive: false });
      canvas.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      canvas.addEventListener('contextmenu', onContext);
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
  }, [snapshot]);

  useEffect(() => { if (focusRequest) api.current?.focusId(focusRequest.id); }, [focusRequest]);

  return <div ref={host} className="absolute inset-0" />;
}
