/**
 * ChartEngine — canvas renderer + interaction for candles, footprint and liquidity heatmap,
 * order-flow overlays, custom indicator plots, paper-trading markers and drawing tools.
 */
import type { Bar, BarSpec, ChartStyle, Drawing, KBar, Overlays, Plot, Pt, SymbolInfo } from '../lib/types';
import { BarBuilder, buildSeries, type Series } from '../data/bars';
import { data, type MarketData } from '../data/client';
import { FONT, MONO, fmtQ, niceStep, uid } from '../lib/format';
import { TA } from '../lib/ta';
import { Painter, TOOL_MAP, handlesOf, hitDrawing, renderDrawing, type DView } from './drawings';
import type { PaperBroker } from '../lib/paper';

export interface EngineOpts {
  style: ChartStyle; ov: Overlays; spec: BarSpec; rowMult: number; bigUsd: number;
  acct: { size: number; risk: number }; magnet: boolean;
}
export interface EngineCallbacks {
  drawings?(list: Drawing[]): void;
  select?(d: Drawing | null): void;
  tool?(t: string): void;
  context?(e: MouseEvent, price: number): void;
  legend?(html: string): void;
  gauges?(imb: number, cvd: number): void;
}

/* colour ramps — DeepDom purple asks, green bids */
const ramp = (stops: [number, number[]][]) => { const o: string[] = []; for (let i = 0; i < 64; i++) { const r = i / 63; let j = 0; while (j < stops.length - 2 && r > stops[j + 1][0]) j++; const [a, ca] = stops[j], [b, cb] = stops[j + 1], f = (r - a) / (b - a); o.push(`rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * f)).join(',')})`); } return o; };
const HEAT_ASK = ramp([[0, [26, 26, 26]], [0.15, [31, 27, 41]], [0.35, [44, 28, 81]], [0.55, [77, 33, 129]], [0.75, [138, 69, 180]], [0.9, [193, 120, 244]], [1, [240, 210, 255]]]);
const HEAT_BID = ramp([[0, [26, 26, 26]], [0.2, [22, 36, 26]], [0.45, [20, 64, 36]], [0.7, [30, 120, 50]], [0.88, [70, 200, 80]], [1, [200, 255, 190]]]);
const BULL = '#01d403', BEAR = '#7a33bf';

export class ChartEngine {
  cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  W = 0; H = 0; dpr = 1;
  sym: SymbolInfo | null = null;
  md: MarketData | null = null;
  opt: EngineOpts;
  cb: EngineCallbacks = {};
  B: BarBuilder | null = null;
  klines: KBar[] = []; private kKey = '';
  view = { cw: 8, off: 0, y: null as null | { mid: number; span: number } };
  drawings: Drawing[] = [];
  sel: string | null = null;
  tool = 'cursor';
  plots: Plot[] = [];
  paper: PaperBroker | null = null;
  replayIdx: number | null = null;
  hidden = false; locked = false;
  mouse: { x: number; y: number } | null = null;

  private unsub: (() => void) | null = null;
  private dirty = true; private raf = 0; private lastDraw = 0;
  private creating: Drawing | null = null; private createDown: { x: number; y: number } | null = null;
  private drag: null | { kind: 'pan' | 'yaxis' | 'xaxis' | 'move' | 'handle'; x: number; y: number; off: number; cw: number; y0: { mid: number; span: number }; orig?: Pt[]; hi?: number; t0?: number; p0?: number } = null;
  private undo: string[] = []; private redo: string[] = [];
  private G: any = {};
  private ro: ResizeObserver;

  constructor(cv: HTMLCanvasElement, opt: EngineOpts) {
    this.cv = cv; this.ctx = cv.getContext('2d')!; this.opt = opt;
    this.ro = new ResizeObserver(() => this.resize()); this.ro.observe(cv);
    this.bindEvents();
    const loop = (t: number) => { this.raf = requestAnimationFrame(loop); if (this.dirty || t - this.lastDraw > 500) { this.dirty = false; this.lastDraw = t; try { this.draw(); } catch (e) { console.error(e); } } };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() { cancelAnimationFrame(this.raf); this.ro.disconnect(); this.unsub?.(); this.unbind(); }
  invalidate() { this.dirty = true; }
  private resize() {
    const r = this.cv.getBoundingClientRect(); this.dpr = window.devicePixelRatio || 1;
    this.W = r.width; this.H = r.height;
    this.cv.width = Math.max(1, Math.round(r.width * this.dpr)); this.cv.height = Math.max(1, Math.round(r.height * this.dpr));
    this.dirty = true;
  }

  /* ================================================================ data */
  setMarket(md: MarketData, sym: SymbolInfo) {
    this.unsub?.();
    this.md = md; this.sym = sym; this.view.off = 0; this.view.y = null; this.kKey = ''; this.klines = [];
    this.unsub = md.on((e, d) => {
      if (e === 'snap') this.rebuild();
      else if (e === 'tk' && this.B) { for (const t of d) this.B.add(t); }
      this.dirty = true;
    });
    this.rebuild();
  }
  setOptions(o: Partial<EngineOpts>) {
    const prev = this.opt; this.opt = { ...this.opt, ...o };
    if (o.spec && JSON.stringify(o.spec) !== JSON.stringify(prev.spec) || (o.rowMult && o.rowMult !== prev.rowMult) || (o.bigUsd && o.bigUsd !== prev.bigUsd)) this.rebuild();
    if (o.style && o.style !== prev.style) { this.view.cw = o.style === 'footprint' ? 110 : o.style === 'heatmap' ? 4 : 8; this.view.off = 0; this.view.y = null; }
    this.dirty = true;
  }
  rowSize() { return (this.sym?.row || 1) * this.opt.rowMult; }
  barMs() { const s = this.opt.spec; return s.kind === 'time' ? s.sec * 1000 : 0; }

  rebuild() {
    if (!this.md || !this.sym) return;
    this.B = new BarBuilder(this.opt.spec, this.rowSize(), this.opt.bigUsd);
    this.B.addAll(this.md.ticks);
    const s = this.opt.spec;
    if (s.kind === 'time' && s.sec >= 60) {
      const key = `${this.sym.id}:${s.sec}`;
      if (this.kKey === key && this.klines.length) this.B.seedKlines(this.klines, this.estSplit());
      else if (this.kKey !== key) {
        this.kKey = key;
        data.klines(this.sym.id, s.sec, 1500).then(k => { if (this.kKey === key) { this.klines = k; this.rebuildKeepKlines(); } });
      }
    }
    this.dirty = true;
  }
  private rebuildKeepKlines() {
    if (!this.md || !this.sym) return;
    this.B = new BarBuilder(this.opt.spec, this.rowSize(), this.opt.bigUsd);
    this.B.addAll(this.md.ticks);
    this.B.seedKlines(this.klines, this.estSplit());
    this.dirty = true;
  }
  private estSplit() { return !!this.sym && /hyperliquid|bybit/i.test(this.sym.venues) && !/binance/i.test(this.sym.venues); }

  get bars(): Bar[] { const b = this.B?.bars || []; return this.replayIdx != null ? b.slice(0, Math.min(this.replayIdx, b.length)) : b; }
  series(): Series { return buildSeries(this.bars); }

  /* ================================================================ drawings */
  setDrawings(list: Drawing[]) { this.drawings = list; this.sel = null; this.undo = []; this.redo = []; this.dirty = true; }
  private snapshot() { this.undo.push(JSON.stringify(this.drawings)); if (this.undo.length > 100) this.undo.shift(); this.redo = []; }
  private changed() { this.cb.drawings?.(this.drawings); this.dirty = true; }
  undoDraw() { const s = this.undo.pop(); if (s == null) return; this.redo.push(JSON.stringify(this.drawings)); this.drawings = JSON.parse(s); this.select(null); this.changed(); }
  redoDraw() { const s = this.redo.pop(); if (s == null) return; this.undo.push(JSON.stringify(this.drawings)); this.drawings = JSON.parse(s); this.select(null); this.changed(); }
  select(id: string | null) { this.sel = id; this.cb.select?.(this.drawings.find(d => d.id === id) || null); this.dirty = true; }
  selected() { return this.drawings.find(d => d.id === this.sel) || null; }
  updateSelected(patch: Partial<Drawing>) { const d = this.selected(); if (!d) return; this.snapshot(); Object.assign(d, patch); this.changed(); this.cb.select?.(d); }
  deleteSelected() { if (!this.sel) return; this.snapshot(); this.drawings = this.drawings.filter(d => d.id !== this.sel); this.select(null); this.changed(); }
  cloneSelected() { const d = this.selected(); if (!d) return; this.snapshot(); const c: Drawing = JSON.parse(JSON.stringify(d)); c.id = uid(); const dt = this.barMs() * 3 || 60000; c.pts.forEach(p => { p.t += dt; }); this.drawings.push(c); this.changed(); this.select(c.id); }
  clearDrawings() { if (!this.drawings.length) return; this.snapshot(); this.drawings = []; this.select(null); this.changed(); }
  setTool(t: string) { this.tool = t; this.creating = null; this.cv.style.cursor = t === 'cursor' ? 'default' : 'crosshair'; this.cb.tool?.(t); this.dirty = true; }

  /* ================================================================ coordinates */
  private geom() {
    const panes = this.subPanes();
    const axisW = 78, ladW = this.opt.style === 'heatmap' && this.sym?.hasBook ? 36 : 0, timeH = 24;
    const subH = panes.length ? Math.max(60, Math.round((this.H - timeH) * (panes.length > 2 ? 0.11 : 0.15))) : 0;
    const mainH = this.H - timeH - subH * panes.length, plotW = this.W - axisW - ladW;
    return { axisW, ladW, timeH, subH, mainH, plotW, panes };
  }
  private subPanes(): string[] {
    const p: string[] = [];
    if (this.opt.ov.volume) p.push('volume');
    if (this.opt.ov.cvd) p.push('cvd');
    if (this.opt.ov.delta) p.push('delta');
    this.plots.forEach((pl, i) => { if (pl.pane === 'sub') p.push('plot:' + i); });
    return p.slice(0, 5);
  }
  timeToX(t: number): number {
    const b = this.G.bars as Bar[]; const n = b?.length; if (!n) return 0;
    const ms = this.barMs() || (n > 1 ? (b[n - 1].t - b[0].t) / (n - 1) : 60000);
    if (t >= b[n - 1].t) return this.G.xOf(n - 1 + (t - b[n - 1].t) / ms);
    if (t <= b[0].t) return this.G.xOf((t - b[0].t) / ms);
    let lo = 0, hi = n - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (b[m].t <= t) lo = m; else hi = m; }
    const span = b[hi].t - b[lo].t || ms; return this.G.xOf(lo + Math.min(1, (t - b[lo].t) / span));
  }
  xToTime(x: number): number {
    const b = this.G.bars as Bar[]; const n = b?.length; if (!n) return Date.now();
    const i = this.G.iOf(x), ms = this.barMs() || (n > 1 ? (b[n - 1].t - b[0].t) / (n - 1) : 60000);
    if (i >= n - 1) return b[n - 1].t + (i - (n - 1)) * ms;
    if (i <= 0) return b[0].t + i * ms;
    const lo = Math.floor(i), f = i - lo; return b[lo].t + f * ((b[lo + 1]?.t ?? b[lo].t + ms) - b[lo].t);
  }
  private dview(): DView {
    const G = this.G, sym = this.sym!;
    return { x: (t) => this.timeToX(t), y: G.yOf, t: (x) => this.xToTime(x), p: G.pOf, plotW: G.plotW, mainH: G.mainH, dec: sym.dec, tick: sym.tick, bars: G.bars, row: this.rowSize(), fmt: (p) => p.toFixed(sym.dec), acct: this.opt.acct };
  }
  resetY() { this.view.y = null; this.dirty = true; }
  goLive() { this.view.off = 0; this.view.y = null; this.dirty = true; }

  /* ================================================================ render */
  private draw() {
    const ctx = this.ctx, W = this.W, H = this.H; if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sym = this.sym, bars = this.bars, n = bars.length;
    const fp = this.opt.style === 'footprint', heat = this.opt.style === 'heatmap';
    const bg = fp ? '#151521' : '#1a1a1a';
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    if (!sym || !n) {
      ctx.fillStyle = '#777'; ctx.font = `14px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(!sym ? 'Loading symbols…' : this.md?.ready ? (sym.volume === 'none' ? 'Waiting for the first price…' : 'Waiting for trades…') : 'Connecting to data feed…', W / 2, H / 2);
      ctx.textAlign = 'left'; return;
    }
    const { axisW, ladW, timeH, subH, mainH, plotW, panes } = this.geom();
    const cw = this.view.cw, rpad = heat ? 120 : Math.max(cw * 4, 60);
    const xOf = (i: number) => plotW - rpad - (n - 1 - i) * cw + this.view.off * cw;
    const iOf = (x: number) => n - 1 - (plotW - rpad + this.view.off * cw - x) / cw;
    const first = Math.max(0, Math.floor(iOf(0)) - 1), last = Math.min(n - 1, Math.ceil(iOf(plotW)) + 1);

    let lo = Infinity, hi = -Infinity;
    for (let i = first; i <= last; i++) { if (bars[i].l < lo) lo = bars[i].l; if (bars[i].h > hi) hi = bars[i].h; }
    if (!isFinite(lo)) { lo = bars[n - 1].l; hi = bars[n - 1].h; }
    const pad = Math.max((hi - lo) * 0.08, sym.tick * 8); lo -= pad; hi += pad;
    if (this.view.y) { lo = this.view.y.mid - this.view.y.span / 2; hi = this.view.y.mid + this.view.y.span / 2; }
    const yOf = (p: number) => (hi - p) / (hi - lo) * mainH, pOf = (y: number) => hi - (y / mainH) * (hi - lo);
    const row = this.rowSize(), pxRow = (mainH * row) / (hi - lo);
    this.G = { xOf, iOf, yOf, pOf, plotW, mainH, bars, n, lo, hi, first, last, cw };
    const fmtP = (p: number) => p.toFixed(sym.dec);

    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, mainH); ctx.clip();

    // grid
    const gs = niceStep((hi - lo) / 9);
    ctx.strokeStyle = fp ? '#1c1c2a' : '#202020'; ctx.lineWidth = 1;
    for (let p = Math.ceil(lo / gs) * gs; p < hi; p += gs) { const y = Math.round(yOf(p)) + 0.5; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); }

    /* ---------- liquidity heatmap ---------- */
    if (heat && this.md) {
      const cols = this.md.heat, tEnd = this.replayIdx != null ? bars[n - 1].t + (this.barMs() || 1000) : Infinity;
      const tLo = this.xToTime(0), tHi = this.xToTime(plotW);
      let i0 = 0; { let a = 0, b = cols.length - 1; while (a <= b) { const m = (a + b) >> 1; if (cols[m].t < tLo) a = m + 1; else b = m - 1; } i0 = Math.max(0, a - 1); }
      let mx = 1; for (let i = i0; i < cols.length && cols[i].t <= tHi && cols[i].t <= tEnd; i++) for (const l of cols[i].l) if (l[1] > mx) mx = l[1];
      mx *= 0.5;
      const rowH = Math.max(1, pxRow);
      for (let i = i0; i < cols.length && cols[i].t <= tHi && cols[i].t <= tEnd; i++) {
        const c = cols[i], x = this.timeToX(c.t), nx = i + 1 < cols.length ? this.timeToX(cols[i + 1].t) : x + Math.max(1, cw / 2);
        const w = Math.max(1, Math.min(nx - x, cw * 4) + 0.6);
        for (const [p, q, s] of c.l) {
          const y = yOf(p + row); if (y > mainH || y + rowH < 0) continue;
          const ix = Math.min(63, Math.floor(Math.pow(Math.min(1, q / mx), 0.55) * 63)); if (ix < 4) continue;
          ctx.fillStyle = s > 0 ? HEAT_BID[ix] : HEAT_ASK[ix]; ctx.fillRect(x, y, w, rowH + 0.6);
        }
      }
      // price path
      ctx.lineWidth = 1.4;
      for (let i = Math.max(first, 1); i <= last; i++) { const a = bars[i - 1], c = bars[i]; ctx.strokeStyle = c.c >= a.c ? BULL : '#8a45b4'; ctx.beginPath(); ctx.moveTo(xOf(i - 1), yOf(a.c)); ctx.lineTo(xOf(i), yOf(c.c)); ctx.stroke(); }
      for (let i = first; i <= last; i++) { if (cw < 3 && i % 2) continue; const c = bars[i]; ctx.fillStyle = c.b >= c.s ? '#7be36f' : '#b27ae6'; ctx.beginPath(); ctx.arc(xOf(i), yOf(c.c), 1.8, 0, 7); ctx.fill(); }
      if (this.opt.ov.bubbles) for (let i = first; i <= last; i++) for (const t of bars[i].big) {
        const r = Math.min(24, 3 + Math.sqrt((t[2] * t[1]) / this.opt.bigUsd) * 4.2), x = xOf(i), y = yOf(t[1]);
        const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
        if (t[3] > 0) { g.addColorStop(0, '#b8ff9c'); g.addColorStop(1, '#2fa82c'); } else { g.addColorStop(0, '#e3c2ff'); g.addColorStop(1, '#8a45b4'); }
        ctx.globalAlpha = 0.85; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      }
    }

    /* ---------- candles ---------- */
    if (this.opt.style === 'candles') {
      for (let i = first; i <= last; i++) {
        const c = bars[i], x = Math.round(xOf(i)), col = c.c >= c.o ? BULL : BEAR, bw = Math.max(1, Math.round(cw * 0.66));
        ctx.fillStyle = col; ctx.fillRect(x, Math.round(yOf(c.h)), 1, Math.max(1, Math.round(yOf(c.l) - yOf(c.h))));
        const y1 = Math.round(yOf(Math.max(c.o, c.c))), y2 = Math.round(yOf(Math.min(c.o, c.c)));
        ctx.fillRect(x - Math.floor(bw / 2), y1, bw, Math.max(1, y2 - y1));
      }
      if (this.opt.ov.bubbles) {
        ctx.lineWidth = 2;
        for (let i = first; i <= last; i++) {
          let bb: any = null, bs: any = null;
          for (const t of bars[i].big) { if (t[3] > 0) { if (!bb || t[2] > bb[2]) bb = t; } else if (!bs || t[2] > bs[2]) bs = t; }
          for (const t of [bb, bs]) if (t) { const r = Math.min(20, 6 + Math.sqrt((t[2] * t[1]) / this.opt.bigUsd) * 3.2); ctx.strokeStyle = t[3] > 0 ? '#14c814' : '#6a2fa8'; ctx.beginPath(); ctx.arc(xOf(i), yOf(t[1]), r, 0, 7); ctx.stroke(); }
        }
        ctx.lineWidth = 1;
      }
    }

    /* ---------- footprint ---------- */
    if (fp) {
      const mul = Math.max(1, Math.ceil(17 / pxRow)), rowPx = pxRow * mul, colW = cw * 0.86, showTxt = cw >= 64 && rowPx >= 12;
      ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
      for (let i = first; i <= last; i++) {
        const c = bars[i], x0 = xOf(i) - colW / 2, up = c.c >= c.o;
        ctx.fillStyle = up ? BULL : '#8a2ae0';
        ctx.fillRect(x0, yOf(c.h), 2, Math.max(1, yOf(c.l) - yOf(c.h)));
        const yb = yOf(Math.max(c.o, c.c)); ctx.fillRect(x0 - 1, yb, 5, Math.max(2, yOf(Math.min(c.o, c.c)) - yb));
        if (!c.fp.size) { // kline bar without tick detail
          ctx.fillStyle = '#ffffff10'; ctx.fillRect(x0 + 8, yOf(c.h), colW - 10, Math.max(1, yOf(c.l) - yOf(c.h)));
          if (showTxt) { ctx.fillStyle = '#666'; ctx.font = `10px ${FONT}`; ctx.fillText('no tick data', x0 + colW / 2, (yOf(c.h) + yOf(c.l)) / 2); }
          continue;
        }
        const rows = new Map<number, [number, number]>();
        for (const [k, [s, b]] of c.fp) { const rk = Math.floor(k / mul); const r = rows.get(rk) || [0, 0]; r[0] += s; r[1] += b; rows.set(rk, r); }
        let mx = 0, poc = 0; for (const [rk, r] of rows) { const t = r[0] + r[1]; if (t > mx) { mx = t; poc = rk; } }
        const cx0 = x0 + 8, cW = colW - 10, half = cW / 2;
        for (const [rk, [s, b]] of rows) {
          const y = yOf((rk + 1) * mul * row - row / 2), h = Math.max(1, rowPx - 2), tot = s + b, buyDom = b >= s;
          const strong = Math.abs(b - s) / (tot || 1) > 0.45 && tot > mx * 0.35;
          ctx.fillStyle = buyDom ? (strong ? '#4db84f' : '#8ab88b') : (strong ? '#8a45b4' : '#a795b6');
          ctx.fillRect(cx0, y + 1, Math.max(4, (tot / mx) * half), h);
          if (rk === poc) { ctx.strokeStyle = '#e6e62a'; ctx.lineWidth = 1.5; ctx.strokeRect(cx0 + 0.5, y + 1.5, cW - 1, h - 1); ctx.lineWidth = 1; }
          if (showTxt) {
            const below = rows.get(rk - 1), above = rows.get(rk + 1);
            const imbB = !!below && b > below[0] * 3 && b > 0, imbS = !!above && s > above[1] * 3 && s > 0;
            const fs = Math.min(12, rowPx * 0.72);
            ctx.font = `${imbS ? '700 ' : ''}${fs}px ${FONT}`; ctx.fillStyle = imbS ? '#ff3df5' : '#eeeeee'; ctx.fillText(fmtQ(s), cx0 + half * 0.5, y + 1 + h / 2);
            ctx.font = `${imbB ? '700 ' : ''}${fs}px ${FONT}`; ctx.fillStyle = imbB ? '#00e5ff' : '#eeeeee'; ctx.fillText(fmtQ(b), cx0 + half * 1.5, y + 1 + h / 2);
          }
        }
        if (showTxt) { const dl = c.b - c.s; ctx.font = `11px ${FONT}`; ctx.fillStyle = dl >= 0 ? '#42da45' : '#c38bff'; ctx.fillText(`Δ ${fmtQ(dl)}`, x0 + colW / 2, yOf(c.l) + rowPx / 2 + 12); }
      }
      ctx.textAlign = 'left';
    }

    /* ---------- overlays ---------- */
    const S = buildSeries(bars);
    const line = (v: (number | null)[], col: string, w = 1.5, dash?: number[]) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath(); let st = false;
      for (let i = first; i <= last; i++) { const y = v[i]; if (y == null || !isFinite(y)) { st = false; continue; } st ? ctx.lineTo(xOf(i), yOf(y)) : ctx.moveTo(xOf(i), yOf(y)); st = true; }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    if (this.opt.ov.vwap) { line(S.vwap, '#ffffff', 1.4); const sd = TA.stdev(S.close, 50); line(S.vwap.map((v, i) => sd[i] != null ? v + sd[i]! : null), '#ffffff55', 1, [4, 4]); line(S.vwap.map((v, i) => sd[i] != null ? v - sd[i]! : null), '#ffffff55', 1, [4, 4]); }
    if (this.opt.ov.visp || this.opt.ov.dlyp) {
      const prof = new Map<number, number>(); let mx = 0, poc = 0, tot = 0;
      let f0 = first; if (this.opt.ov.dlyp && !this.opt.ov.visp) { const d0 = Math.floor(bars[last].t / 86_400_000) * 86_400_000; f0 = 0; while (f0 < n && bars[f0].t < d0) f0++; }
      for (let i = f0; i <= last; i++) {
        const c = bars[i];
        if (c.fp.size) for (const [k, [s, b]] of c.fp) { const v = (prof.get(k) || 0) + s + b; prof.set(k, v); tot += s + b; if (v > mx) { mx = v; poc = k; } }
        else { const k = Math.round(((c.h + c.l + c.c) / 3) / row); const v = (prof.get(k) || 0) + c.v; prof.set(k, v); tot += c.v; if (v > mx) { mx = v; poc = k; } }
      }
      if (mx) {
        const sorted = [...prof.entries()].sort((a, b) => b[1] - a[1]); let acc = 0; const va = new Set<number>();
        for (const [k, v] of sorted) { if (acc > tot * 0.7) break; acc += v; va.add(k); }
        const maxW = Math.min(220, plotW * 0.22), h = Math.max(1, pxRow - 0.5);
        for (const [k, v] of prof) { const y = yOf(k * row) - h / 2, w = (v / mx) * maxW; ctx.fillStyle = k === poc ? '#e6e62acc' : va.has(k) ? '#8a45b466' : '#8a45b42a'; ctx.fillRect(plotW - w, y, w, h); }
        const yp = yOf(poc * row); ctx.strokeStyle = '#e6e62a'; ctx.setLineDash([5, 4]); ctx.beginPath(); ctx.moveTo(0, yp); ctx.lineTo(plotW, yp); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    if (this.opt.ov.imbl) {
      ctx.lineWidth = 2;
      for (let i = Math.max(0, last - 150); i <= last; i++) {
        const c = bars[i]; if (!c.fp.size) continue; const ks = [...c.fp.keys()].sort((a, b) => a - b); let rb = 0, rs = 0;
        for (let j = 1; j < ks.length; j++) {
          const cur = c.fp.get(ks[j])!, prev = c.fp.get(ks[j - 1])!;
          rb = cur[1] > prev[0] * 3 && cur[1] > 0 ? rb + 1 : 0; rs = prev[0] > cur[1] * 3 && prev[0] > 0 ? rs + 1 : 0;
          if (rb === 3 || rs === 3) { const y = yOf(ks[j] * row); ctx.strokeStyle = rb === 3 ? '#00e5ffaa' : '#ff3df5aa'; ctx.beginPath(); ctx.moveTo(xOf(i), y); ctx.lineTo(plotW, y); ctx.stroke(); }
        }
      }
      ctx.lineWidth = 1;
    }
    for (const p of this.plots) if (p.pane !== 'sub') {
      if (p.type === 'dots') { ctx.fillStyle = p.color; for (let i = first; i <= last; i++) { const v = p.values[i]; if (v == null) continue; const x = xOf(i), y = yOf(v); ctx.beginPath(); ctx.moveTo(x, y - 6); ctx.lineTo(x + 5, y); ctx.lineTo(x, y + 6); ctx.lineTo(x - 5, y); ctx.closePath(); ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; } }
      else line(p.values, p.color, 1.5);
    }

    /* ---------- paper trading ---------- */
    const lastC = bars[n - 1];
    const tag = (x: number, y: number, s: string, b: string) => { ctx.font = `12px ${FONT}`; const w = ctx.measureText(s).width + 12; ctx.fillStyle = b; ctx.fillRect(x, y - 9, w, 18); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(s, x + 6, y); };
    if (this.paper && this.paper.sym === sym.id) {
      const P = this.paper;
      if (P.pos.qty) { const y = yOf(P.pos.avg), pl = (lastC.c - P.pos.avg) * P.pos.qty; ctx.strokeStyle = pl >= 0 ? BULL : '#b27ae6'; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); ctx.setLineDash([]); tag(plotW - 230, y, `${P.pos.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(P.pos.qty)} @ ${fmtP(P.pos.avg)}  ${pl >= 0 ? '+' : ''}${pl.toFixed(2)}`, pl >= 0 ? '#0e5b0d' : '#4a1f6f'); }
      for (const o of P.orders) { const y = yOf(o.px); ctx.strokeStyle = o.side > 0 ? '#42da45' : '#a66be0'; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke(); tag(plotW - 170, y, `${o.type.toUpperCase()} ${o.side > 0 ? 'BUY' : 'SELL'} ${o.qty} @ ${fmtP(o.px)}`, o.side > 0 ? '#0e5b0d' : '#4a1f6f'); }
    }

    /* ---------- drawings ---------- */
    if (!this.hidden) {
      const V = this.dview(), painter = new Painter(ctx);
      for (const d of this.drawings) if (!d.hidden) renderDrawing(painter, d, V);
      if (this.creating) renderDrawing(painter, this.creating, V);
      const s = this.selected();
      if (s) for (const [hx, hy] of handlesOf(s, V)) { ctx.fillStyle = '#1a1a1a'; ctx.strokeStyle = s.locked ? '#888' : '#7be36f'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1; }
    }
    ctx.fillStyle = '#cfcfcf'; ctx.font = `13px ${FONT}`; ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
    ctx.fillText(`FlowScope® · ${sym.venues}`, 6, mainH - 8);
    ctx.restore();

    /* ---------- DOM ladder strip (heatmap) ---------- */
    if (ladW && this.md) {
      const lx = plotW; ctx.fillStyle = '#1a1a1a'; ctx.fillRect(lx, 0, ladW, mainH);
      const lv = new Map<number, [number, number]>(); let mx = 1;
      for (const [p, q] of this.md.book.b) { const k = Math.floor(p / row); const e = lv.get(k) || [0, 1]; e[0] += q; lv.set(k, e); }
      for (const [p, q] of this.md.book.a) { const k = Math.floor(p / row); const e = lv.get(k) || [0, -1]; e[0] += q; e[1] = -1; lv.set(k, e); }
      for (const e of lv.values()) mx = Math.max(mx, e[0]);
      const step = Math.max(1, Math.ceil(13 / pxRow));
      ctx.font = `11px ${FONT}`; ctx.textBaseline = 'middle';
      for (const [k, [q, s]] of lv) { if (k % step) continue; const y = yOf((k + 0.5) * row); if (y < 6 || y > mainH - 6) continue; ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, (q / mx) * 2); ctx.fillStyle = s > 0 ? '#1aa51a' : '#6b2fb3'; ctx.fillRect(lx, y - 6.5, 4 + Math.min(1, q / mx) * 30, 13); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(fmtQ(q), lx + 3, y); }
    }

    /* ---------- sub panes ---------- */
    panes.forEach((pane, pi) => {
      const st = mainH + pi * subH; ctx.fillStyle = bg; ctx.fillRect(0, st, plotW + ladW, subH); ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, st, W, 1);
      ctx.save(); ctx.beginPath(); ctx.rect(0, st + 1, plotW, subH - 1); ctx.clip();
      let label = '', axisTxt = '';
      const lineSub = (v: (number | null)[], col: string) => { let a = Infinity, b = -Infinity; for (let i = first; i <= last; i++) { const y = v[i]; if (y != null && isFinite(y)) { a = Math.min(a, y); b = Math.max(b, y); } } if (!isFinite(a)) return; if (a === b) { a -= 1; b += 1; } ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.beginPath(); let s0 = false; for (let i = first; i <= last; i++) { const y = v[i]; if (y == null) continue; const yy = st + 8 + ((b - y) / (b - a)) * (subH - 16); s0 ? ctx.lineTo(xOf(i), yy) : ctx.moveTo(xOf(i), yy); s0 = true; } ctx.stroke(); ctx.lineWidth = 1; axisTxt = fmtQ(v[last] ?? 0); };
      const histSub = (v: (number | null)[], pos: string, neg: string) => { let m = 0; for (let i = first; i <= last; i++) { const y = v[i]; if (y != null) m = Math.max(m, Math.abs(y)); } const mid = st + subH / 2; for (let i = first; i <= last; i++) { const y = v[i]; if (y == null) continue; const h = (y / (m || 1)) * (subH / 2 - 6); ctx.fillStyle = y >= 0 ? pos : neg; ctx.fillRect(xOf(i) - Math.max(1, cw * 0.33), Math.min(mid, mid - h), Math.max(1, cw * 0.66), Math.abs(h)); } axisTxt = fmtQ(v[last] ?? 0); };
      if (pane === 'volume') {
        label = 'Volume'; let mx = 1; for (let i = first; i <= last; i++) mx = Math.max(mx, bars[i].v);
        for (let i = first; i <= last; i++) { const c = bars[i], h = (c.v / mx) * (subH - 22), x = xOf(i), bw = Math.max(1, cw * 0.66); ctx.fillStyle = c.c >= c.o ? BULL : BEAR; ctx.fillRect(x - bw / 2, st + subH - h, bw, h); }
        axisTxt = fmtQ(mx);
      } else if (pane === 'cvd') { label = 'CVD'; lineSub(S.cvd, '#18e0f0'); }
      else if (pane === 'delta') { label = 'Delta'; histSub(S.delta, '#42da45', '#8a45b4'); }
      else { const p = this.plots[+pane.slice(5)]; label = p.name; p.type === 'hist' ? histSub(p.values, p.color, '#8a45b4') : lineSub(p.values, p.color); }
      ctx.restore();
      ctx.fillStyle = '#e0e0e0'; ctx.font = `600 12.5px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(label, 6, st + 16);
      ctx.fillStyle = bg; ctx.fillRect(plotW + ladW, st, axisW, subH); ctx.fillStyle = '#888'; ctx.font = `11px ${FONT}`; ctx.fillText(axisTxt, plotW + ladW + 8, st + 16);
    });

    /* ---------- price axis ---------- */
    const ax = plotW + ladW;
    ctx.fillStyle = bg; ctx.fillRect(ax, 0, axisW, mainH); ctx.fillStyle = '#2f2e31'; ctx.fillRect(ax, 0, 1, mainH);
    ctx.font = `12.5px ${FONT}`; ctx.fillStyle = '#dcdcdc'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let p = Math.ceil(lo / gs) * gs; p < hi; p += gs) { const y = yOf(p); if (y > 8 && y < mainH - 8) ctx.fillText(fmtP(p), ax + 9, y); }
    const ly = yOf(lastC.c), up = lastC.c >= lastC.o;
    if (ly > 0 && ly < mainH) {
      ctx.strokeStyle = up ? '#01d40366' : '#7a33bf88'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, ly); ctx.lineTo(plotW, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = up ? BULL : BEAR; ctx.fillRect(ax + 1, ly - 10, axisW, 20); ctx.fillStyle = up ? '#04140a' : '#fff'; ctx.font = `600 12.5px ${FONT}`; ctx.fillText(fmtP(lastC.c), ax + 7, ly);
      const ms = this.barMs();
      if (ms && this.replayIdx == null) { const left = Math.max(0, lastC.t + ms - Date.now()); ctx.fillStyle = '#888'; ctx.font = `10.5px ${FONT}`; const s = Math.floor(left / 1000); ctx.fillText(s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, ax + 7, ly + 18); }
    }
    // drawing price tags on axis for selected drawing
    const sd = this.selected();
    if (sd && !this.hidden) for (const pt of sd.pts.slice(0, 3)) { const y = yOf(pt.p); if (y < 0 || y > mainH) continue; ctx.fillStyle = '#62b156'; ctx.fillRect(ax + 1, y - 9, axisW, 18); ctx.fillStyle = '#0c1a0a'; ctx.font = `12px ${FONT}`; ctx.fillText(fmtP(pt.p), ax + 7, y); }

    /* ---------- time axis ---------- */
    ctx.fillStyle = bg; ctx.fillRect(0, H - timeH, W, timeH); ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, H - timeH, W, 1);
    ctx.fillStyle = '#d0d0d0'; ctx.font = `12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const every = Math.max(1, Math.ceil(90 / cw)), ms = this.barMs(), withSec = ms > 0 && ms < 60000;
    const tl = (t: number) => { const d = new Date(t); return (d.getHours() === 0 && d.getMinutes() === 0 && (!withSec || d.getSeconds() === 0)) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : withSec ? d.toTimeString().slice(0, 8) : d.toTimeString().slice(0, 5); };
    for (let i = first; i <= last; i++) if (i % every === 0) { const x = xOf(i); if (x > 30 && x < plotW - 30) ctx.fillText(tl(bars[i].t), x, H - timeH / 2); }

    /* ---------- crosshair ---------- */
    let hc = lastC;
    if (this.mouse && this.mouse.x < plotW && this.mouse.y < H - timeH) {
      const { x, y } = this.mouse, hi_ = Math.round(iOf(x)); if (hi_ >= 0 && hi_ < n) hc = bars[hi_];
      ctx.strokeStyle = '#8a8a8a'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H - timeH); if (y < mainH) { ctx.moveTo(0, y); ctx.lineTo(plotW, y); } ctx.stroke(); ctx.setLineDash([]);
      if (y < mainH) { ctx.fillStyle = '#d0d0d0'; ctx.fillRect(ax + 1, y - 10, axisW, 20); ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.font = `12.5px ${FONT}`; ctx.fillText(fmtP(pOf(y)), ax + 7, y); }
      const t = this.xToTime(x), lbl = new Date(t).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: withSec ? '2-digit' : undefined });
      ctx.font = `12px ${FONT}`; const tw = ctx.measureText(lbl).width + 14; ctx.fillStyle = '#d0d0d0'; ctx.fillRect(x - tw / 2, H - timeH + 1, tw, timeH - 1); ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.fillText(lbl, x, H - timeH / 2);
    }
    ctx.textAlign = 'left';

    /* ---------- legend & gauges (DOM) ---------- */
    if (this.cb.legend) {
      const col = hc.c >= hc.o ? '#42da45' : '#a66be0', dv = hc.b - hc.s;
      const plots = this.plots.map(p => `<span style="color:${p.color}">${p.name}</span>`).join('');
      const note = sym.volume === 'none' ? '<span class="note">Price-only feed — no real traded volume is available for this market.</span>' : hc.k ? '<span class="note">Older bars come from exchange candles (no tick-level footprint). Live bars carry full order flow.</span>' : '';
      this.cb.legend(`<span style="color:${col}">O ${fmtP(hc.o)}</span><span style="color:${col}">H ${fmtP(hc.h)}</span><span style="color:${col}">L ${fmtP(hc.l)}</span><span style="color:${col}">C ${fmtP(hc.c)}</span><span style="color:${col}">${(((hc.c / hc.o) - 1) * 100).toFixed(2)}%</span><span style="color:#ddd">V ${fmtQ(hc.v)}</span>${hc.est ? '' : `<span style="color:${dv >= 0 ? '#42da45' : '#ff3df5'}">Δ ${fmtQ(dv)}</span>`}${plots}${note}`);
    }
    this.cb.gauges?.(lastC.b - lastC.s, S.cvd[n - 1] || 0);
  }

  /* ================================================================ interaction */
  private handlers: [string, any, any?][] = [];
  private on(t: EventTarget, ev: string, f: any, opt?: any) { t.addEventListener(ev, f, opt); this.handlers.push([ev, f, t]); }
  private unbind() { for (const [ev, f, t] of this.handlers) (t as EventTarget).removeEventListener(ev, f); this.handlers = []; }

  private pos(e: MouseEvent) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private ptAt(x: number, y: number, e?: MouseEvent): Pt {
    let t = this.xToTime(x), p = this.G.pOf(y);
    if (this.opt.magnet && !(e && (e.ctrlKey || e.metaKey))) {
      const i = Math.round(this.G.iOf(x)), c = this.G.bars[i];
      if (c) { let best = p, bd = 14; for (const v of [c.o, c.h, c.l, c.c]) { const d = Math.abs(this.G.yOf(v) - y); if (d < bd) { bd = d; best = v; } } if (best !== p) { p = best; t = c.t; } }
    }
    return { t, p };
  }
  private hitTop(x: number, y: number): Drawing | null {
    if (this.hidden) return null;
    const V = this.dview();
    for (let i = this.drawings.length - 1; i >= 0; i--) { const d = this.drawings[i]; if (!d.hidden && hitDrawing(d, V, x, y) < 6) return d; }
    return null;
  }
  private handleAt(x: number, y: number): number {
    const s = this.selected(); if (!s || s.locked) return -1;
    const hs = handlesOf(s, this.dview());
    for (let i = 0; i < hs.length; i++) if (Math.hypot(hs[i][0] - x, hs[i][1] - y) < 8) return i;
    return -1;
  }
  private commit(d: Drawing) {
    const def = TOOL_MAP.get(d.type)!;
    if (def.init) def.init(d, this.dview());
    this.snapshot(); this.drawings.push(d); this.creating = null; this.createDown = null;
    this.changed(); this.select(d.id); this.setTool('cursor');
  }
  private newDrawing(type: string, pt: Pt): Drawing {
    const def = TOOL_MAP.get(type)!;
    return { id: uid(), type, pts: [pt], color: def.color || '#e6e6e6', width: def.width || 1.5, dash: 0, fill: def.fill, text: def.text };
  }

  private bindEvents() {
    const cv = this.cv;
    cv.tabIndex = 0;
    this.on(cv, 'mousedown', (e: MouseEvent) => {
      if (e.button !== 0 || !this.G.bars?.length) return;
      cv.focus();
      const { x, y } = this.pos(e), G = this.G;
      if (x > G.plotW) { this.drag = { kind: 'yaxis', x, y, off: this.view.off, cw: this.view.cw, y0: this.view.y || { mid: (G.hi + G.lo) / 2, span: G.hi - G.lo } }; return; }
      if (y > this.H - 24) { this.drag = { kind: 'xaxis', x, y, off: this.view.off, cw: this.view.cw, y0: { mid: 0, span: 0 } }; return; }
      if (y > G.mainH) { this.drag = { kind: 'pan', x, y, off: this.view.off, cw: this.view.cw, y0: this.view.y || { mid: (G.hi + G.lo) / 2, span: G.hi - G.lo } }; return; }
      const pt = this.ptAt(x, y, e);
      if (this.tool !== 'cursor') {
        const def = TOOL_MAP.get(this.tool); if (!def) return;
        if (def.n === 1) return this.commit(this.newDrawing(this.tool, pt));
        if (def.n === 0) { this.creating = this.newDrawing(this.tool, pt); this.createDown = { x, y }; return; }
        if (!this.creating) { this.creating = this.newDrawing(this.tool, pt); this.creating.pts.push({ ...pt }); this.createDown = { x, y }; return; }
        // subsequent click: fix floating point
        const c = this.creating; c.pts[c.pts.length - 1] = pt;
        if (def.n > 0 && c.pts.length >= def.n) return this.commit(c);
        c.pts.push({ ...pt }); this.dirty = true; return;
      }
      const hi = this.handleAt(x, y), s = this.selected();
      if (hi >= 0 && s) {
        this.snapshot();
        if (s.type === 'brush' || s.type === 'highlighter') this.drag = { kind: 'move', x, y, off: 0, cw: 0, y0: { mid: 0, span: 0 }, orig: s.pts.map(p => ({ ...p })), t0: pt.t, p0: G.pOf(y) };
        else this.drag = { kind: 'handle', x, y, off: 0, cw: 0, y0: { mid: 0, span: 0 }, hi };
        return;
      }
      const hit = this.hitTop(x, y);
      if (hit) {
        this.select(hit.id);
        if (!hit.locked) { this.snapshot(); this.drag = { kind: 'move', x, y, off: 0, cw: 0, y0: { mid: 0, span: 0 }, orig: hit.pts.map(p => ({ ...p })), t0: this.xToTime(x), p0: G.pOf(y) }; }
        return;
      }
      if (this.sel) this.select(null);
      this.drag = { kind: 'pan', x, y, off: this.view.off, cw: this.view.cw, y0: this.view.y || { mid: (G.hi + G.lo) / 2, span: G.hi - G.lo } };
      cv.style.cursor = 'grabbing';
    });
    this.on(window, 'mousemove', (e: MouseEvent) => {
      const m = this.pos(e), inside = m.x >= 0 && m.y >= 0 && m.x <= this.W && m.y <= this.H;
      const prevMouse = this.mouse; this.mouse = inside ? m : null;
      if (inside || prevMouse) this.dirty = true;
      const d = this.drag, G = this.G;
      if (d) {
        if (d.kind === 'yaxis') { const f = Math.exp((m.y - d.y) / 180); this.view.y = { mid: d.y0.mid, span: d.y0.span * f }; }
        else if (d.kind === 'xaxis') { this.view.cw = Math.max(1.2, Math.min(260, d.cw * Math.exp((m.x - d.x) / 160))); }
        else if (d.kind === 'pan') {
          this.view.off = Math.max(-(G.n - 3), Math.min(400, d.off + (m.x - d.x) / this.view.cw));
          if (this.view.y || Math.abs(m.y - d.y) > 6) { this.view.y = { mid: d.y0.mid + ((m.y - d.y) / G.mainH) * d.y0.span, span: d.y0.span }; }
        } else if (d.kind === 'move') {
          const s = this.selected(); if (s && d.orig) { const dt = this.xToTime(m.x) - d.t0!, dp = G.pOf(m.y) - d.p0!; s.pts = d.orig.map(p => ({ t: p.t + dt, p: p.p + dp })); this.dirty = true; }
        } else if (d.kind === 'handle') {
          const s = this.selected(); if (s) { const pt = this.ptAt(m.x, m.y, e), def = TOOL_MAP.get(s.type); if (def?.moveHandle) def.moveHandle(s, d.hi!, pt); else s.pts[d.hi!] = pt; this.dirty = true; }
        }
        return;
      }
      if (this.creating && inside) {
        const def = TOOL_MAP.get(this.creating.type)!, pt = this.ptAt(m.x, m.y, e);
        if (def.n === 0) { const lp = this.creating.pts[this.creating.pts.length - 1]; if (Math.hypot(this.timeToX(lp.t) - m.x, G.yOf(lp.p) - m.y) > 3) this.creating.pts.push(pt); }
        else this.creating.pts[this.creating.pts.length - 1] = pt;
        return;
      }
      if (inside && this.tool === 'cursor' && m.x < (G.plotW || 0) && m.y < (G.mainH || 0)) {
        cv.style.cursor = this.handleAt(m.x, m.y) >= 0 ? 'move' : this.hitTop(m.x, m.y) ? 'pointer' : 'default';
      } else if (inside && m.x >= (G.plotW || 0)) cv.style.cursor = 'ns-resize';
    });
    this.on(window, 'mouseup', (e: MouseEvent) => {
      const d = this.drag; this.drag = null;
      if (d && (d.kind === 'move' || d.kind === 'handle')) this.changed();
      if (this.tool === 'cursor') cv.style.cursor = 'default';
      if (this.creating && this.createDown) {
        const m = this.pos(e), def = TOOL_MAP.get(this.creating.type)!, moved = Math.hypot(m.x - this.createDown.x, m.y - this.createDown.y) > 6;
        if (def.n === 0) { if (this.creating.pts.length > 1) this.commit(this.creating); else this.creating = null; return; }
        if (moved && def.n === 2) return this.commit(this.creating);
        if (moved && def.n === 3 && this.creating.pts.length === 2) { this.creating.pts.push({ ...this.creating.pts[1] }); }
        this.createDown = null;
      }
    });
    this.on(cv, 'dblclick', (e: MouseEvent) => {
      if (this.creating) { const def = TOOL_MAP.get(this.creating.type)!; if (def.n === -1 && this.creating.pts.length > 2) { this.creating.pts.pop(); this.commit(this.creating); } return; }
      const { x, y } = this.pos(e);
      if (x > this.G.plotW) { this.resetY(); return; }
      if (!this.hitTop(x, y)) this.goLive();
    });
    this.on(cv, 'wheel', (e: WheelEvent) => {
      e.preventDefault(); const G = this.G; if (!G.bars) return;
      const { x } = this.pos(e), f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      if (e.ctrlKey || e.shiftKey || x > G.plotW) { const y0 = this.view.y || { mid: (G.hi + G.lo) / 2, span: G.hi - G.lo }; this.view.y = { mid: y0.mid, span: y0.span / f }; }
      else { const i = G.iOf(Math.min(x, G.plotW)), cw = Math.max(1.2, Math.min(260, this.view.cw * f)); this.view.cw = cw; const xNew = G.plotW - (this.opt.style === 'heatmap' ? 120 : Math.max(cw * 4, 60)) - (G.n - 1 - i) * cw; this.view.off += (x - xNew) / cw; }
      this.dirty = true;
    }, { passive: false });
    this.on(cv, 'mouseleave', () => { this.mouse = null; this.dirty = true; });
    this.on(cv, 'contextmenu', (e: MouseEvent) => { e.preventDefault(); const { x, y } = this.pos(e); const hit = this.hitTop(x, y); if (hit) this.select(hit.id); this.cb.context?.(e, this.G.pOf ? this.G.pOf(y) : 0); });
    this.on(cv, 'keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') { this.creating = null; this.setTool('cursor'); this.select(null); }
      else if ((e.key === 'Delete' || e.key === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSelected(); }
      else if (e.key === 'Enter' && this.creating) { const def = TOOL_MAP.get(this.creating.type)!; if (def.n === -1 && this.creating.pts.length > 2) { this.creating.pts.pop(); this.commit(this.creating); } }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redoDraw() : this.undoDraw(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); this.redoDraw(); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd' && this.sel) { e.preventDefault(); this.cloneSelected(); }
      else if (e.key === 'ArrowLeft') { this.view.off += 3; this.dirty = true; }
      else if (e.key === 'ArrowRight') { this.view.off = Math.max(-5, this.view.off - 3); this.dirty = true; }
      else if (e.key === 'ArrowUp' || e.key === '+') { this.view.cw = Math.min(260, this.view.cw * 1.15); this.dirty = true; }
      else if (e.key === 'ArrowDown' || e.key === '-') { this.view.cw = Math.max(1.2, this.view.cw / 1.15); this.dirty = true; }
    });
  }

  screenshot(): string { return this.cv.toDataURL('image/png'); }
}
