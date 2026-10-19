/**
 * Drawing tools — order-flow aware.
 *
 * Every tool renders through a `G` (graphics) interface. The same render function paints (Painter)
 * and hit-tests (Hitter), so geometry and click areas always match. Anchors are stored in
 * time/price, so drawings survive timeframe and zoom changes.
 *
 * Detail levels (TradingView-style, but with order flow):
 *   idle      clean drawing + the one number that matters (price, Δ%, status)
 *   hover     compact pill with key stats
 *   selected  full info card: price stats + volume, delta, buy/sell split, CVD sparkline,
 *             big trades, POC, touches, tested/broken status, R-multiples …
 */
import type { Bar, Drawing, Pt } from '../lib/types';
import { FONT, fmtQ } from '../lib/format';

export interface DView {
  x(t: number): number; y(p: number): number; t(x: number): number; p(y: number): number;
  plotW: number; mainH: number; dec: number; tick: number; bars: Bar[]; row: number;
  fmt(p: number): string; acct: { size: number; risk: number };
}
/** Render state passed by the engine. */
export interface RState { sel: boolean; hover: boolean }
const IDLE: RState = { sel: false, hover: false };

type XY = [number, number];
interface LabelOpt { bg?: string; color?: string; align?: CanvasTextAlign; base?: 'top' | 'middle' | 'bottom'; size?: number; bold?: boolean; border?: string }
export type Row =
  | { k: string; v: string; c?: string }
  | { split: [number, number] }                 // buy / sell volume bar
  | { spark: number[]; c?: string }             // cumulative-delta sparkline
  | { sep: true }
  | { note: string; c?: string };
interface CardOpt { accent?: string; side?: 'right' | 'left' }

export interface G {
  color: string; width: number; dash: number[]; bw: number; bh: number;
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: string; width?: number; dash?: number[] }): void;
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; stroke?: string | false; hitFill?: boolean; dash?: number[] }): void;
  ellipse(cx: number, cy: number, rx: number, ry: number, o?: { fill?: string; a0?: number; a1?: number; color?: string }): void;
  poly(pts: XY[], o?: { close?: boolean; fill?: string; color?: string; width?: number; alpha?: number; dash?: number[] }): void;
  label(x: number, y: number, s: string, o?: LabelOpt): void;
  dot(x: number, y: number, r: number, color: string, ring?: string): void;
  card(x: number, y: number, title: string, rows: Row[], o?: CardOpt): void;
}

/* ------------------------------------------------------------------ colours & format */
const UP = '#42da45', DN = '#b27ae6', MUTED = '#9a9aa2', GOLD = '#e6c84a', CARD_BG = 'rgba(26,26,30,0.95)';
const fade = (hex: string, a: number) => { if (!/^#[0-9a-f]{6}$/i.test(hex)) return `rgba(230,230,230,${a})`; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };
const sgn = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');
const fq = (v: number) => sgn(v) + fmtQ(Math.abs(v));
const pctS = (v: number, base: number) => (base ? `${sgn(v)}${Math.abs((v / base) * 100).toFixed(2)}%` : '—');
const colOf = (v: number) => (v > 0 ? UP : v < 0 ? DN : MUTED);
const dur = (ms: number) => { ms = Math.abs(ms); const m = Math.round(ms / 60000); if (ms < 60000) return `${Math.round(ms / 1000)}s`; if (m < 60) return `${m}m`; const h = Math.floor(m / 60); if (h < 48) return `${h}h ${m % 60}m`; return `${(h / 24).toFixed(1)}d`; };
const when = (t: number) => new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

function rr(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
}
const rowH = (r: Row) => ('sep' in r ? 7 : 'split' in r ? 20 : 'spark' in r ? 32 : 'note' in r ? 16 : 17);
function cardSize(title: string, rows: Row[], measure: (s: string, f: string) => number) {
  let w = measure(title, `600 12px ${FONT}`) + 24;
  for (const r of rows) {
    if ('k' in r) w = Math.max(w, measure(r.k, `11.5px ${FONT}`) + measure(r.v, `600 11.5px ${FONT}`) + 34);
    else if ('note' in r) w = Math.max(w, measure(r.note, `11px ${FONT}`) + 24);
  }
  w = Math.max(178, Math.min(300, w));
  const h = 28 + rows.reduce((a, r) => a + rowH(r), 0) + 6;
  return { w, h };
}
function cardPos(x: number, y: number, w: number, h: number, bw: number, bh: number, side?: 'right' | 'left') {
  let x0 = side === 'left' ? x - w - 12 : x + 12;
  if (x0 + w > bw - 4) x0 = x - w - 12;
  if (x0 < 4) x0 = Math.min(bw - w - 4, Math.max(4, x + 12));
  const y0 = Math.max(4, Math.min(bh - h - 4, y - 14));
  return [x0, y0];
}

/* ------------------------------------------------------------------ painter / hitter */
export class Painter implements G {
  color = '#e6e6e6'; width = 1.5; dash: number[] = []; bw = 1e4; bh = 1e4;
  ctx: CanvasRenderingContext2D;
  constructor(ctx: CanvasRenderingContext2D) { this.ctx = ctx; }
  private stroke(o?: { color?: string; width?: number; dash?: number[] }) {
    const c = this.ctx; c.strokeStyle = o?.color ?? this.color; c.lineWidth = o?.width ?? this.width; c.setLineDash(o?.dash ?? this.dash);
  }
  line(x1: number, y1: number, x2: number, y2: number, o?: { color?: string; width?: number; dash?: number[] }) {
    const c = this.ctx; this.stroke(o); c.lineCap = 'round'; c.beginPath(); c.moveTo(x1, y1); c.lineTo(x2, y2); c.stroke(); c.setLineDash([]);
  }
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; stroke?: string | false; dash?: number[] }) {
    const c = this.ctx;
    if (o?.fill) { c.fillStyle = o.fill; c.fillRect(x, y, w, h); }
    if (o?.stroke !== false) { this.stroke({ color: o?.stroke || undefined, dash: o?.dash }); c.strokeRect(x, y, w, h); c.setLineDash([]); }
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, o?: { fill?: string; a0?: number; a1?: number; color?: string }) {
    const c = this.ctx; c.beginPath(); c.ellipse(cx, cy, Math.abs(rx), Math.abs(ry), 0, o?.a0 ?? 0, o?.a1 ?? Math.PI * 2);
    if (o?.fill) { c.fillStyle = o.fill; c.fill(); }
    this.stroke({ color: o?.color }); c.stroke(); c.setLineDash([]);
  }
  poly(pts: XY[], o?: { close?: boolean; fill?: string; color?: string; width?: number; alpha?: number; dash?: number[] }) {
    if (pts.length < 2) return;
    const c = this.ctx; c.beginPath(); c.moveTo(pts[0][0], pts[0][1]); for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    if (o?.close) c.closePath();
    if (o?.fill) { c.fillStyle = o.fill; c.fill(); }
    if (o?.width === 0) return;
    c.globalAlpha = o?.alpha ?? 1; this.stroke(o); c.lineJoin = 'round'; c.lineCap = 'round'; c.stroke(); c.globalAlpha = 1; c.setLineDash([]);
  }
  label(x: number, y: number, s: string, o: LabelOpt = {}) {
    const c = this.ctx, size = o.size ?? 11.5;
    c.font = `${o.bold ? '600 ' : ''}${size}px ${FONT}`;
    const pad = o.bg ? 6 : 0, w = c.measureText(s).width + pad * 2, h = size + 8;
    const lx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x;
    const ly = o.base === 'top' ? y : o.base === 'bottom' ? y - h : y - h / 2;
    if (o.bg) { rr(c, lx, ly, w, h, 3); c.fillStyle = o.bg; c.fill(); if (o.border) { c.strokeStyle = o.border; c.lineWidth = 1; c.setLineDash([]); c.stroke(); } }
    c.fillStyle = o.color ?? this.color; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(s, lx + pad, ly + h / 2 + 0.5);
  }
  dot(x: number, y: number, r: number, color: string, ring?: string) {
    const c = this.ctx; c.beginPath(); c.arc(x, y, r, 0, Math.PI * 2); c.fillStyle = color; c.fill();
    if (ring) { c.strokeStyle = ring; c.lineWidth = 1.5; c.setLineDash([]); c.stroke(); }
  }
  card(x: number, y: number, title: string, rows: Row[], o: CardOpt = {}) {
    const c = this.ctx;
    const { w, h } = cardSize(title, rows, (s, f) => { c.font = f; return c.measureText(s).width; });
    const [x0, y0] = cardPos(x, y, w, h, this.bw, this.bh, o.side);
    c.save(); c.shadowColor = 'rgba(0,0,0,0.55)'; c.shadowBlur = 14; c.shadowOffsetY = 3;
    rr(c, x0, y0, w, h, 6); c.fillStyle = CARD_BG; c.fill(); c.restore();
    rr(c, x0, y0, w, h, 6); c.strokeStyle = '#3a3a42'; c.lineWidth = 1; c.setLineDash([]); c.stroke();
    c.fillStyle = o.accent || this.color; rr(c, x0, y0, 3, h, 1.5); c.fill();
    c.textBaseline = 'middle'; c.textAlign = 'left';
    c.font = `600 12px ${FONT}`; c.fillStyle = '#f0f0f2'; c.fillText(title, x0 + 12, y0 + 15);
    let yy = y0 + 28;
    for (const r of rows) {
      const rh = rowH(r);
      if ('sep' in r) { c.fillStyle = '#34343a'; c.fillRect(x0 + 10, yy + 3, w - 20, 1); }
      else if ('k' in r) {
        c.font = `11.5px ${FONT}`; c.fillStyle = MUTED; c.textAlign = 'left'; c.fillText(r.k, x0 + 12, yy + rh / 2);
        c.font = `600 11.5px ${FONT}`; c.fillStyle = r.c || '#e8e8ea'; c.textAlign = 'right'; c.fillText(r.v, x0 + w - 10, yy + rh / 2);
      } else if ('note' in r) {
        c.font = `11px ${FONT}`; c.fillStyle = r.c || GOLD; c.textAlign = 'left'; c.fillText(r.note, x0 + 12, yy + rh / 2);
      } else if ('split' in r) {
        const [b, s] = r.split, tot = b + s || 1, bw = w - 24, bx = x0 + 12, by = yy + 3, bh = 14, wb = bw * (b / tot);
        rr(c, bx, by, bw, bh, 3); c.fillStyle = 'rgba(138,69,180,0.75)'; c.fill();
        if (wb > 0.5) { rr(c, bx, by, wb, bh, 3); c.fillStyle = 'rgba(1,212,3,0.75)'; c.fill(); }
        c.font = `600 10.5px ${FONT}`; c.fillStyle = '#fff';
        c.textAlign = 'left'; c.fillText(`Buy ${Math.round((b / tot) * 100)}%`, bx + 5, by + bh / 2 + 0.5);
        c.textAlign = 'right'; c.fillText(`${Math.round((s / tot) * 100)}% Sell`, bx + bw - 5, by + bh / 2 + 0.5);
      } else if ('spark' in r) {
        const v = r.spark, bx = x0 + 12, bw = w - 24, by = yy + 3, bh = rh - 8;
        if (v.length > 1) {
          let mn = Math.min(0, ...v), mx = Math.max(0, ...v); if (mx === mn) { mx += 1; mn -= 1; }
          const Y = (q: number) => by + ((mx - q) / (mx - mn)) * bh, X = (i: number) => bx + (i / (v.length - 1)) * bw;
          c.fillStyle = '#2a2a30'; c.fillRect(bx, Y(0), bw, 1);
          c.beginPath(); v.forEach((q, i) => (i ? c.lineTo(X(i), Y(q)) : c.moveTo(X(i), Y(q))));
          c.strokeStyle = r.c || (v[v.length - 1] >= 0 ? UP : DN); c.lineWidth = 1.6; c.stroke();
          c.lineTo(X(v.length - 1), Y(0)); c.lineTo(X(0), Y(0)); c.closePath(); c.fillStyle = fade(r.c || (v[v.length - 1] >= 0 ? UP : DN), 0.15); c.fill();
          c.font = `10px ${FONT}`; c.fillStyle = MUTED; c.textAlign = 'left'; c.fillText('CVD', bx + 2, by + 6);
        }
      }
      yy += rh;
    }
    c.textAlign = 'left';
  }
}

const segDist = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
  const dx = x2 - x1, dy = y2 - y1, l = dx * dx + dy * dy;
  let t = l ? ((px - x1) * dx + (py - y1) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
};

export class Hitter implements G {
  color = ''; width = 1; dash: number[] = []; d = Infinity; bw = 1e4; bh = 1e4;
  px: number; py: number;
  constructor(px: number, py: number) { this.px = px; this.py = py; }
  private inBox(l: number, t: number, w: number, h: number) { if (this.px >= l && this.px <= l + w && this.py >= t && this.py <= t + h) this.d = 0; }
  line(x1: number, y1: number, x2: number, y2: number) { this.d = Math.min(this.d, segDist(this.px, this.py, x1, y1, x2, y2)); }
  rect(x: number, y: number, w: number, h: number, o?: { fill?: string; hitFill?: boolean }) {
    const x2 = x + w, y2 = y + h, l = Math.min(x, x2), r = Math.max(x, x2), t = Math.min(y, y2), b = Math.max(y, y2);
    if (o?.fill || o?.hitFill) { this.inBox(l, t, r - l, b - t); if (!this.d) return; }
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
    const size = o.size ?? 11.5, w = s.length * size * 0.56 + (o.bg ? 12 : 0), h = size + 8;
    const lx = o.align === 'center' ? x - w / 2 : o.align === 'right' ? x - w : x, ly = o.base === 'top' ? y : o.base === 'bottom' ? y - h : y - h / 2;
    this.inBox(lx, ly, w, h);
  }
  dot(x: number, y: number, r: number) { if (Math.hypot(this.px - x, this.py - y) <= r + 2) this.d = 0; }
  card(x: number, y: number, title: string, rows: Row[], o: CardOpt = {}) {
    const { w, h } = cardSize(title, rows, (s) => s.length * 6.6);
    const [x0, y0] = cardPos(x, y, w, h, this.bw, this.bh, o.side);
    this.inBox(x0, y0, w, h);
  }
}

/* ------------------------------------------------------------------ geometry helpers */
/** Clip the infinite line through (x1,y1)-(x2,y2) to the plot; `from1` = start at point 1 (ray). */
function extend(V: DView, x1: number, y1: number, x2: number, y2: number, from1: boolean): [number, number, number, number] {
  const dx = x2 - x1, dy = y2 - y1;
  if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) return [x1, y1, x2, y2];
  const ts: number[] = [], W = V.plotW, H = V.mainH;
  if (Math.abs(dx) > 1e-9) ts.push((0 - x1) / dx, (W - x1) / dx);
  if (Math.abs(dy) > 1e-9) ts.push((0 - y1) / dy, (H - y1) / dy);
  const inside = ts.filter(t => { const x = x1 + t * dx, y = y1 + t * dy; return x >= -1 && x <= W + 1 && y >= -1 && y <= H + 1; }).sort((a, b) => a - b);
  if (inside.length < 2) return [x1, y1, x2, y2];
  let a = inside[0], b = inside[inside.length - 1];
  if (from1) a = 0;
  if (from1 && b < 0) b = 1;
  return [x1 + a * dx, y1 + a * dy, x1 + b * dx, y1 + b * dy];
}

/** Last bar with time <= t (or -1). */
function barIndexAt(bars: Bar[], t: number): number {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (bars[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
/** First bar with time >= t (or bars.length). */
function barIndexFrom(bars: Bar[], t: number): number { const i = barIndexAt(bars, t); return i >= 0 && bars[i].t === t ? i : i + 1; }
const lastPx = (V: DView) => (V.bars.length ? V.bars[V.bars.length - 1].c : NaN);
const tolPrice = (V: DView, px = 4) => Math.abs(V.p(0) - V.p(px));

/* ------------------------------------------------------------------ order-flow statistics */
interface RS {
  n: number; i0: number; i1: number; o: number; c: number; hi: number; lo: number;
  vol: number; buy: number; sell: number; delta: number; cvd: number[];
  poc: number | null; vwap: number; bigB: number; bigS: number; bigBq: number; bigSq: number;
  avgVol: number; avgRng: number; ms: number;
}
/** Statistics for bars in [t0, t1], optionally limited to a price band (uses footprint cells). */
function rangeStats(V: DView, t0: number, t1: number, plo = -Infinity, phi = Infinity): RS | null {
  const bars = V.bars; if (!bars.length) return null;
  if (t0 > t1) [t0, t1] = [t1, t0];
  const i0 = Math.max(0, barIndexFrom(bars, t0)), i1 = Math.min(bars.length - 1, barIndexAt(bars, t1));
  if (i1 < i0) return null;
  const band = isFinite(plo) || isFinite(phi), prof = new Map<number, number>(), cvd: number[] = [];
  let vol = 0, buy = 0, sell = 0, hi = -Infinity, lo = Infinity, pv = 0, bigB = 0, bigS = 0, bigBq = 0, bigSq = 0, cum = 0;
  for (let i = i0; i <= i1; i++) {
    const b = bars[i]; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
    let bb = 0, ss = 0;
    if (b.fp.size) {
      for (const [k, [s, q]] of b.fp) { const p = k * V.row; if (p < plo || p > phi) continue; bb += q; ss += s; prof.set(k, (prof.get(k) || 0) + q + s); }
    } else if (!band || (b.h >= plo && b.l <= phi)) {
      const share = band ? Math.max(0, Math.min(b.h, phi) - Math.max(b.l, plo)) / ((b.h - b.l) || 1) : 1;
      bb = b.b * share; ss = b.s * share; const k = Math.round(((b.h + b.l + b.c) / 3) / V.row); prof.set(k, (prof.get(k) || 0) + bb + ss);
    }
    buy += bb; sell += ss; vol += bb + ss; pv += ((b.h + b.l + b.c) / 3) * (bb + ss); cum += bb - ss; cvd.push(cum);
    for (const t of b.big) { if (t[1] < plo || t[1] > phi) continue; if (t[3] > 0) { bigB++; bigBq += t[2]; } else { bigS++; bigSq += t[2]; } }
  }
  let poc: number | null = null, mx = 0; for (const [k, v] of prof) if (v > mx) { mx = v; poc = k * V.row; }
  const j0 = Math.max(0, i0 - 50), j1 = i0 > 10 ? i0 - 1 : i1; let sv = 0, sr = 0, m = 0;
  for (let j = j0; j <= j1; j++) { sv += bars[j].v; sr += bars[j].h - bars[j].l; m++; }
  return { n: i1 - i0 + 1, i0, i1, o: bars[i0].o, c: bars[i1].c, hi, lo, vol, buy, sell, delta: buy - sell, cvd, poc, vwap: vol ? pv / vol : NaN, bigB, bigS, bigBq, bigSq, avgVol: m ? sv / m : 0, avgRng: m ? sr / m : 0, ms: bars[i1].t - bars[i0].t };
}
/** Volume and delta traded at one price level across bars [i0, i1]. */
function volAt(V: DView, i0: number, i1: number, p: number): { v: number; d: number } {
  const k = Math.round(p / V.row); let v = 0, d = 0;
  for (let i = Math.max(0, i0); i <= i1 && i < V.bars.length; i++) { const c = V.bars[i].fp.get(k); if (c) { v += c[0] + c[1]; d += c[1] - c[0]; } }
  return { v, d };
}
/** Count separate touches of a price path; returns touch points and the bar index of the last touch. */
function touches(V: DView, i0: number, i1: number, f: (i: number) => number | null, px = 4) {
  const tol = tolPrice(V, px), pts: XY[] = []; let n = 0, inT = false, last = -1;
  for (let i = Math.max(0, i0); i <= i1 && i < V.bars.length; i++) {
    const lp = f(i); if (lp == null) { inT = false; continue; }
    const b = V.bars[i], hit = b.l <= lp + tol && b.h >= lp - tol;
    if (hit && !inT) { n++; pts.push([V.x(b.t), V.y(lp)]); last = i; }
    inT = hit;
  }
  return { n, pts, last };
}
/** Standard order-flow rows for a card. */
function flowRows(s: RS, withSpark = true): Row[] {
  const rows: Row[] = [
    { k: 'Volume', v: `${fmtQ(s.vol)}${s.avgVol ? `  (${(s.vol / s.n / s.avgVol).toFixed(1)}× avg)` : ''}` },
    { k: 'Delta', v: `${fq(s.delta)}  (${s.vol ? sgn(s.delta) + Math.abs((s.delta / s.vol) * 100).toFixed(0) : 0}%)`, c: colOf(s.delta) },
    { split: [s.buy, s.sell] },
  ];
  if (withSpark && s.cvd.length > 2) rows.push({ spark: s.cvd });
  if (s.bigB + s.bigS) rows.push({ k: 'Big trades', v: `${s.bigB} buy · ${s.bigS} sell`, c: s.bigBq > s.bigSq ? UP : s.bigSq > s.bigBq ? DN : undefined });
  if (s.poc != null) rows.push({ k: 'POC', v: String(+s.poc.toPrecision(10)) });
  return rows;
}
/** Order-flow reading for a range: absorption / divergence flags. */
function flowNotes(s: RS): Row[] {
  const out: Row[] = [], move = s.c - s.o, rng = s.hi - s.lo || 1;
  const heavy = s.avgVol && s.vol / s.n > s.avgVol * 1.4;
  if (heavy && Math.abs(move) < rng * 0.25 && Math.abs(s.delta) > s.vol * 0.12) out.push({ note: `⚠ Absorption — ${s.delta > 0 ? 'buyers' : 'sellers'} absorbed by passive orders`, c: GOLD });
  if (move > 0 && s.delta < -s.vol * 0.05) out.push({ note: '⚠ Bearish delta divergence (price ↑, delta ↓)', c: DN });
  if (move < 0 && s.delta > s.vol * 0.05) out.push({ note: '⚠ Bullish delta divergence (price ↓, delta ↑)', c: UP });
  return out;
}

/* ------------------------------------------------------------------ tool registry */
export interface ToolDef {
  id: string; label: string; group: string; icon: string; key?: string;
  /** clicks to place (0 = freehand drag, -1 = polyline until double-click / Enter) */
  n: number;
  color?: string; width?: number; fill?: boolean; text?: string;
  init?(d: Drawing, V: DView): void;
  render(g: G, d: Drawing, V: DView, s: RState): void;
  moveHandle?(d: Drawing, i: number, pt: Pt): void;
}

const P = (V: DView, pt: Pt): XY => [V.x(pt.t), V.y(pt.p)];
const pill = (g: G, x: number, y: number, s: string, col: string, o: Partial<LabelOpt> = {}) => g.label(x, y, s, { bg: fade(col, 0.22), color: col, border: fade(col, 0.6), size: 11, ...o });
const solidPill = (g: G, x: number, y: number, s: string, bg: string, o: Partial<LabelOpt> = {}) => g.label(x, y, s, { bg, color: '#fff', size: 11, bold: true, ...o });

/* ---------- lines ---------- */
function lineTool(id: string, label: string, icon: string, mode: 'seg' | 'ray' | 'ext', key?: string): ToolDef {
  return {
    id, label, group: 'Lines', icon, n: 2, key,
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts, [x1, y1] = P(V, a), [x2, y2] = P(V, b);
      if (mode === 'seg') g.line(x1, y1, x2, y2); else { const e = extend(V, x1, y1, x2, y2, mode === 'ray'); g.line(e[0], e[1], e[2], e[3]); }
      if (!s.sel && !s.hover) return;
      const dt = b.t - a.t, dp = b.p - a.p, at = (t: number) => a.p + (dt ? (dp * (t - a.t)) / dt : 0);
      const i0 = mode === 'ext' ? 0 : Math.max(0, barIndexFrom(V.bars, Math.min(a.t, b.t)));
      const i1 = mode === 'seg' ? barIndexAt(V.bars, Math.max(a.t, b.t)) : V.bars.length - 1;
      const T = touches(V, i0, i1, i => at(V.bars[i].t));
      for (const [tx, ty] of T.pts) g.dot(tx, ty, 3.5, fade(g.color, 0.9), '#111');
      const ang = (Math.atan2(-(y2 - y1), x2 - x1) * 180) / Math.PI, bars = Math.max(0, barIndexAt(V.bars, Math.max(a.t, b.t)) - barIndexAt(V.bars, Math.min(a.t, b.t)));
      pill(g, (x1 + x2) / 2, (y1 + y2) / 2 - 12, `${sgn(dp)}${V.fmt(Math.abs(dp))} (${pctS(dp, a.p)}) · ${bars} bars · ${ang.toFixed(0)}°`, colOf(dp), { align: 'center' });
      if (!s.sel) return;
      const L = lastPx(V), lineNow = at(V.bars[V.bars.length - 1]?.t ?? b.t), st = rangeStats(V, a.t, b.t);
      const rows: Row[] = [
        { k: 'Change', v: `${sgn(dp)}${V.fmt(Math.abs(dp))}  ${pctS(dp, a.p)}`, c: colOf(dp) },
        { k: 'Bars · time', v: `${bars} · ${dur(dt)}` },
        { k: 'Slope / bar', v: bars ? `${sgn(dp)}${(Math.abs(dp) / bars).toFixed(V.dec)}` : '—' },
        { k: 'Angle', v: `${ang.toFixed(1)}°` },
        { k: 'Touches', v: `${T.n}${T.last >= 0 ? `  (last ${V.bars.length - 1 - T.last} bars ago)` : ''}`, c: T.n >= 3 ? GOLD : undefined },
      ];
      if (mode !== 'seg' && isFinite(L)) rows.push({ k: 'Price vs line', v: `${L >= lineNow ? 'above' : 'below'} by ${pctS(L - lineNow, lineNow)}`, c: L >= lineNow ? UP : DN });
      if (st) rows.push({ sep: true }, ...flowRows(st), ...flowNotes(st));
      g.card(Math.max(x1, x2), Math.min(y1, y2), label, rows, { accent: g.color });
    },
  };
}

/** Horizontal level with role, distance, touches and volume at price. */
function levelInfo(g: G, d: Drawing, V: DView, s: RState, x0: number, title: string) {
  const p = d.pts[0].p, y = V.y(p), L = lastPx(V), dist = L - p;
  const i0 = d.type === 'hray' ? Math.max(0, barIndexFrom(V.bars, d.pts[0].t)) : 0;
  solidPill(g, V.plotW - 4, y, V.fmt(p), d.color.length === 7 ? fade(d.color, 0.85) : '#444', { align: 'right' });
  if (isFinite(L)) pill(g, V.plotW - 4, y + (dist >= 0 ? 15 : -15), `${dist >= 0 ? '▼' : '▲'} ${pctS(-dist, L).replace(/^[+−]/, '')} · ${Math.round(Math.abs(dist) / V.tick)}t`, MUTED, { align: 'right', size: 10 });
  if (!s.sel && !s.hover) return;
  const T = touches(V, i0, V.bars.length - 1, () => p);
  for (const [tx, ty] of T.pts) g.dot(tx, ty, 3.5, fade(g.color, 0.9), '#111');
  if (!s.sel) return;
  const va = volAt(V, i0, V.bars.length - 1, p);
  g.card(x0 + 40, y, title, [
    { k: 'Price', v: V.fmt(p) },
    { k: 'Role', v: isFinite(L) ? (L > p ? 'Support (price above)' : 'Resistance (price below)') : '—', c: L > p ? UP : DN },
    { k: 'Distance', v: isFinite(L) ? `${pctS(p - L, L)} · ${Math.round(Math.abs(dist) / V.tick)} ticks` : '—' },
    { k: 'Touches', v: `${T.n}${T.last >= 0 ? `  (last ${V.bars.length - 1 - T.last} bars ago)` : ''}`, c: T.n >= 3 ? GOLD : undefined },
    { sep: true },
    { k: 'Volume @ level', v: va.v ? fmtQ(va.v) : 'no footprint data' },
    { k: 'Delta @ level', v: va.v ? fq(va.d) : '—', c: colOf(va.d) },
    ...(T.n >= 3 ? [{ note: `Strong level — tested ${T.n} times` } as Row] : []),
  ], { accent: g.color });
}

/* ---------- fibonacci helpers ---------- */
const FIB = [0, 0.236, 0.382, 0.5, 0.618, 0.65, 0.786, 1];
const FIB_X = [1.272, 1.618];
const FIB_EXT = [0, 0.382, 0.618, 1, 1.272, 1.618, 2, 2.618];
const FIB_COL: Record<string, string> = { '0': '#9a9a9a', '0.236': '#ff4d5e', '0.382': '#ffb020', '0.5': '#42da45', '0.618': '#00e5ff', '0.65': '#00e5ff', '0.786': '#4da3ff', '1': '#9a9a9a', '1.272': '#c38bff', '1.618': '#ff3df5', '2': '#ffb020', '2.618': '#ff4d5e' };
const fibCol = (lv: number, base: string) => FIB_COL[String(lv)] ?? base;

/* ---------- position (long / short) evaluation ---------- */
function evalPosition(V: DView, d: Drawing, dir: 1 | -1) {
  const [e, tp, sl] = d.pts, risk = Math.abs(e.p - sl.p) || 1e-12, bars = V.bars;
  const i0 = barIndexFrom(bars, e.t), iEnd = barIndexAt(bars, tp.t);
  let status: 'pending' | 'active' | 'target' | 'stopped' | 'expired' = 'pending', exitI = -1, exitP = NaN, mfe = 0, mae = 0, entered = false;
  for (let i = i0; i < bars.length && i <= Math.max(iEnd, i0); i++) {
    const b = bars[i];
    if (!entered) { if (b.l <= e.p && b.h >= e.p) entered = true; else continue; }
    mfe = Math.max(mfe, dir > 0 ? b.h - e.p : e.p - b.l); mae = Math.max(mae, dir > 0 ? e.p - b.l : b.h - e.p);
    const hitS = dir > 0 ? b.l <= sl.p : b.h >= sl.p, hitT = dir > 0 ? b.h >= tp.p : b.l <= tp.p;
    if (hitS || hitT) { status = hitS ? 'stopped' : 'target'; exitI = i; exitP = hitS ? sl.p : tp.p; break; }
  }
  if (entered && status === 'pending') { if (iEnd >= bars.length - 1 || tp.t > bars[bars.length - 1].t) status = 'active'; else { status = 'expired'; exitI = iEnd; exitP = bars[iEnd].c; } }
  const L = lastPx(V), cur = status === 'active' ? L : exitP, pnl = entered && isFinite(cur) ? (cur - e.p) * dir : 0;
  return { status, exitI, exitP, mfeR: mfe / risk, maeR: mae / risk, pnl, rNow: pnl / risk, i0, entered };
}

/* ======================================================================================= */
export const TOOLS: ToolDef[] = [
  /* ---------------- lines ---------------- */
  lineTool('trend', 'Trend line', 'trend', 'seg', 'Alt+T'),
  lineTool('ray', 'Ray', 'ray', 'ray'),
  lineTool('extended', 'Extended line', 'extended', 'ext'),
  { id: 'hline', label: 'Horizontal line', group: 'Lines', icon: 'hline', n: 1, key: 'Alt+H',
    render(g, d, V, s) { const y = V.y(d.pts[0].p); g.line(0, y, V.plotW, y); levelInfo(g, d, V, s, V.plotW / 2, 'Horizontal level'); } },
  { id: 'hray', label: 'Horizontal ray', group: 'Lines', icon: 'hray', n: 1,
    render(g, d, V, s) { const [x, y] = P(V, d.pts[0]); g.line(x, y, V.plotW, y); g.dot(x, y, 3, g.color); levelInfo(g, d, V, s, x, 'Horizontal ray'); } },
  { id: 'vline', label: 'Vertical line', group: 'Lines', icon: 'vline', n: 1, key: 'Alt+V',
    render(g, d, V, s) {
      const x = V.x(d.pts[0].t); g.line(x, 0, x, V.mainH);
      solidPill(g, x, V.mainH - 4, when(d.pts[0].t), '#3a3a42', { align: 'center', base: 'bottom' });
      if (!s.sel) return;
      const i = barIndexAt(V.bars, d.pts[0].t), b = V.bars[i]; if (!b) return;
      g.card(x, 40, 'Bar at line', [
        { k: 'Time', v: when(b.t) }, { k: 'O / C', v: `${V.fmt(b.o)} → ${V.fmt(b.c)}`, c: colOf(b.c - b.o) }, { k: 'H / L', v: `${V.fmt(b.h)} / ${V.fmt(b.l)}` },
        { sep: true }, { k: 'Volume', v: fmtQ(b.v) }, { k: 'Delta', v: fq(b.b - b.s), c: colOf(b.b - b.s) }, { split: [b.b, b.s] },
        { k: 'Bars since', v: String(V.bars.length - 1 - i) },
      ], { accent: g.color });
    } },
  { id: 'crossline', label: 'Cross line', group: 'Lines', icon: 'crossline', n: 1,
    render(g, d, V, s) { const [x, y] = P(V, d.pts[0]); g.line(x, 0, x, V.mainH); g.line(0, y, V.plotW, y); solidPill(g, V.plotW - 4, y, V.fmt(d.pts[0].p), '#3a3a42', { align: 'right' }); if (s.hover || s.sel) solidPill(g, x, V.mainH - 4, when(d.pts[0].t), '#3a3a42', { align: 'center', base: 'bottom' }); } },
  { id: 'channel', label: 'Parallel channel', group: 'Lines', icon: 'channel', n: 3, fill: true,
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2);
      if (d.pts.length < 3) return;
      const [x3, y3] = P(V, d.pts[2]);
      const slope = (y2 - y1) / ((x2 - x1) || 1e-9), off = y3 - (y1 + slope * (x3 - x1));
      if (d.fill) g.poly([[x1, y1], [x2, y2], [x2, y2 + off], [x1, y1 + off]], { close: true, fill: fade(g.color, 0.08), width: 0 });
      g.line(x1, y1 + off, x2, y2 + off);
      g.line(x1, y1 + off / 2, x2, y2 + off / 2, { dash: [4, 4], width: 1, color: fade(g.color, 0.6) });
      for (const k of [0.25, 0.75]) g.line(x1, y1 + off * k, x2, y2 + off * k, { dash: [1, 4], width: 1, color: fade(g.color, 0.35) });
      if (!s.sel && !s.hover) return;
      const a = d.pts[0], b = d.pts[1], dpOff = V.p(y1 + off) - V.p(y1);
      const lineAt = (t: number) => a.p + ((b.p - a.p) * (t - a.t)) / ((b.t - a.t) || 1);
      const lt = V.bars[V.bars.length - 1]?.t ?? b.t, L = lastPx(V), base = lineAt(lt), pos = dpOff ? ((L - base) / dpOff) * 100 : 0;
      pill(g, x2 + 6, y2 + off / 2, `width ${V.fmt(Math.abs(dpOff))} (${Math.abs((dpOff / a.p) * 100).toFixed(2)}%)`, g.color);
      if (!s.sel) return;
      const i0 = Math.max(0, barIndexFrom(V.bars, Math.min(a.t, b.t))), i1 = V.bars.length - 1;
      const T1 = touches(V, i0, i1, i => lineAt(V.bars[i].t)), T2 = touches(V, i0, i1, i => lineAt(V.bars[i].t) + dpOff);
      for (const [tx, ty] of [...T1.pts, ...T2.pts]) g.dot(tx, ty, 3.5, fade(g.color, 0.9), '#111');
      const st = rangeStats(V, Math.min(a.t, b.t), lt);
      g.card(x2, Math.min(y2, y2 + off), 'Parallel channel', [
        { k: 'Width', v: `${V.fmt(Math.abs(dpOff))}  ${Math.abs((dpOff / a.p) * 100).toFixed(2)}%` },
        { k: 'Slope / bar', v: `${sgn(b.p - a.p)}${V.fmt(Math.abs(b.p - a.p) / Math.max(1, barIndexAt(V.bars, b.t) - barIndexAt(V.bars, a.t)))}`, c: colOf(b.p - a.p) },
        { k: 'Price position', v: `${pos.toFixed(0)}% of channel`, c: pos > 80 || pos < 20 ? GOLD : undefined },
        { k: 'Touches', v: `${T1.n} base · ${T2.n} opposite` },
        ...(st ? [{ sep: true } as Row, ...flowRows(st)] : []),
      ], { accent: g.color });
    } },
  { id: 'regression', label: 'Regression channel', group: 'Lines', icon: 'regression', n: 2,
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts[0].t <= d.pts[1].t ? [d.pts[0], d.pts[1]] : [d.pts[1], d.pts[0]];
      const i0 = Math.max(0, barIndexFrom(V.bars, a.t)), i1 = barIndexAt(V.bars, b.t);
      if (i1 - i0 < 2) { g.line(V.x(a.t), V.y(a.p), V.x(b.t), V.y(b.p), { dash: [4, 4] }); return; }
      let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0; const n = i1 - i0 + 1;
      for (let i = i0; i <= i1; i++) { const x = i - i0, y = V.bars[i].c; sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y; }
      const m = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1), c = (sy - m * sx) / n;
      const r2den = (n * sxx - sx * sx) * (n * syy - sy * sy), r2 = r2den > 0 ? ((n * sxy - sx * sy) ** 2) / r2den : 0;
      let sd = 0; for (let i = i0; i <= i1; i++) sd += (V.bars[i].c - (m * (i - i0) + c)) ** 2; sd = Math.sqrt(sd / n);
      const xa = V.x(V.bars[i0].t), xb = V.x(V.bars[i1].t), ya = c, yb = m * (n - 1) + c;
      g.poly([[xa, V.y(ya + 2 * sd)], [xb, V.y(yb + 2 * sd)], [xb, V.y(yb - 2 * sd)], [xa, V.y(ya - 2 * sd)]], { close: true, fill: fade(g.color, 0.06), width: 0 });
      g.line(xa, V.y(ya), xb, V.y(yb));
      for (const k of [1, -1]) g.line(xa, V.y(ya + k * sd), xb, V.y(yb + k * sd), { dash: [2, 4], width: 1, color: fade(g.color, 0.5) });
      for (const k of [2, -2]) g.line(xa, V.y(ya + k * sd), xb, V.y(yb + k * sd), { dash: [5, 4], width: 1 });
      if (!s.sel && !s.hover) return;
      const L = V.bars[i1].c, z = sd ? (L - yb) / sd : 0;
      pill(g, xb + 6, V.y(yb), `R² ${r2.toFixed(2)} · ${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`, g.color);
      if (!s.sel) return;
      const st = rangeStats(V, a.t, b.t);
      g.card(xb, V.y(yb + 2 * sd), 'Regression channel', [
        { k: 'Slope / bar', v: `${sgn(m)}${V.fmt(Math.abs(m))}`, c: colOf(m) }, { k: 'R² (trend quality)', v: r2.toFixed(3), c: r2 > 0.7 ? UP : r2 < 0.3 ? MUTED : undefined },
        { k: 'Std. deviation', v: V.fmt(sd) }, { k: 'Last close', v: `${z >= 0 ? '+' : ''}${z.toFixed(2)}σ from mean`, c: Math.abs(z) > 1.8 ? GOLD : undefined },
        { k: 'Bars', v: String(n) },
        ...(st ? [{ sep: true } as Row, ...flowRows(st), ...flowNotes(st)] : []),
      ], { accent: g.color });
    } },

  /* ---------------- fibonacci ---------------- */
  { id: 'fib', label: 'Fib retracement', group: 'Fibonacci', icon: 'fib', n: 2, color: '#9a9a9a', key: 'Alt+F',
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const [p1, p2] = d.pts, xl = Math.min(V.x(p1.t), V.x(p2.t)), xr = Math.max(V.x(p1.t), V.x(p2.t), xl + 140);
      const xe = s.sel || s.hover ? V.plotW : xr, L = lastPx(V), up = p2.p > p1.p;
      const prOf = (lv: number) => p2.p + (p1.p - p2.p) * lv;
      g.line(V.x(p1.t), V.y(p1.p), V.x(p2.t), V.y(p2.p), { dash: [3, 3], width: 1, color: fade('#9a9a9a', 0.8) });
      // golden pocket
      g.rect(xl, V.y(prOf(0.618)), xe - xl, V.y(prOf(0.65)) - V.y(prOf(0.618)), { fill: fade(GOLD, 0.16), stroke: false, hitFill: true });
      let near = -1, nd = Infinity; FIB.forEach((lv, i) => { const dd = Math.abs(prOf(lv) - L); if (dd < nd) { nd = dd; near = i; } });
      const iA = Math.max(0, barIndexFrom(V.bars, Math.max(p1.t, p2.t))), iL = V.bars.length - 1;
      let prev: number | null = null;
      FIB.forEach((lv, idx) => {
        const pr = prOf(lv), y = V.y(pr), col = fibCol(lv, g.color), isNear = idx === near;
        if (prev != null && lv !== 0.65) g.rect(xl, prev, xe - xl, y - prev, { fill: fade(col, 0.05), stroke: false });
        if (lv === 0.65) { g.line(xl, y, xe, y, { color: fade(col, 0.5), width: 1, dash: [3, 3] }); return; }
        g.line(xl, y, xe, y, { color: col, width: isNear ? 2.2 : 1.2 });
        g.label(xl - 4, y, `${lv}  ${V.fmt(pr)}`, { color: col, align: 'right', size: 11, bold: isNear });
        if (s.sel) {
          const tested = touches(V, iA + 1, iL, () => pr, 3).n, va = volAt(V, iA, iL, pr);
          const txt = `${tested ? `✓ tested ${tested}` : 'untested'}${va.v ? ` · vol ${fmtQ(va.v)} · Δ ${fq(va.d)}` : ''}`;
          pill(g, xe - 4, y - 9, txt, tested ? col : MUTED, { align: 'right', size: 10 });
        }
        if (isNear && isFinite(L)) solidPill(g, xr + 6, y, '◀ price here', fade(col, 0.9), { size: 10 });
        prev = y;
      });
      g.label(xl + 4, V.y(prOf(0.635)), 'golden pocket', { color: GOLD, size: 9.5 });
      if (s.sel || s.hover) for (const lv of FIB_X) { const pr = p2.p + (p2.p - p1.p) * (lv - 1), y = V.y(pr), col = fibCol(lv, g.color); g.line(xl, y, xe, y, { color: fade(col, 0.6), width: 1, dash: [6, 4] }); g.label(xl - 4, y, `${lv}  ${V.fmt(pr)}`, { color: col, align: 'right', size: 10.5 }); }
      if (!s.sel) return;
      const st = rangeStats(V, p1.t, p2.t), sw = p2.p - p1.p, retr = sw ? ((p2.p - L) / sw) * 100 : 0;
      g.card(xr, Math.min(V.y(p1.p), V.y(p2.p)), `Fib retracement · ${up ? 'up' : 'down'} swing`, [
        { k: 'Swing', v: `${sgn(sw)}${V.fmt(Math.abs(sw))}  ${pctS(sw, p1.p)}`, c: colOf(sw) },
        { k: 'Bars · time', v: `${st?.n ?? 0} · ${dur(p2.t - p1.t)}` },
        { k: 'Current retracement', v: isFinite(L) ? `${retr.toFixed(1)}%` : '—', c: retr >= 61.8 && retr <= 65 ? GOLD : undefined },
        { k: 'Nearest level', v: near >= 0 ? `${FIB[near]} (${V.fmt(prOf(FIB[near]))})` : '—' },
        ...(st ? [{ sep: true } as Row, { note: 'Order flow of the swing', c: MUTED } as Row, ...flowRows(st), ...flowNotes(st)] : []),
      ], { accent: '#e6c84a' });
    } },
  { id: 'fibext', label: 'Trend-based fib extension', group: 'Fibonacci', icon: 'fibext', n: 3, color: '#9a9a9a',
    render(g, d, V, s) {
      const [a, b, c] = d.pts; if (!b) return;
      g.line(V.x(a.t), V.y(a.p), V.x(b.t), V.y(b.p), { dash: [3, 3], width: 1 });
      if (!c) return;
      g.line(V.x(b.t), V.y(b.p), V.x(c.t), V.y(c.p), { dash: [3, 3], width: 1 });
      const xl = V.x(c.t), xr = s.sel || s.hover ? V.plotW : Math.max(xl + 140, V.x(c.t) + Math.abs(V.x(b.t) - V.x(a.t)));
      const iC = Math.max(0, barIndexFrom(V.bars, c.t)), rows: Row[] = [];
      for (const lv of FIB_EXT) {
        const pr = c.p + (b.p - a.p) * lv, y = V.y(pr), col = fibCol(lv, g.color);
        let hitI = -1; for (let i = iC + 1; i < V.bars.length; i++) if (V.bars[i].l <= pr && V.bars[i].h >= pr) { hitI = i; break; }
        g.line(xl, y, xr, y, { color: col, width: hitI >= 0 ? 1.6 : 1, dash: hitI >= 0 ? [] : [5, 4] });
        g.label(xl - 4, y, `${lv}  ${V.fmt(pr)}${hitI >= 0 ? '  ✓' : ''}`, { color: col, align: 'right', size: 11 });
        if (hitI >= 0) g.dot(V.x(V.bars[hitI].t), y, 4, col, '#111');
        rows.push({ k: `${lv} → ${V.fmt(pr)}`, v: hitI >= 0 ? `✓ hit after ${hitI - iC} bars` : 'not reached', c: hitI >= 0 ? UP : MUTED });
      }
      if (s.sel) g.card(xr - 10, V.y(c.p), 'Fib extension targets', rows, { accent: g.color, side: 'left' });
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
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const unit = d.pts[1].t - d.pts[0].t; if (!unit) return;
      const now = V.bars[V.bars.length - 1]?.t ?? 0;
      for (const k of [0, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89]) {
        const t = d.pts[0].t + unit * k, x = V.x(t); if (x > V.plotW + 50) break;
        const future = t > now;
        g.line(x, 0, x, V.mainH, { width: 1, dash: future ? [4, 4] : [] });
        g.label(x + 3, V.mainH - 12, String(k), { color: g.color, bold: true });
        if (s.sel || s.hover) g.label(x + 3, V.mainH - 28, future ? `in ${dur(t - now)}` : when(t), { color: MUTED, size: 9.5 });
      }
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
      for (const lv of [0.382, 0.618, 1, 1.618, 2.618]) g.ellipse(x1, y1, r * lv, r * lv, { color: fibCol(lv, '#9a9a9a') });
    } },
  { id: 'fibarc', label: 'Fib speed arcs', group: 'Fibonacci', icon: 'fibarc', n: 2, color: '#9a9a9a',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), r = Math.hypot(x2 - x1, y2 - y1), up = y1 > y2;
      g.line(x1, y1, x2, y2, { dash: [3, 3], width: 1 });
      for (const lv of [0.382, 0.5, 0.618, 1]) g.ellipse(x2, y2, r * lv, r * lv, up ? { a0: 0, a1: Math.PI, color: fibCol(lv, '#9a9a9a') } : { a0: Math.PI, a1: Math.PI * 2, color: fibCol(lv, '#9a9a9a') });
    } },

  /* ---------------- gann & pitchfork ---------------- */
  ...(['pitchfork', 'schiff'] as const).map((kind): ToolDef => ({
    id: kind, label: kind === 'pitchfork' ? 'Pitchfork' : 'Schiff pitchfork', group: 'Gann & Pitchfork', icon: 'pitchfork', n: 3, color: '#ffb020',
    render(g, d, V, s) {
      const [a, b, c] = d.pts; if (!b) return;
      let [ax, ay] = P(V, a); const [bx, by] = P(V, b);
      if (!c) { g.line(ax, ay, bx, by, { dash: [3, 3] }); return; }
      const [cx, cy] = P(V, c);
      if (kind === 'schiff') { ax = (ax + bx) / 2; ay = (ay + by) / 2; }
      const mx = (bx + cx) / 2, my = (by + cy) / 2;
      g.line(bx, by, cx, cy, { dash: [3, 3], width: 1 });
      const e = extend(V, ax, ay, mx, my, true);
      const f1 = extend(V, bx, by, bx + (mx - ax), by + (my - ay), true), f2 = extend(V, cx, cy, cx + (mx - ax), cy + (my - ay), true);
      g.poly([[f1[0], f1[1]], [f1[2], f1[3]], [f2[2], f2[3]], [f2[0], f2[1]]], { close: true, fill: fade(g.color, 0.05), width: 0 });
      g.line(e[0], e[1], e[2], e[3], { width: 1.8 }); g.line(f1[0], f1[1], f1[2], f1[3]); g.line(f2[0], f2[1], f2[2], f2[3]);
      if (s.sel || s.hover) pill(g, e[2] - 4, e[3] - 10, 'median line — price tends to return here', g.color, { align: 'right', size: 10 });
    },
  })),
  { id: 'gannfan', label: 'Gann fan', group: 'Gann & Pitchfork', icon: 'gannfan', n: 2, color: '#4da3ff',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), dx = x2 - x1, dy = y2 - y1;
      for (const [r, lab] of [[1, '1x1'], [2, '1x2'], [0.5, '2x1'], [3, '1x3'], [1 / 3, '3x1'], [4, '1x4'], [0.25, '4x1'], [8, '1x8'], [0.125, '8x1']] as [number, string][]) {
        const e = extend(V, x1, y1, x1 + dx, y1 + dy / r, true); g.line(e[0], e[1], e[2], e[3], { width: r === 1 ? 1.8 : 1, color: r === 1 ? '#ffb020' : g.color }); g.label(x1 + dx + 4, y1 + dy / r, lab, { color: r === 1 ? '#ffb020' : g.color, size: 10 });
      }
    } },
  { id: 'gannbox', label: 'Gann box', group: 'Gann & Pitchfork', icon: 'gannbox', n: 2, color: '#ffb020',
    render(g, d, V) {
      if (d.pts.length < 2) return;
      const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]), w = x2 - x1, h = y2 - y1;
      g.rect(x1, y1, w, h, { fill: fade(g.color, 0.05) });
      for (const k of [0.25, 0.382, 0.5, 0.618, 0.75]) { g.line(x1 + w * k, y1, x1 + w * k, y2, { width: 1, dash: [3, 3] }); g.line(x1, y1 + h * k, x2, y1 + h * k, { width: 1, dash: [3, 3] }); g.label(x2 + 3, y1 + h * k, String(k), { color: MUTED, size: 9.5 }); }
      g.line(x1, y1, x2, y2, { width: 1 }); g.line(x1, y2, x2, y1, { width: 1 });
    } },

  /* ---------------- shapes ---------------- */
  { id: 'rect', label: 'Rectangle', group: 'Shapes', icon: 'rect', n: 2, color: '#62b156', fill: true, text: '', key: 'Alt+R',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, [x1, y1] = P(V, a), [x2, y2] = P(V, b);
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: d.fill ? fade(g.color, 0.14) : undefined, hitFill: true });
      if (d.text) g.label(Math.min(x1, x2) + 6, Math.min(y1, y2) + 4, d.text, { color: g.color, base: 'top', bold: true });
      if (!s.sel && !s.hover) return;
      const hi = Math.max(a.p, b.p), lo = Math.min(a.p, b.p);
      pill(g, Math.max(x1, x2), Math.min(y1, y2) - 10, `${V.fmt(hi - lo)} · ${((hi - lo) / lo * 100).toFixed(2)}%`, g.color, { align: 'right' });
      if (!s.sel) return;
      const st = rangeStats(V, a.t, b.t, lo, hi); if (!st) return;
      g.card(Math.max(x1, x2), Math.min(y1, y2), 'Zone', [
        { k: 'Top · bottom', v: `${V.fmt(hi)} · ${V.fmt(lo)}` }, { k: 'Height', v: `${V.fmt(hi - lo)} · ${Math.round((hi - lo) / V.tick)} ticks` },
        { k: 'Bars · time', v: `${st.n} · ${dur(st.ms)}` }, { sep: true }, { note: 'Order flow inside the box', c: MUTED }, ...flowRows(st), ...flowNotes(st),
      ], { accent: g.color });
    } },
  { id: 'ellipse', label: 'Ellipse', group: 'Shapes', icon: 'ellipse', n: 2, color: '#4da3ff', fill: true,
    render(g, d, V) { if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]); g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, (x2 - x1) / 2, (y2 - y1) / 2, { fill: d.fill ? fade(g.color, 0.15) : undefined }); } },
  { id: 'triangle', label: 'Triangle', group: 'Shapes', icon: 'triangle', n: 3, color: '#ffb020', fill: true,
    render(g, d, V) { const pts = d.pts.map(p => P(V, p)); g.poly(pts, { close: pts.length === 3, fill: d.fill && pts.length === 3 ? fade(g.color, 0.15) : undefined }); } },
  { id: 'path', label: 'Path (double-click to finish)', group: 'Shapes', icon: 'path', n: -1,
    render(g, d, V) { const pts = d.pts.map(p => P(V, p)); g.poly(pts); for (const [x, y] of pts) g.dot(x, y, 2.5, g.color); } },
  { id: 'brush', label: 'Brush', group: 'Shapes', icon: 'brush', n: 0, color: '#ff3df5',
    render(g, d, V) { g.poly(d.pts.map(p => P(V, p))); } },
  { id: 'highlighter', label: 'Highlighter', group: 'Shapes', icon: 'highlighter', n: 0, color: '#ffd23f', width: 12,
    render(g, d, V) { g.poly(d.pts.map(p => P(V, p)), { alpha: 0.35 }); } },
  { id: 'arrow', label: 'Arrow', group: 'Shapes', icon: 'arrow', n: 2, text: '',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [x1, y1] = P(V, d.pts[0]), [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2); const a = Math.atan2(y2 - y1, x2 - x1), L = 12 + g.width * 2;
      g.poly([[x2 - L * Math.cos(a - 0.45), y2 - L * Math.sin(a - 0.45)], [x2, y2], [x2 - L * Math.cos(a + 0.45), y2 - L * Math.sin(a + 0.45)]], { close: true, fill: g.color });
      if (d.text) g.label(x1, y1 + (y2 > y1 ? -6 : 6), d.text, { color: g.color, align: 'center', base: y2 > y1 ? 'bottom' : 'top', bold: true });
      if (s.hover || s.sel) { const dp = d.pts[1].p - d.pts[0].p; pill(g, (x1 + x2) / 2 + 8, (y1 + y2) / 2, `${sgn(dp)}${V.fmt(Math.abs(dp))} (${pctS(dp, d.pts[0].p)})`, colOf(dp)); }
    } },

  /* ---------------- positions ---------------- */
  ...([1, -1] as const).map((dir): ToolDef => ({
    id: dir > 0 ? 'long' : 'short', label: dir > 0 ? 'Long position' : 'Short position', group: 'Positions', icon: dir > 0 ? 'long' : 'short', n: 1, key: dir > 0 ? 'Alt+L' : 'Alt+S',
    init(d, V) {
      const e = d.pts[0], span = Math.max(V.tick * 20, Math.abs(V.p(0) - V.p(V.mainH)) * 0.05);
      const end = V.t(V.x(e.t) + 220);
      d.pts = [e, { t: end, p: e.p + dir * span * 2 }, { t: end, p: e.p - dir * span }];
    },
    moveHandle(d, i, pt) { if (i === 0) d.pts[0] = pt; else { d.pts[i] = pt; d.pts[i === 1 ? 2 : 1].t = pt.t; } },
    render(g, d, V, s) {
      if (d.pts.length < 3) return;
      const [e, tp, sl] = d.pts, x0 = V.x(e.t), x1 = Math.max(V.x(tp.t), x0 + 30), ye = V.y(e.p), yt = V.y(tp.p), ys = V.y(sl.p), w = x1 - x0;
      const risk = Math.abs(e.p - sl.p) || 1e-12, reward = Math.abs(tp.p - e.p), rrv = reward / risk;
      const qty = (V.acct.size * V.acct.risk / 100) / risk, riskUsd = risk * qty, rewUsd = reward * qty;
      const ev = evalPosition(V, d, dir);
      const done = ev.status === 'target' || ev.status === 'stopped' || ev.status === 'expired';
      // zones
      g.rect(x0, Math.min(ye, yt), w, Math.abs(yt - ye), { fill: `rgba(1,212,3,${done && ev.status !== 'target' ? 0.08 : 0.16})`, stroke: false, hitFill: true });
      g.rect(x0, Math.min(ye, ys), w, Math.abs(ys - ye), { fill: `rgba(138,69,180,${done && ev.status !== 'stopped' ? 0.1 : 0.22})`, stroke: false, hitFill: true });
      // R-multiple grid inside the target zone
      for (let k = 1; k * risk < reward - risk * 0.1 && k <= 10; k++) { const yk = V.y(e.p + dir * k * risk); g.line(x0, yk, x1, yk, { color: 'rgba(66,218,69,0.25)', width: 1, dash: [2, 4] }); g.label(x1 - 4, yk, `${k}R`, { color: 'rgba(66,218,69,0.7)', size: 9.5, align: 'right' }); }
      // live / realised P&L fill
      const curP = ev.status === 'active' ? lastPx(V) : ev.exitP;
      if (ev.entered && isFinite(curP)) {
        const yc = V.y(curP), xEnd = ev.exitI >= 0 ? V.x(V.bars[ev.exitI].t) : Math.min(x1, V.x(V.bars[V.bars.length - 1].t));
        g.rect(x0, Math.min(ye, yc), Math.max(2, xEnd - x0), Math.abs(yc - ye), { fill: ev.pnl >= 0 ? 'rgba(1,212,3,0.22)' : 'rgba(138,69,180,0.3)', stroke: false });
        g.line(x0, ye, xEnd, yc, { color: ev.pnl >= 0 ? UP : DN, width: 1.2, dash: [4, 3] });
        if (ev.exitI >= 0) g.dot(xEnd, yc, 4.5, ev.status === 'target' ? UP : ev.status === 'stopped' ? DN : MUTED, '#fff');
      }
      g.line(x0, yt, x1, yt, { color: UP, width: 1.2 }); g.line(x0, ys, x1, ys, { color: DN, width: 1.2 }); g.line(x0, ye, x1, ye, { color: '#e0e0e0', width: 1.4 });
      // labels
      const mid = x0 + w / 2;
      solidPill(g, mid, yt + (dir > 0 ? -3 : 3), `Target ${V.fmt(tp.p)} · ${pctS(dir * reward, e.p)} · +$${rewUsd.toFixed(0)}`, '#0e5b0d', { align: 'center', base: dir > 0 ? 'bottom' : 'top' });
      solidPill(g, mid, ys + (dir > 0 ? 3 : -3), `Stop ${V.fmt(sl.p)} · ${pctS(-dir * risk, e.p)} · −$${riskUsd.toFixed(0)}`, '#4a1f6f', { align: 'center', base: dir > 0 ? 'top' : 'bottom' });
      solidPill(g, mid, ye, `${dir > 0 ? 'LONG' : 'SHORT'} ${V.fmt(e.p)} · R:R ${rrv.toFixed(2)}`, '#2c2c32', { align: 'center' });
      const badge = ev.status === 'active' ? [`● LIVE ${ev.pnl >= 0 ? '+' : '−'}$${Math.abs(ev.pnl * qty).toFixed(0)} (${ev.rNow >= 0 ? '+' : ''}${ev.rNow.toFixed(2)}R)`, ev.pnl >= 0 ? '#0e5b0d' : '#4a1f6f']
        : ev.status === 'target' ? [`✓ TARGET +$${rewUsd.toFixed(0)} in ${ev.exitI - ev.i0} bars`, '#0e5b0d']
        : ev.status === 'stopped' ? [`✕ STOPPED −$${riskUsd.toFixed(0)} in ${ev.exitI - ev.i0} bars`, '#4a1f6f']
        : ev.status === 'expired' ? [`◷ CLOSED ${ev.pnl >= 0 ? '+' : '−'}$${Math.abs(ev.pnl * qty).toFixed(0)} (${ev.rNow.toFixed(2)}R)`, '#3a3a42'] : ['◌ WAITING FOR ENTRY', '#3a3a42'];
      solidPill(g, x0, Math.min(yt, ys) - 4, badge[0], badge[1], { base: 'bottom', size: 10.5 });
      if (!s.sel) return;
      const st = ev.entered ? rangeStats(V, e.t, ev.exitI >= 0 ? V.bars[ev.exitI].t : V.bars[V.bars.length - 1].t) : null;
      g.card(x1, Math.min(yt, ys), `${dir > 0 ? 'Long' : 'Short'} position`, [
        { k: 'Entry', v: V.fmt(e.p) }, { k: 'Target', v: `${V.fmt(tp.p)}  (${Math.round(reward / V.tick)} t)`, c: UP }, { k: 'Stop', v: `${V.fmt(sl.p)}  (${Math.round(risk / V.tick)} t)`, c: DN },
        { k: 'Risk : reward', v: `1 : ${rrv.toFixed(2)}`, c: rrv >= 2 ? UP : rrv < 1 ? DN : undefined },
        { k: 'Break-even win rate', v: `${(100 / (1 + rrv)).toFixed(0)}%` },
        { sep: true },
        { k: `Qty (${V.acct.risk}% of $${fmtQ(V.acct.size)})`, v: qty >= 10 ? qty.toFixed(1) : qty.toPrecision(3) },
        { k: 'Risk $ · reward $', v: `−$${riskUsd.toFixed(0)} · +$${rewUsd.toFixed(0)}` },
        { k: 'Position value', v: `$${fmtQ(qty * e.p)}` },
        { sep: true },
        { k: 'Status', v: ev.status.toUpperCase(), c: ev.status === 'target' ? UP : ev.status === 'stopped' ? DN : ev.status === 'active' ? GOLD : MUTED },
        ...(ev.entered ? [
          { k: 'P&L', v: `${ev.pnl >= 0 ? '+' : '−'}$${Math.abs(ev.pnl * qty).toFixed(2)}  (${ev.rNow >= 0 ? '+' : ''}${ev.rNow.toFixed(2)}R)`, c: colOf(ev.pnl) } as Row,
          { k: 'Max favourable / adverse', v: `+${ev.mfeR.toFixed(2)}R / −${ev.maeR.toFixed(2)}R` } as Row,
        ] : []),
        ...(st ? [{ sep: true } as Row, { note: 'Order flow during the trade', c: MUTED } as Row, ...flowRows(st, true)] : []),
      ], { accent: dir > 0 ? UP : DN });
    },
  })),

  /* ---------------- measure ---------------- */
  { id: 'pricerange', label: 'Price range', group: 'Measure', icon: 'pricerange', n: 2, color: '#4da3ff',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), xm = (x1 + x2) / 2, dp = b.p - a.p;
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(g.color, 0.12), stroke: false, hitFill: true });
      g.line(x1, y1, x2, y1, { width: 1 }); g.line(x1, y2, x2, y2, { width: 1 }); g.line(xm, y1, xm, y2);
      g.poly([[xm - 5, y2 + (dp >= 0 ? 7 : -7)], [xm, y2], [xm + 5, y2 + (dp >= 0 ? 7 : -7)]]);
      const st = rangeStats(V, a.t, b.t), atr = st?.avgRng ? Math.abs(dp) / st.avgRng : 0;
      solidPill(g, xm, y2 + (dp >= 0 ? -6 : 6), `${sgn(dp)}${V.fmt(Math.abs(dp))} (${pctS(dp, a.p)}) · ${Math.round(Math.abs(dp) / V.tick)} ticks${atr ? ` · ${atr.toFixed(1)}× bar range` : ''}`, fade(g.color, 0.95), { align: 'center', base: dp >= 0 ? 'bottom' : 'top' });
      if (!s.sel) return;
      const lo = Math.min(a.p, b.p), hi = Math.max(a.p, b.p), sb = rangeStats(V, Math.min(a.t, b.t) - 1e12, Math.max(a.t, b.t), lo, hi);
      if (sb) g.card(Math.max(x1, x2), Math.min(y1, y2), 'Price range', [
        { k: 'Range', v: `${V.fmt(lo)} – ${V.fmt(hi)}` }, { k: 'Size', v: `${V.fmt(hi - lo)} · ${pctS(hi - lo, lo)}` },
        { sep: true }, { note: 'All volume ever traded inside this band', c: MUTED }, ...flowRows(sb, false),
      ], { accent: g.color });
    } },
  { id: 'daterange', label: 'Date range', group: 'Measure', icon: 'daterange', n: 2, color: '#4da3ff',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), ym = (y1 + y2) / 2;
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(g.color, 0.12), stroke: false, hitFill: true });
      g.line(x1, y1, x1, y2, { width: 1 }); g.line(x2, y1, x2, y2, { width: 1 }); g.line(x1, ym, x2, ym);
      const st = rangeStats(V, a.t, b.t); if (!st) return;
      solidPill(g, (x1 + x2) / 2, Math.max(y1, y2) + 5, `${st.n} bars · ${dur(b.t - a.t)} · vol ${fmtQ(st.vol)} · Δ ${fq(st.delta)}`, fade(g.color, 0.95), { align: 'center', base: 'top' });
      if (s.sel) g.card(Math.max(x1, x2), Math.min(y1, y2), 'Date range', [
        { k: 'From', v: when(Math.min(a.t, b.t)) }, { k: 'To', v: when(Math.max(a.t, b.t)) }, { k: 'High – low', v: `${V.fmt(st.lo)} – ${V.fmt(st.hi)}` },
        { k: 'Net move', v: `${sgn(st.c - st.o)}${V.fmt(Math.abs(st.c - st.o))} (${pctS(st.c - st.o, st.o)})`, c: colOf(st.c - st.o) },
        { k: 'VWAP', v: isFinite(st.vwap) ? V.fmt(st.vwap) : '—' },
        { sep: true }, ...flowRows(st), ...flowNotes(st),
      ], { accent: g.color });
    } },
  { id: 'dprange', label: 'Date & price range', group: 'Measure', icon: 'dprange', n: 2, color: '#4da3ff',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, x1 = V.x(a.t), x2 = V.x(b.t), y1 = V.y(a.p), y2 = V.y(b.p), dp = b.p - a.p, up = dp >= 0;
      const col = up ? '#01d403' : '#8a45b4';
      g.rect(x1, y1, x2 - x1, y2 - y1, { fill: fade(col, 0.15), stroke: false, hitFill: true });
      g.line(x1, y1, x2, y2, { color: col, dash: [4, 3] });
      const st = rangeStats(V, a.t, b.t);
      solidPill(g, (x1 + x2) / 2, y2 + (up ? -6 : 6), `${sgn(dp)}${V.fmt(Math.abs(dp))} (${pctS(dp, a.p)}) · ${Math.round(Math.abs(dp) / V.tick)}t · ${st?.n ?? 0} bars · ${dur(b.t - a.t)}`, up ? '#0e5b0d' : '#4a1f6f', { align: 'center', base: up ? 'bottom' : 'top' });
      if (st) solidPill(g, (x1 + x2) / 2, y1 + (up ? 6 : -6), `vol ${fmtQ(st.vol)} · Δ ${fq(st.delta)} · buy ${st.vol ? Math.round((st.buy / st.vol) * 100) : 0}%`, '#2c2c32', { align: 'center', base: up ? 'top' : 'bottom', size: 10.5 });
      if (s.sel && st) g.card(Math.max(x1, x2), Math.min(y1, y2), 'Date & price range', [
        { k: 'Move', v: `${sgn(dp)}${V.fmt(Math.abs(dp))}  ${pctS(dp, a.p)}`, c: colOf(dp) }, { k: 'Bars · time', v: `${st.n} · ${dur(b.t - a.t)}` },
        { k: 'Speed', v: `${V.fmt(Math.abs(dp) / Math.max(1, st.n))} / bar` },
        { sep: true }, ...flowRows(st), ...flowNotes(st),
      ], { accent: col });
    } },

  /* ---------------- text & marks ---------------- */
  { id: 'text', label: 'Text', group: 'Text & Marks', icon: 'text', n: 1, text: 'Text',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.label(x, y, d.text || 'Text', d.fill ? { bg: fade(g.color, 0.2), border: g.color, color: g.color, size: 12 + d.width * 2, base: 'bottom' } : { color: g.color, size: 12 + d.width * 2, base: 'bottom', bold: true }); } },
  { id: 'callout', label: 'Callout', group: 'Text & Marks', icon: 'callout', n: 2, text: 'Note', color: '#ffb020',
    render(g, d, V) {
      const [x1, y1] = P(V, d.pts[0]); g.dot(x1, y1, 3.5, g.color, '#111'); if (d.pts.length < 2) return; const [x2, y2] = P(V, d.pts[1]);
      g.line(x1, y1, x2, y2, { width: 1.2 }); g.label(x2, y2, d.text || 'Note', { bg: g.color, color: '#111', align: 'center', size: 12.5, bold: true });
    } },
  { id: 'pricelabel', label: 'Price label', group: 'Text & Marks', icon: 'pricelabel', n: 1, color: '#4da3ff',
    render(g, d, V, s) {
      const [x, y] = P(V, d.pts[0]), L = lastPx(V);
      g.poly([[x, y], [x + 8, y - 10], [x + 8, y + 10]], { close: true, fill: g.color, width: 0 }); solidPill(g, x + 8, y, V.fmt(d.pts[0].p), g.color);
      if ((s.hover || s.sel) && isFinite(L)) pill(g, x + 8, y + 18, `${pctS(L - d.pts[0].p, d.pts[0].p)} since · ${when(d.pts[0].t)}`, MUTED, { size: 10 });
    } },
  { id: 'arrowup', label: 'Arrow mark up', group: 'Text & Marks', icon: 'arrowup', n: 1, color: '#42da45', text: '',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.poly([[x, y], [x + 8, y + 10], [x + 3, y + 10], [x + 3, y + 22], [x - 3, y + 22], [x - 3, y + 10], [x - 8, y + 10]], { close: true, fill: g.color }); if (d.text) g.label(x, y + 26, d.text, { color: g.color, align: 'center', base: 'top', bold: true }); } },
  { id: 'arrowdown', label: 'Arrow mark down', group: 'Text & Marks', icon: 'arrowdown', n: 1, color: '#b27ae6', text: '',
    render(g, d, V) { const [x, y] = P(V, d.pts[0]); g.poly([[x, y], [x + 8, y - 10], [x + 3, y - 10], [x + 3, y - 22], [x - 3, y - 22], [x - 3, y - 10], [x - 8, y - 10]], { close: true, fill: g.color }); if (d.text) g.label(x, y - 26, d.text, { color: g.color, align: 'center', base: 'bottom', bold: true }); } },

  /* ---------------- order flow ---------------- */
  { id: 'ofrange', label: 'Order-flow range (delta / CVD meter)', group: 'Order Flow', icon: 'bars', n: 2, color: '#00e5ff',
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const [a, b] = d.pts, x1 = Math.min(V.x(a.t), V.x(b.t)), x2 = Math.max(V.x(a.t), V.x(b.t));
      const st = rangeStats(V, a.t, b.t);
      const top = st ? V.y(st.hi) - 6 : Math.min(V.y(a.p), V.y(b.p)), bot = st ? V.y(st.lo) + 6 : Math.max(V.y(a.p), V.y(b.p));
      g.rect(x1, top, x2 - x1, bot - top, { fill: fade(g.color, 0.06), stroke: fade(g.color, 0.7), dash: [4, 3], hitFill: true });
      if (!st) return;
      // buy/sell bar along the top edge + delta badge
      const w = x2 - x1, wb = st.vol ? w * (st.buy / st.vol) : w / 2;
      g.rect(x1, top - 6, wb, 4, { fill: 'rgba(1,212,3,0.9)', stroke: false }); g.rect(x1 + wb, top - 6, w - wb, 4, { fill: 'rgba(138,69,180,0.9)', stroke: false });
      solidPill(g, x1, top - 9, `Δ ${fq(st.delta)} · vol ${fmtQ(st.vol)} · ${st.n} bars`, st.delta >= 0 ? '#0e5b0d' : '#4a1f6f', { base: 'bottom' });
      // CVD path drawn inside the box
      if (st.cvd.length > 1) {
        const mn = Math.min(0, ...st.cvd), mx = Math.max(0, ...st.cvd), sp = mx - mn || 1, pts: XY[] = [];
        st.cvd.forEach((v, i) => pts.push([V.x(V.bars[st.i0 + i].t), bot - 4 - ((v - mn) / sp) * (bot - top - 8) * 0.45]));
        g.poly(pts, { color: fade(st.delta >= 0 ? UP : DN, 0.9), width: 1.5 });
      }
      const notes = flowNotes(st);
      if (notes.length && !s.sel) g.label(x1 + 4, bot + 4, (notes[0] as { note: string }).note, { color: GOLD, base: 'top', size: 10.5 });
      if (s.sel) g.card(x2, top, 'Order-flow range', [
        { k: 'Bars · time', v: `${st.n} · ${dur(st.ms)}` },
        { k: 'Move', v: `${sgn(st.c - st.o)}${V.fmt(Math.abs(st.c - st.o))} (${pctS(st.c - st.o, st.o)})`, c: colOf(st.c - st.o) },
        { k: 'VWAP', v: isFinite(st.vwap) ? V.fmt(st.vwap) : '—' }, { sep: true }, ...flowRows(st), ...notes,
      ], { accent: g.color });
    } },
  { id: 'avwap', label: 'Anchored VWAP', group: 'Order Flow', icon: 'avwap', n: 1, color: '#ffffff',
    render(g, d, V, s) {
      const i0 = Math.max(0, barIndexFrom(V.bars, d.pts[0].t)); if (!V.bars.length || i0 >= V.bars.length) return;
      let pv = 0, vv = 0, pv2 = 0, m = 0, sd = 0; const mid: XY[] = [], u1: XY[] = [], d1: XY[] = [], u2: XY[] = [], d2: XY[] = [];
      for (let i = i0; i < V.bars.length; i++) {
        const b = V.bars[i], tp = (b.h + b.l + b.c) / 3; pv += tp * b.v; vv += b.v; pv2 += tp * tp * b.v;
        m = vv ? pv / vv : tp; sd = vv ? Math.sqrt(Math.max(0, pv2 / vv - m * m)) : 0; const x = V.x(b.t);
        mid.push([x, V.y(m)]); u1.push([x, V.y(m + sd)]); d1.push([x, V.y(m - sd)]); u2.push([x, V.y(m + 2 * sd)]); d2.push([x, V.y(m - 2 * sd)]);
      }
      g.poly([...u1, ...d1.slice().reverse()], { close: true, fill: fade(g.color.length === 7 ? g.color : '#ffffff', 0.05), width: 0 });
      g.poly(u2, { width: 1, color: fade(g.color, 0.35), dash: [4, 4] }); g.poly(d2, { width: 1, color: fade(g.color, 0.35), dash: [4, 4] });
      g.poly(u1, { width: 1, color: fade(g.color, 0.5) }); g.poly(d1, { width: 1, color: fade(g.color, 0.5) });
      g.poly(mid, { width: Math.max(1.6, g.width) });
      const [x, y] = P(V, d.pts[0]); g.dot(x, y, 4, g.color, '#111');
      const L = lastPx(V), z = sd ? (L - m) / sd : 0;
      solidPill(g, V.plotW - 4, V.y(m), `AVWAP ${V.fmt(m)}`, '#3a3a42', { align: 'right' });
      if (s.hover || s.sel) pill(g, x + 8, y + 14, `anchored ${when(d.pts[0].t)} · price ${z >= 0 ? '+' : ''}${z.toFixed(1)}σ`, MUTED, { size: 10 });
      if (!s.sel) return;
      const st = rangeStats(V, d.pts[0].t, V.bars[V.bars.length - 1].t);
      g.card(x, y, 'Anchored VWAP', [
        { k: 'AVWAP', v: V.fmt(m) }, { k: '±1σ band', v: `${V.fmt(m - sd)} – ${V.fmt(m + sd)}` },
        { k: 'Price vs AVWAP', v: `${pctS(L - m, m)} · ${z >= 0 ? '+' : ''}${z.toFixed(2)}σ`, c: colOf(L - m) },
        { k: 'Bias', v: L > m ? 'Buyers in control since anchor' : 'Sellers in control since anchor', c: L > m ? UP : DN },
        ...(st ? [{ sep: true } as Row, ...flowRows(st)] : []),
      ], { accent: g.color });
    } },
  { id: 'fixedvp', label: 'Fixed range volume profile', group: 'Order Flow', icon: 'fixedvp', n: 2, color: '#8a45b4',
    render(g, d, V, s) {
      if (d.pts.length < 2) return;
      const ta = Math.min(d.pts[0].t, d.pts[1].t), tb = Math.max(d.pts[0].t, d.pts[1].t), x1 = V.x(ta), x2 = V.x(tb);
      const prof = new Map<number, [number, number]>(); let mx = 0, poc = 0, tot = 0, hi = -Infinity, lo = Infinity, bv = 0, sv = 0;
      const i0 = Math.max(0, barIndexFrom(V.bars, ta)), i1 = barIndexAt(V.bars, tb);
      for (let i = i0; i <= i1; i++) {
        const b = V.bars[i]; hi = Math.max(hi, b.h); lo = Math.min(lo, b.l);
        if (b.fp.size) for (const [k, [ss, bb]] of b.fp) { const r = prof.get(k) || [0, 0]; r[0] += ss; r[1] += bb; prof.set(k, r); }
        else { const k = Math.round(((b.h + b.l + b.c) / 3) / V.row); const r = prof.get(k) || [0, 0]; r[0] += b.s; r[1] += b.b; prof.set(k, r); }
      }
      for (const [k, [ss, b]] of prof) { tot += ss + b; bv += b; sv += ss; if (ss + b > mx) { mx = ss + b; poc = k; } }
      if (!isFinite(hi)) return;
      g.rect(x1, V.y(hi), x2 - x1, V.y(lo) - V.y(hi), { fill: 'rgba(255,255,255,0.025)', stroke: '#4a4a52', hitFill: true });
      if (!mx) return;
      const sorted = [...prof.entries()].sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])); let acc = 0; const va = new Set<number>();
      for (const [k, r] of sorted) { if (acc > tot * 0.7) break; acc += r[0] + r[1]; va.add(k); }
      let vah = -Infinity, val = Infinity; for (const k of va) { vah = Math.max(vah, k); val = Math.min(val, k); }
      const rowPx = Math.max(1, Math.abs(V.y(0) - V.y(V.row)) - 1), maxW = (x2 - x1) * 0.65;
      g.rect(x1, V.y(vah * V.row) - rowPx / 2, x2 - x1, V.y(val * V.row) - V.y(vah * V.row) + rowPx, { fill: 'rgba(138,69,180,0.06)', stroke: false });
      for (const [k, [ss, b]] of prof) {
        const y = V.y(k * V.row) - rowPx / 2, w = ((ss + b) / mx) * maxW, inVa = va.has(k), wb = w * (b / (ss + b || 1));
        if (k === poc) { g.rect(x1, y, w, rowPx, { fill: 'rgba(230,200,74,0.85)', stroke: false }); continue; }
        g.rect(x1, y, wb, rowPx, { fill: inVa ? 'rgba(1,212,3,0.55)' : 'rgba(1,212,3,0.2)', stroke: false });
        g.rect(x1 + wb, y, w - wb, rowPx, { fill: inVa ? 'rgba(138,69,180,0.65)' : 'rgba(138,69,180,0.25)', stroke: false });
      }
      // naked POC: extend until price trades back through it
      const pp = poc * V.row; let nakedEnd = V.plotW;
      for (let i = i1 + 1; i < V.bars.length; i++) if (V.bars[i].l <= pp && V.bars[i].h >= pp) { nakedEnd = V.x(V.bars[i].t); break; }
      const yp = V.y(pp); g.line(x1, yp, x2, yp, { color: GOLD, width: 1.4 }); g.line(x2, yp, nakedEnd, yp, { color: fade(GOLD, 0.7), width: 1, dash: [6, 4] });
      g.label(x2 + 4, yp - 8, `POC ${V.fmt(pp)}${nakedEnd >= V.plotW ? ' · naked' : ''}`, { color: GOLD, size: 10.5, bold: true });
      for (const [k, lbl] of [[vah, 'VAH'], [val, 'VAL']] as [number, string][]) { const yy = V.y(k * V.row); g.line(x1, yy, x2, yy, { color: fade('#c38bff', 0.7), width: 1, dash: [2, 3] }); g.label(x2 + 4, yy, `${lbl} ${V.fmt(k * V.row)}`, { color: '#c38bff', size: 10 }); }
      if (!s.sel) return;
      const st = rangeStats(V, ta, tb);
      g.card(x2, V.y(hi), 'Volume profile', [
        { k: 'POC', v: `${V.fmt(pp)}${nakedEnd >= V.plotW ? '  (naked)' : ''}`, c: GOLD }, { k: 'Value area (70%)', v: `${V.fmt(val * V.row)} – ${V.fmt(vah * V.row)}` },
        { k: 'High · low', v: `${V.fmt(hi)} · ${V.fmt(lo)}` }, { sep: true },
        { k: 'Volume', v: fmtQ(tot) }, { k: 'Delta', v: fq(bv - sv), c: colOf(bv - sv) }, { split: [bv, sv] },
        ...(st && st.cvd.length > 2 ? [{ spark: st.cvd } as Row] : []), ...(st ? flowNotes(st) : []),
      ], { accent: GOLD });
    } },
  { id: 'imbzone', label: 'Supply / demand zone (auto status)', group: 'Order Flow', icon: 'imbzone', n: 2, color: '#00e5ff', text: 'Zone',
    render(g, d, V, s) {
      if (d.pts.length < 2) return; const [a, b] = d.pts, [x1, y1] = P(V, a), [, y2] = P(V, b);
      const hi = Math.max(a.p, b.p), lo = Math.min(a.p, b.p), L = lastPx(V), demand = !isFinite(L) || L >= (hi + lo) / 2;
      // status: fresh → tested (n) → broken (close through the zone)
      const i0 = Math.max(0, barIndexFrom(V.bars, Math.max(a.t, b.t)) + 1); let tests = 0, inZ = false, broken = -1;
      for (let i = i0; i < V.bars.length; i++) {
        const bb = V.bars[i], hit = bb.l <= hi && bb.h >= lo;
        if (hit && !inZ) tests++; inZ = hit;
        if (demand ? bb.c < lo : bb.c > hi) { broken = i; break; }
      }
      const xEnd = broken >= 0 ? V.x(V.bars[broken].t) : V.plotW, status = broken >= 0 ? 'BROKEN' : tests ? `TESTED ×${tests}` : 'FRESH';
      const alpha = broken >= 0 ? 0.05 : tests ? 0.11 : 0.18;
      g.rect(x1, y1, xEnd - x1, y2 - y1, { fill: fade(g.color, alpha), stroke: false, hitFill: true });
      g.line(x1, y1, xEnd, y1, { width: 1, dash: broken >= 0 ? [3, 3] : [] }); g.line(x1, y2, xEnd, y2, { width: 1, dash: broken >= 0 ? [3, 3] : [] });
      g.rect(x1, Math.min(y1, y2), 3, Math.abs(y2 - y1), { fill: g.color, stroke: false });
      pill(g, x1 + 6, Math.min(y1, y2) + 3, `${d.text || (demand ? 'Demand' : 'Supply')} · ${status}`, broken >= 0 ? MUTED : g.color, { base: 'top', size: 10.5, bold: true });
      if (!s.sel) return;
      const st = rangeStats(V, Math.min(a.t, b.t), V.bars[V.bars.length - 1].t, lo, hi);
      g.card(Math.min(xEnd, V.plotW - 10), Math.min(y1, y2), `${demand ? 'Demand' : 'Supply'} zone`, [
        { k: 'Top · bottom', v: `${V.fmt(hi)} · ${V.fmt(lo)}` }, { k: 'Height', v: `${Math.round((hi - lo) / V.tick)} ticks · ${pctS(hi - lo, lo)}` },
        { k: 'Status', v: status, c: broken >= 0 ? DN : tests ? GOLD : UP }, { k: 'Age', v: `${V.bars.length - 1 - i0} bars` },
        { k: 'Distance', v: isFinite(L) ? (L > hi ? `${pctS(L - hi, hi)} above` : L < lo ? `${pctS(lo - L, lo)} below` : 'price inside') : '—' },
        ...(st ? [{ sep: true } as Row, { note: 'Volume traded inside the zone', c: MUTED } as Row, ...flowRows(st, false)] : []),
        ...(tests >= 3 && broken < 0 ? [{ note: '⚠ Zone weakening — tested 3+ times' } as Row] : []),
      ], { accent: g.color, side: 'left' });
    } },
];

export const TOOL_MAP = new Map(TOOLS.map(t => [t.id, t]));
export const TOOL_GROUPS = ['Lines', 'Fibonacci', 'Gann & Pitchfork', 'Shapes', 'Positions', 'Measure', 'Text & Marks', 'Order Flow'];
export const PALETTE = ['#e6e6e6', '#42da45', '#8a45b4', '#ffb020', '#00e5ff', '#ff3df5', '#ff4d5e', '#4da3ff', '#ffd23f'];

export function renderDrawing(g: G, d: Drawing, V: DView, s: RState = IDLE) {
  const def = TOOL_MAP.get(d.type); if (!def) return;
  g.color = d.color; g.width = d.width; g.dash = d.dash === 1 ? [6, 4] : d.dash === 2 ? [2, 3] : [];
  g.bw = V.plotW; g.bh = V.mainH;
  def.render(g, d, V, s);
}

/** Distance in px from (x, y) to the drawing; selected drawings include their info card. */
export function hitDrawing(d: Drawing, V: DView, x: number, y: number, sel = false): number {
  const h = new Hitter(x, y); renderDrawing(h, d, V, { sel, hover: false }); return h.d;
}

/** Handle positions (pixels) for a drawing. */
export function handlesOf(d: Drawing, V: DView): XY[] {
  if (d.type === 'brush' || d.type === 'highlighter') return d.pts.length ? [P(V, d.pts[0]), P(V, d.pts[d.pts.length - 1])] : [];
  if (d.type === 'hline') return [[V.plotW / 2, V.y(d.pts[0].p)]];
  if (d.type === 'vline') return [[V.x(d.pts[0].t), V.mainH / 2]];
  return d.pts.map(p => P(V, p));
}
