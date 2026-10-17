/**
 * Drawing tools. Every tool renders through a `G` (graphics) interface. The same render function is
 * used to paint (Painter) and to hit-test (Hitter), so geometry and click areas always match.
 * Anchors are stored in time/price, so drawings survive timeframe and zoom changes.
 */
import type { Bar, Drawing, Pt } from '../lib/types';
import { FONT } from '../lib/format';

export interface DView {
  x(t: number): number; y(p: number): number; t(x: number): number; p(y: number): number;
  plotW: number; mainH: number; dec: number; tick: number; bars: Bar[]; row: number;
  fmt(p: number): string; acct: { size: number; risk: number };
}

type XY = [number, number];
interface LabelOpt { bg?: string; color?: string; align?: CanvasTextAlign; base?: 'top' | 'middle' | 'bottom'; size?: number; bold?: boolean }

export interface G {
  color: string; width: number; dash: number[];
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: string; width?: number; dash?: number[] }): void;
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; stroke?: string | false; hitFill?: boolean }): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, o?: { fill?: string; a0?: number; a1?: number }): void;
  poly(pts: XY[], o?: { close?: boolean; fill?: string; color?: string; width?: number; alpha?: number }): void;
  label(x: number, y: number, s: string, o?: LabelOpt): void;
}

/* ------------------------------------------------------------------ painter / hitter */
export class Painter implements G {
  color = '#e6e6e6'; width = 1.5; dash: number[] = [];
  constructor(public ctx: CanvasRenderingContext2D) {}
  private stroke(o?: { color?: string; width?: number; dash?: number[] }) {
    const c = this.ctx; c.strokeStyle = o?.color ?? this.color; c.lineWidth = o?.width ?? this.width; c.setLineDash(o?.dash ?? this.dash);
  }
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: string; width?: number; dash?: number[] }) {
    const c = this.ctx; this.stroke(o); c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]);
  }
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; stroke?: string | false }) {
    const c = this.ctx;
    if (o?.fill) { c.fillStyle = o.fill; c.fillRect(x, y, w, h); }
    if (o?.stroke !== false) { this.stroke(o?.stroke ? { color: o.stroke } : undefined); c.strokeRect(x, y, w, h); c.setLineDash([]); }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, o?: { fill?: string; a0?: number; a1?: number }) {
    const c = this.ctx; c.beginPath(); c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, o?.a0 ?? 0, o?.a1 ?? Math.PI * 2);
    if (o?.fill) { c.fillStyle = o.fill; c.fill(); }
    this.stroke(); c.stroke(); c.setLineDash([]);
  }
  poly(pts: XY[], o?: { close?: boolean; fill?: string; color?: string; width?: number; alpha?: number }) {
    if (pts.length < 2) return;
    const c = this.ctx; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    if (o?.close) c.closePath();
    if (o?.fill) { c.fillStyle = o.fill; c.fill(); }
    c.globalAlpha = o?.alpha ?? 1; this.stroke(o); c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(); c.globalAlpha = 1; c.setLineDash([]);
  }
  label(x: number, y: number, s: string, o: LabelOpt = {}) {
    const c = this.ctx, size = o.size ?? 11.5;
    c.font = `${o.bold ? '600 ' : ''}${size}px ${FONT}`;
    const w = c.measureText(s).width + (o.bg ? 10 : 0), h = size + 7;
    let lx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    let ly = o.base === 'top' ? y : o.base === 'bottom' ? y - h : y - h / 2;
    if (o.bg) { c.fillStyle = o.bg; c.fillRect(lx, ly, w, h); }
    c.fillStyle = o.color ?? this.color; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(s, lx + (o.bg ? 5 : 0), ly + h / 2 + 0.5);
  }
}

const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

export class Hitter implements G {
  color = ''; width = 1; dash: number[] = []; d = Infinity;
  constructor(public px: number, public py: number) {}
  line(x1: number, y1: number, x2: number, y2: number) { this.d = Math.min(this.d, segDist(this.px, this.py, x1, y1, x2, y2)); }
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; hitFill?: boolean }) {
    const x2 = x + w, y2 = y + h, l = Math.min(x, x2), r = Math.max(x, x2), t = Math.min(y, y2), b = Math.max(y, y2);
    if ((o?.fill || o?.hitFill) && this.px >= l && this.px <= r && this.py >= t && this.py <= b) { this.d = 0; return; }
    this.line(l, t, r, t); this.line(r, t, r, b); this.line(r, b, l, b); this.line(l, b, l, t);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, o?: { fill?: string }) {
    rx = Math.abs(rx) || 1e-6; ry = Math.abs(ry) || 1e-6;
    const k = Math.hypot((this.px - cx) / rx, (this.py - cy) / ry);
    if (o?.fill && k <= 1) { this.d = 0; return; }
    this.d = Math.min(this.d, Math.abs(k - 1) * Math.min(rx, ry));
  }
  poly(pts: XY[], o?: { close?: boolean; fill?: string }) {
    for (let i = 1; i < pts.length; i++) this.line(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
    if (o?.close && pts.length > 2) this.line(pts[pts.length - 1][0], pts[pts.length - 1][1], pts[0][0], pts[0][1]);
  }
  label(x: number, y: number, s: string, o: LabelOpt = {}) {
    const w = s.length * 6.5 + 10, h = 18, lx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x, ly = o.base === 'top' ? y : o.base === 'bottom' ? y - h : y - h / 2;
    if (this.px >= lx && this.px <= lx + w && this.py >= ly && this.py <= ly + h) this.d = 0;
  }
}

/* ------------------------------------------------------------------ helpers */
const fade = (hex: string, a: number) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

/** Clip the infinite line through (x1,y1)-(x2,y2) to the plot; `from1` = start at point 1 (ray). */
function extend(V: DView, x1: number, y1: number, x2: number, y2: number, from1: boolean): [number, number, number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return [x1, y1, x2, y2];
  const ts: number[] = [];
  const W = V.plotW, H = V.mainH;
  if (Math.abs(dx) > 1e-9) { ts.push((0 - x1) / dx, (W - x1) / dx); }
  if (Math.abs(dy) > 1e-9) { ts.push((0 - y1) / dy, (H - y1) / dy); }
  const inside = ts.filter(t => { const x = x1 + t * dx, y = y1 + t * dy; return x >= -1 && x <= W + 1 && y >= -1 && y <= H + 1; }).sort((a, b) => a - b);
  if (inside.length < 2) return [x1, y1, x2, y2];
  let a = inside[0], b = inside[inside.length - 1];
  if (from1) a = 0;
  if (from1 && b < 0) b = 1;
  return [x1 + a * dx, y1 + a * dy, x1 + b * dx, y1 + b * dy];
}

const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIB_COL: Record<string, string> = { '0': '#9a9a9a', '0.236': '#ff4d5e', '0.382': '#ffb020', '0.5': '#42da45', '0.618': '#00e5ff', '0.786': '#4da3ff', '1': '#9a9a9a', '1.272': '#c38bff', '1.618': '#ff3df5', '2': '#ffb020', '2.618': '#ff4d5e' };
const fibCol = (lv: number, base: string) => FIB_COL[String(lv)] ?? base;

function barIndexAt(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}

/* ------------------------------------------------------------------ tool registry */
export interface ToolDef {
  id: string; label: string; group: string; icon: string; key?: string;
  /** number of clicks to place (0 = freehand drag, -1 = polyline until double-click / Enter) */
  n: number;
  color?: string; width?: number; fill?: boolean; text?: string;
  init?(d: Drawing, V: DView): void;
  render(g: G, d: Drawing, V: DView): void;
  moveHandle?(d: Drawing, i: number, pt: Pt): void;
}

const P = (V: DView, pt: Pt): XY => [V.x(pt.t), V.y(pt.p)];

const lineTool = (id: string, label: string, icon: string, mode: 'seg' | 'ray' | 'ext', key?: string): ToolDef => ({
  id, label, group: 'Lines', icon, n: 2, key,
  render(g, d, V) {
    if (d.pts.length < 2) return;
    const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]);
    if (mode === 'seg') g.line(x1, y1, x2, y2); else { const e = extend(V, x1, y1, x2, y2, mode === 'ray'); g.line(e[0], e[1], e[2], e[3]); }
  },
});

export const TOOLS: ToolDef[] = [
  /* ---------------- lines ---------------- */
  lineTool('trend', 'Trend line', 'trend', 'seg', 'Alt+T'),
  lineTool('ray', 'Ray', 'ray', 'ray'),
  lineTool('extended', 'Extended line', 'extended', 'ext'),
  { id: 'hline', label: 'Horizontal line', group: 'Lines', icon: 'hline', n: 1, key: 'Alt+H',
    render(g, d, V) { const y = V.y(d.pts[0].p); g.line(0, y, V.plotW, y); g.label(V.plotW - 4, y, V.fmt(d.pts[0].p), { bg: '#2a2a2a', color: g.color, align: 'right' }); } },
  { id: 'hray', label: 'Horizontal ray', group: 'Lines', icon: 'hray', n: 1,
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.line(x, y, V.plotW, y); g.label(x + 4, y - 9, V.fmt(d.pts[0].p), { color: g.color }); } },
  { id: 'vline', label: 'Vertical line', group: 'Lines', icon: 'vline', n: 1, key: 'Alt+V',
    render(g, d, V) { const x = V.x(d.pts[0].t); g.line(x, 0, x, V.mainH); } },
  { id: 'crossline', label: 'Cross line', group: 'Lines', icon: 'crossline', n: 1,
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.line(x, 0, x, V.mainH); g.line(0, y, V.plotW, y); } },
  { id: 'channel', label: 'Parallel channel', group: 'Lines', icon: 'channel', n: 3, fill: true,
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2);
      if (d.pts.length < 3) return;
      const [x3, y3] = P(V, d.pts[2]);
      const slope = (y2 - y1) / ((x2 - x1) || 1e-9), off = y3 - (y1 + slope * (x3 - x1));
      g.line(x1, y1 + off, x2, y2 + off);
      g.line(x1, y1 + off / 2, x2, y2 + off / 2, { dash: [4, 4], width: 1 });
      if (d.fill) g.poly([[x1, y1], [x2, y2], [x2, y2 + off], [x1, y1 + off]], { close: true, fill: fade(g.color, 0.08), width: 0.01 });
    } },
  { id: 'regression', label: 'Regression channel', group: 'Lines', icon: 'regression', n: 2,
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts[0].t <= d.pts[1].t ? [d.pts[0], d.pts[1]] : [d.pts[1], d.pts[0]];
      const i0 = Math.max(0, barIndexAt(V.bars, a.t)), i1 = barIndexAt(V.bars, b.t);
      if (i1 - i0 < 2) { g.line(V.x(a.t), V.y(a.p), V.x(b.t), V.y(b.p), { dash: [4, 4] }); return; }
      let sx = 0, sy = 0, sxx = 0, sxy = 0; const n = i1 - i0 + 1;
      for (let i = i0; i <= i1; i++) { const x = i - i0, y = V.bars[i].c; sx += x; sy += y; sxx += x * x; sxy += x * y; }
      const m = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1), c = (sy - m * sx) / n;
      let sd = 0; for (let i = i0; i <= i1; i++) sd += (V.bars[i].c - (m * (i - i0) + c)) ** 2; sd = Math.sqrt(sd / n);
      const xa = V.x(V.bars[i0].t), xb = V.x(V.bars[i1].t), ya = c, yb = m * (n - 1) + c;
      g.line(xa, V.y(ya), xb, V.y(yb));
      for (const k of [2, -2]) g.line(xa, V.y(ya + k * sd), xb, V.y(yb + k * sd), { dash: [5, 4], width: 1 });
      g.poly([[xa, V.y(ya + 2 * sd)], [xb, V.y(yb + 2 * sd)], [xb, V.y(yb - 2 * sd)], [xa, V.y(ya - 2 * sd)]], { close: true, fill: fade(g.color, 0.06), width: 0.01 });
    } },

  /* ---------------- fibonacci ---------------- */
  { id: 'fib', label: 'Fib retracement', group: 'Fibonacci', icon: 'fib', n: 2, color: '#9a9a9a', key: 'Alt+F',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [p1, p2] = d.pts, xl = Math.min(V.x(p1.t), V.x(p2.t)), xr = Math.max(V.x(p1.t), V.x(p2.t));
      g.line(V.x(p1.t), V.y(p1.p), V.x(p2.t), V.y(p2.p), { dash: [3, 3], width: 1 });
      let prev: number | null = null;
      for (const lv of FIB) {
        const pr = p2.p + (p1.p - p2.p) * lv, y = V.y(pr), col = fibCol(lv, g.color);
        if (prev != null) g.rect(xl, prev, xr - xl, y - prev, { fill: fade(col, 0.07), stroke: false });
        g.line(xl, y, xr, y, { color: col });
        g.label(xl - 4, y, `${lv} (${V.fmt(pr)})`, { color: col, align: 'right' });
        prev = y;
      }
    } },
  { id: 'fibext', label: 'Trend-based fib extension', group: 'Fibonacci', icon: 'fibext', n: 3, color: '#9a9a9a',
    render(g, d, V) {
      const [a, b, c] = d.pts; if (!b) return;
      g.line(V.x(a.t), V.y(a.p), V.x(b.t), V.y(b.p), { dash: [3, 3], width: 1 });
      if (!c) return;
      g.line(V.x(b.t), V.y(b.p), V.x(c.t), V.y(c.p), { dash: [3, 3], width: 1 });
      const xl = V.x(c.t), xr = Math.max(xl + 80, V.x(c.t) + Math.abs(V.x(b.t) - V.x(a.t)));
      for (const lv of FIB_EXT) { const pr = c.p + (b.p - a.p) * lv, y = V.y(pr), col = fibCol(lv, g.color); g.line(xl, y, xr, y, { color: col }); g.label(xr + 4, y, `${lv} (${V.fmt(pr)})`, { color: col }); }
    } },
  { id: 'fibchan', label: 'Fib channel', group: 'Fibonacci', icon: 'fibchan', n: 3, color: '#9a9a9a',
    render(g, d, V) {
      const [a, b, c] = d.pts; if (!b) return;
      const [x1, y1] = P(V, a), [x2, y2] = P(V, b);
      g.line(x1, y1, x2, y2);
      if (!c) return;
      const [x3, y3] = P(V, c); const slope = (y2 - y1) / ((x2 - x1) || 1e-9), off = y3 - (y1 + slope * (x3 - x1));
      for (const lv of FIB_EXT.slice(1)) { const col = fibCol(lv, g.color); const e = extend(V, x1, y1 + off * lv, x2, y2 + off * lv, true); g.line(e[0], e[1], e[2], e[3], { color: col, width: 1 }); g.label(x1 - 4, y1 + off * lv, String(lv), { color: col, align: 'right' }); }
    } },
  { id: 'fibtime', label: 'Fib time zones', group: 'Fibonacci', icon: 'fibtime', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const unit = d.pts[1].t - d.pts[0].t; if (!unit) return;
      for (const k of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) { const x = V.x(d.pts[0].t + unit * k); if (x > V.plotW + 50) break; g.line(x, 0, x, V.mainH, { width: 1 }); g.label(x + 3, V.mainH - 12, String(k), { color: g.color }); }
    } },
  { id: 'fibfan', label: 'Fib speed fan', group: 'Fibonacci', icon: 'fibfan', n: 2, color: '#9a9a9a',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts, [x1, y1] = P(V, a);
      for (const lv of [0.236, 0.382, 0.5, 0.618, 0.786, 1]) { const col = fibCol(lv, g.color); const e = extend(V, x1, y1, V.x(b.t), V.y(b.p + (a.p - b.p) * lv), true); g.line(e[0], e[1], e[2], e[3], { color: col, width: 1 }); g.label(V.x(b.t) + 4, V.y(b.p + (a.p - b.p) * lv), String(lv), { color: col }); }
    } },
  { id: 'fibcircle', label: 'Fib circles', group: 'Fibonacci', icon: 'fibcircle', n: 2, color: '#9a9a9a',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), r = Math.hypot(x2 - x1, y2 - y1);
      g.line(x1, y1, x2, y2, { dash: [3, 3], width: 1 });
      for (const lv of [0.382, 0.618, 1, 1.618, 2.618]) { g.color = fibCol(lv, '#9a9a9a'); g.ellipse(x1, y1, r * lv, r * lv); }
    } },
  { id: 'fibarc', label: 'Fib speed arcs', group: 'Fibonacci', icon: 'fibarc', n: 2, color: '#9a9a9a',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), r = Math.hypot(x2 - x1, y2 - y1), up = y1 > y2;
      g.line(x1, y1, x2, y2, { dash: [3, 3], width: 1 });
      for (const lv of [0.382, 0.5, 0.618, 1]) { g.color = fibCol(lv, '#9a9a9a'); g.ellipse(x2, y2, r * lv, r * lv, up ? { a0: 0, a1: Math.PI } : { a0: Math.PI, a1: Math.PI * 2 }); }
    } },

  /* ---------------- gann & pitchfork ---------------- */
  ...(['pitchfork', 'schiff'] as const).map((kind): ToolDef => ({
    id: kind, label: kind === 'pitchfork' ? 'Pitchfork' : 'Schiff pitchfork', group: 'Gann & Pitchfork', icon: 'pitchfork', n: 3, color: '#ffb020',
    render(g, d, V) {
      const [a, b, c] = d.pts; if (!b) return;
      let [ax, ay] = P(V, a); const [bx, by] = P(V, b);
      if (!c) { g.line(ax, ay, bx, by, { dash: [3, 3] }); return; }
      const [cx, cy] = P(V, c);
      if (kind === 'schiff') { ax = (ax + bx) / 2; ay = (ay + by) / 2; }
      const mx = (bx + cx) / 2, my = (by + cy) / 2;
      g.line(bx, by, cx, cy, { dash: [3, 3], width: 1 });
      const e = extend(V, ax, ay, mx, my, true); g.line(e[0], e[1], e[2], e[3]);
      for (const [px, py] of [[bx, by], [cx, cy]] as XY[]) { const f = extend(V, px, py, px + (mx - ax), py + (my - ay), true); g.line(f[0], f[1], f[2], f[3]); }
    },
  })),
  { id: 'gannfan', label: 'Gann fan', group: 'Gann & Pitchfork', icon: 'gannfan', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), dx = x2 - x1, dy = y2 - y1;
      for (const [r, lab] of [[1, '1x1'], [2, '1x2'], [0.5, '2x1'], [3, '1x3'], [1 / 3, '3x1'], [4, '1x4'], [0.25, '4x1'], [8, '1x8'], [0.125, '8x1']] as [number, string][]) {
        const e = extend(V, x1, y1, x1 + dx, y1 + dy / r, true); g.line(e[0], e[1], e[2], e[3], { width: r === 1 ? 1.6 : 1, color: r === 1 ? '#ffb020' : g.color }); g.label(x1 + dx + 4, y1 + dy / r, lab, { color: g.color, size: 10 });
      }
    } },
  { id: 'gannbox', label: 'Gann box', group: 'Gann & Pitchfork', icon: 'gannbox', n: 2, color: '#ffb020',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), w = x2 - x1, h = y2 - y1;
      g.rect(x1, y1, w, h, { fill: fade(g.color, 0.05) });
      for (const k of [0.25, 0.382, 0.5, 0.618, 0.75]) { g.line(x1 + w * k, y1, x1 + w * k, y2, { width: 1, dash: [3, 3] }); g.line(x1, y1 + h * k, x2, y1 + h * k, { width: 1, dash: [3, 3] }); }
      g.line(x1, y1, x2, y2, { width: 1 }); g.line(x1, y2, x2, y1, { width: 1 });
    } },

  /* ---------------- shapes ---------------- */
  { id: 'rect', label: 'Rectangle', group: 'Shapes', icon: 'rect', n: 2, color: '#62b156', fill: true, key: 'Alt+R',
    render(g, d, V) { if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]); g.rect(x1, y1, x2 - x1, y2 - y1, { fill: d.fill ? fade(g.color, 0.15) : undefined, hitFill: true }); } },
  { id: 'ellipse', label: 'Ellipse', group: 'Shapes', icon: 'ellipse', n: 2, color: '#4da3ff', fill: true,
    render(g, d, V) { if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]); g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, { fill: d.fill ? fade(g.color, 0.15) : undefined }); } },
  { id: 'triangle', label: 'Triangle', group: 'Shapes', icon: 'triangle', n: 3, color: '#ffb020', fill: true,
    render(g, d, V) { const pts = d.pts.map(p => P(V, p)); g.poly(pts, { close: pts.length === 3, fill: d.fill && pts.length === 3 ? fade(g.color, 0.15) : undefined }); } },
  { id: 'path', label: 'Path (double-click to finish)', group: 'Shapes', icon: 'path', n: -1,
    render(g, d, V) { g.poly(d.pts.map(p => P(V, p))); } },
  { id: 'brush', label: 'Brush', group: 'Shapes', icon: 'brush', n: 0, color: '#ff3df5',
    render(g, d, V) { g.poly(d.pts.map(p => P(V, p))); } },
  { id: 'highlighter', label: 'Highlighter', group: 'Shapes', icon: 'highlighter', n: 0, color: '#ffd23f', width: 12,
    render(g, d, V) { g.poly(d.pts.map(p => P(V, p)), { alpha: 0.35 }); } },
  { id: 'arrow', label: 'Arrow', group: 'Shapes', icon: 'arrow', n: 2,
    render(g, d, V) {
      if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2); const a = Math.atan2(y2 - y1, x2 - x1), L = 12;
      g.poly([[x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], [x2, y2], [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]]);
    } },

  /* ---------------- positions ---------------- */
  ...([1, -1] as const).map((dir): ToolDef => ({
    id: dir > 0 ? 'long' : 'short', label: dir > 0 ? 'Long position' : 'Short position', group: 'Positions', icon: dir > 0 ? 'long' : 'short', n: 1,
    init(d, V) {
      const e = d.pts[0], span = Math.max(V.tick * 20, Math.abs(V.p(0) - V.p(V.mainH)) * 0.04);
      const end = V.t(V.x(e.t) + 160);
      d.pts = [e, { t: end, p: e.p + dir * span * 2 }, { t: end, p: e.p - dir * span }];
    },
    moveHandle(d, i, pt) {
      if (i === 0) d.pts[0] = pt;
      else { d.pts[i] = pt; d.pts[i === 1 ? 2 : 1].t = pt.t; }
    },
    render(g, d, V) {
      if (d.pts.length < 3) return;
      const [e, tp, sl] = d.pts, x0 = V.x(e.t), x1 = Math.max(V.x(tp.t), x0 + 20), ye = V.y(e.p), yt = V.y(tp.p), ys = V.y(sl.p);
      g.rect(x0, Math.min(ye, yt), x1 - x0, Math.abs(yt - ye), { fill: 'rgba(1,212,3,0.18)', stroke: false, hitFill: true });
      g.rect(x0, Math.min(ye, ys), x1 - x0, Math.abs(ys - ye), { fill: 'rgba(138,69,180,0.24)', stroke: false, hitFill: true });
      g.line(x0, ye, x1, ye, { color: '#d0d0d0', width: 1.2 });
      const risk = Math.abs(e.p - sl.p), reward = Math.abs(tp.p - e.p), rr = risk ? reward / risk : 0;
      const qty = risk ? (V.acct.size * V.acct.risk / 100) / risk : 0;
      const pct = (a: number) => ((a / e.p) * 100).toFixed(2);
      const ticks = (a: number) => Math.round(a / V.tick);
      g.label((x0 + x1) / 2, yt + (dir > 0 ? -2 : 2), `Target ${V.fmt(tp.p)}  ${pct(reward)}%  ${ticks(reward)} t  +$${(reward * qty).toFixed(0)}`, { bg: '#0e5b0d', color: '#fff', align: 'center', base: dir > 0 ? 'bottom' : 'top' });
      g.label((x0 + x1) / 2, ys + (dir > 0 ? 2 : -2), `Stop ${V.fmt(sl.p)}  ${pct(risk)}%  ${ticks(risk)} t  -$${(risk * qty).toFixed(0)}`, { bg: '#4a1f6f', color: '#fff', align: 'center', base: dir > 0 ? 'top' : 'bottom' });
      g.label((x0 + x1) / 2, ye, `${dir > 0 ? 'Long' : 'Short'}  Qty ${qty >= 10 ? qty.toFixed(1) : qty.toPrecision(3)}  R:R ${rr.toFixed(2)}`, { bg: '#2a2a2a', color: '#eee', align: 'center' });
      // outcome from price data
      const i0 = barIndexAt(V.bars, e.t);
      if (i0 >= 0) {
        for (let i = i0 + 1; i < V.bars.length && V.bars[i].t <= tp.t; i++) {
          const b = V.bars[i];
          const hitSl = dir > 0 ? b.l <= sl.p : b.h >= sl.p, hitTp = dir > 0 ? b.h >= tp.p : b.l <= tp.p;
          if (hitSl || hitTp) {
            const win = hitTp && !hitSl, px = win ? tp.p : sl.p, xx = V.x(b.t);
            g.line(x0, ye, xx, V.y(px), { color: win ? '#42da45' : '#b27ae6', dash: [4, 3], width: 1.2 });
            g.label(xx + 4, V.y(px) + (win ? dir * 14 : -dir * 14), win ? 'Target hit' : 'Stopped', { bg: win ? '#0e5b0d' : '#4a1f6f', color: '#fff' });
            break;
          }
        }
      }
    },
  })),

  /* ---------------- measure ---------------- */
  { id: 'pricerange', label: 'Price range', group: 'Measure', icon: 'pricerange', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), xm = (x1 + x2) / 2, dp = b.p - a.p;
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(g.color, 0.12), stroke: false, hitFill: true });
      g.line(x1, y1, x2, y1, { width: 1 }); g.line(x1, y2, x2, y2, { width: 1 }); g.line(xm, y1, xm, y2);
      g.label(xm, y2 + (dp >= 0 ? -4 : 4), `${dp >= 0 ? '+' : ''}${dp.toFixed(V.dec)} (${((dp / a.p) * 100).toFixed(2)}%)  ${Math.round(dp / V.tick)} ticks`, { bg: g.color, color: '#0c0c0c', align: 'center', base: dp >= 0 ? 'bottom' : 'top' });
    } },
  { id: 'daterange', label: 'Date range', group: 'Measure', icon: 'daterange', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), ym = (y1 + y2) / 2;
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(g.color, 0.12), stroke: false, hitFill: true });
      g.line(x1, y1, x1, y2, { width: 1 }); g.line(x2, y1, x2, y2, { width: 1 }); g.line(x1, ym, x2, ym);
      const i0 = barIndexAt(V.bars, Math.min(a.t, b.t)), i1 = barIndexAt(V.bars, Math.max(a.t, b.t)), ms = Math.abs(b.t - a.t);
      let vol = 0; for (let i = Math.max(0, i0); i <= i1 && i < V.bars.length; i++) vol += V.bars[i].v;
      const dur = ms >= 86_400_000 ? `${(ms / 86_400_000).toFixed(1)}d` : ms >= 3_600_000 ? `${Math.floor(ms / 3_600_000)}h ${Math.round((ms % 3_600_000) / 60000)}m` : `${Math.round(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
      g.label((x1 + x2) / 2, Math.max(y1, y2) + 4, `${Math.max(0, i1 - i0)} bars · ${dur} · vol ${vol.toFixed(1)}`, { bg: g.color, color: '#0c0c0c', align: 'center', base: 'top' });
    } },
  { id: 'dprange', label: 'Date & price range', group: 'Measure', icon: 'dprange', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), dp = b.p - a.p, up = dp >= 0;
      const col = up ? '#01d403' : '#8a45b4';
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(col, 0.15), stroke: false, hitFill: true });
      g.line(x1, y1, x2, y2, { color: col, dash: [4, 3] });
      const i0 = barIndexAt(V.bars, Math.min(a.t, b.t)), i1 = barIndexAt(V.bars, Math.max(a.t, b.t));
      g.label(x2 + 6, y2, `${up ? '+' : ''}${dp.toFixed(V.dec)} (${((dp / a.p) * 100).toFixed(2)}%) · ${Math.round(dp / V.tick)} t · ${Math.max(0, i1 - i0)} bars`, { bg: up ? '#0e5b0d' : '#4a1f6f', color: '#fff' });
    } },

  /* ---------------- text & marks ---------------- */
  { id: 'text', label: 'Text', group: 'Text & Marks', icon: 'text', n: 1, text: 'Text',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.label(x, y, d.text || 'Text', { color: g.color, size: 13 + d.width * 2, base: 'bottom' }); } },
  { id: 'callout', label: 'Callout', group: 'Text & Marks', icon: 'callout', n: 2, text: 'Note', color: '#ffb020',
    render(g, d, V) {
      const [x1, y1] = P(V, d.pts[0]); if (d.pts.length < 2) return; const [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2, { width: 1 }); g.label(x2, y2, d.text || 'Note', { bg: g.color, color: '#111', align: 'center', size: 12.5 });
    } },
  { id: 'pricelabel', label: 'Price label', group: 'Text & Marks', icon: 'pricelabel', n: 1, color: '#4da3ff',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.poly([[x, y], [x + 8, y - 10], [x + 8, y + 10]], { close: true, fill: g.color }); g.label(x + 8, y, V.fmt(d.pts[0].p), { bg: g.color, color: '#fff' }); } },
  { id: 'arrowup', label: 'Arrow mark up', group: 'Text & Marks', icon: 'arrowup', n: 1, color: '#42da45',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.poly([[x, y], [x + 8, y + 10], [x + 3, y + 10], [x + 3, y + 22], [x - 3, y + 22], [x - 3, y + 10], [x - 8, y + 10]], { close: true, fill: g.color }); } },
  { id: 'arrowdown', label: 'Arrow mark down', group: 'Text & Marks', icon: 'arrowdown', n: 1, color: '#b27ae6',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.poly([[x, y], [x + 8, y - 10], [x + 3, y - 10], [x + 3, y - 22], [x - 3, y - 22], [x - 3, y - 10], [x - 8, y - 10]], { close: true, fill: g.color }); } },

  /* ---------------- order flow ---------------- */
  { id: 'avwap', label: 'Anchored VWAP', group: 'Order Flow', icon: 'avwap', n: 1, color: '#ffffff',
    render(g, d, V) {
      const i0 = Math.max(0, barIndexAt(V.bars, d.pts[0].t)); if (!V.bars.length) return;
      let pv = 0, vv = 0, pv2 = 0; const mid: XY[] = [], up: XY[] = [], dn: XY[] = [];
      for (let i = i0; i < V.bars.length; i++) {
        const b = V.bars[i], tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; pv2 += tp * tp * b.v;
        const m = vv ? pv / vv : tp, sd = vv ? Math.sqrt(Math.max(0, pv2 / vv - m * m)) : 0, x = V.x(b.t);
        mid.push([x, V.y(m)]); up.push([x, V.y(m + sd)]); dn.push([x, V.y(m - sd)]);
      }
      g.poly(mid); g.poly(up, { width: 1, color: fade(g.color.length === 7 ? g.color : '#ffffff', 0.45) }); g.poly(dn, { width: 1, color: fade(g.color.length === 7 ? g.color : '#ffffff', 0.45) });
      const [x, y] = P(V, d.pts[0]); g.label(x, y + 12, 'AVWAP', { color: g.color, size: 10 });
    } },
  { id: 'fixedvp', label: 'Fixed range volume profile', group: 'Order Flow', icon: 'fixedvp', n: 2, color: '#8a45b4',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const ta = Math.min(d.pts[0].t, d.pts[1].t), tb = Math.max(d.pts[0].t, d.pts[1].t), x1 = V.x(ta), x2 = V.x(tb);
      const prof = new Map<number, [number, number]>(); let mx = 0, poc = 0, tot = 0, hi = -Infinity, lo = Infinity;
      for (const b of V.bars) {
        if (b.t < ta || b.t > tb) continue;
        hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
        if (b.fp.size) for (const [k, [s, bb]] of b.fp) { const r = prof.get(k) || [0, 0]; r[0] += s; r[1] += bb; prof.set(k, r); }
        else { const k = Math.round(((b.h + b.l + b.c) / 3) / V.row); const r = prof.get(k) || [0, 0]; r[0] += b.s; r[1] += b.b; prof.set(k, r); }
      }
      for (const [k, [s, b]] of prof) { tot += s + b; if (s + b > mx) { mx = s + b; poc = k; } }
      g.rect(x1, V.y(hi), x2 - x1, V.y(lo) - V.y(hi), { fill: 'rgba(255,255,255,0.025)', stroke: '#444', hitFill: true });
      if (!mx) return;
      const sorted = [...prof.entries()].sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])); let acc = 0; const va = new Set<number>();
      for (const [k, r] of sorted) { if (acc > tot * 0.7) break; acc += r[0] + r[1]; va.add(k); }
      const rowPx = Math.max(1, Math.abs(V.y(0) - V.y(V.row)) - 1), maxW = (x2 - x1) * 0.6;
      for (const [k, [s, b]] of prof) {
        const y = V.y(k * V.row) - rowPx / 2, w = ((s + b) / mx) * maxW, inVa = va.has(k);
        g.rect(x1, y, w * (b / (s + b || 1)), rowPx, { fill: inVa ? 'rgba(1,212,3,0.55)' : 'rgba(1,212,3,0.22)', stroke: false });
        g.rect(x1 + w * (b / (s + b || 1)), y, w * (s / (s + b || 1)), rowPx, { fill: inVa ? 'rgba(138,69,180,0.65)' : 'rgba(138,69,180,0.25)', stroke: false });
      }
      const yp = V.y(poc * V.row); g.line(x1, yp, x2, yp, { color: '#e6e62a', width: 1.2 });
      g.label(x2 + 4, yp, `POC ${V.fmt(poc * V.row)}`, { color: '#e6e62a', size: 10.5 });
    } },
  { id: 'imbzone', label: 'Imbalance / supply-demand zone', group: 'Order Flow', icon: 'imbzone', n: 2, color: '#00e5ff', text: 'Zone',
    render(g, d, V) {
      if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [, y2] = P(V, d.pts[1]);
      g.rect(x1, y1, V.plotW - x1, y2 - y1, { fill: fade(g.color, 0.13), stroke: false, hitFill: true });
      g.line(x1, y1, V.plotW, y1, { width: 1 }); g.line(x1, y2, V.plotW, y2, { width: 1 });
      g.label(x1 + 4, Math.min(y1, y2) + 2, d.text || 'Zone', { color: g.color, base: 'top', size: 11 });
    } },
];

export const TOOL_MAP = new Map(TOOLS.map(t => [t.id, t]));
export const TOOL_GROUPS = ['Lines', 'Fibonacci', 'Gann & Pitchfork', 'Shapes', 'Positions', 'Measure', 'Text & Marks', 'Order Flow'];
export const PALETTE = ['#e6e6e6', '#42da45', '#8a45b4', '#ffb020', '#00e5ff', '#ff3df5', '#ff4d5e', '#4da3ff', '#ffd23f'];

export function renderDrawing(g: G, d: Drawing, V: DView) {
  const def = TOOL_MAP.get(d.type); if (!def) return;
  g.color = d.color; g.width = d.width; g.dash = d.dash === 1 ? [6, 4] : d.dash === 2 ? [2, 3] : [];
  def.render(g, d, V);
}

export function hitDrawing(d: Drawing, V: DView, x: number, y: number): number {
  const h = new Hitter(x, y); renderDrawing(h, d, V); return h.d;
}

/** Handle positions (pixels) for a drawing. */
export function handlesOf(d: Drawing, V: DView): XY[] {
  if (d.type === 'brush' || d.type === 'highlighter') return d.pts.length ? [P(V, d.pts[0]), P(V, d.pts[d.pts.length - 1])] : [];
  if (d.type === 'hline') return [[V.plotW / 2, V.y(d.pts[0].p)]];
  if (d.type === 'vline') return [[V.x(d.pts[0].t), V.mainH / 2]];
  return d.pts.map(p => P(V, p));
}
