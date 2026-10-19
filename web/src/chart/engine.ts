/**
 * ChartEngine — canvas renderer + interaction for candles, footprint and liquidity heatmap,
 * order-flow overlays, custom indicator plots, paper-trading markers and drawing tools.
 *
 * Navigation (TradingView-style):
 *   wheel            zoom time around the mouse        shift+wheel / trackpad swipe  scroll time
 *   wheel on price   zoom price (turns auto-scale off) drag price axis               stretch price
 *   drag time axis   stretch time                      drag chart                    pan (vertical only when auto-scale is off)
 *   dbl-click chart  scroll to real-time               dbl-click price axis          auto-scale on
 *   + / -  zoom      ← / →  scroll                     Home  reset view              End  go to real-time
 * Public API used by the on-chart controls: zoomIn, zoomOut, scrollBars, fit, reset, goLive, setAutoScale.
 */
import type { Bar, BarSpec, ChartStyle, Drawing, FpMode, KBar, Overlays, Plot, Pt, SymbolInfo } from '../lib/types';
import { BarBuilder, buildSeries, type Series } from '../data/bars';
import { data, type MarketData } from '../data/client';
import { FONT, fmtQ, niceStep, uid } from '../lib/format';
import { TA } from '../lib/ta';
import { Painter, TOOL_MAP, handlesOf, hitDrawing, renderDrawing, type DView } from './drawings';
import type { PaperBroker } from '../lib/paper';

export interface EngineOpts {
  style: ChartStyle; ov: Overlays; spec: BarSpec; rowMult: number; bigUsd: number;
  acct: { size: number; risk: number }; magnet: boolean; fpMode?: FpMode;
}
export interface ViewState { live: boolean; auto: boolean }
export interface EngineCallbacks {
  drawings?(list: Drawing[]): void;
  select?(d: Drawing | null): void;
  tool?(t: string): void;
  context?(e: MouseEvent, price: number): void;
  legend?(html: string): void;
  gauges?(imb: number, cvd: number): void;
  view?(s: ViewState): void;
}

/* colour ramps — DeepDom purple asks, green bids */
const ramp = (stops: [number, number[]][]) => { const o: string[] = []; for (let i = 0; i < 64; i++) { const r = i / 63; let j = 0; while (j < stops.length - 2 && r > stops[j + 1][0]) j++; const [a, ca] = stops[j], [b, cb] = stops[j + 1], f = (r - a) / (b - a); o.push(`rgb(${ca.map((v, k) => Math.round(v + (cb[k] - v) * f)).join(',')})`); } return o; };
const HEAT_ASK = ramp([[0, [26, 26, 26]], [0.15, [31, 27, 41]], [0.35, [44, 28, 81]], [0.55, [77, 33, 129]], [0.75, [138, 69, 180]], [0.9, [193, 120, 244]], [1, [240, 210, 255]]]);
const HEAT_BID = ramp([[0, [26, 26, 26]], [0.2, [22, 36, 26]], [0.45, [20, 64, 36]], [0.7, [30, 120, 50]], [0.88, [70, 200, 80]], [1, [200, 255, 190]]]);
const BULL = '#01d403', BEAR = '#7a33bf', BEAR_HI = '#a66be0';
const MIN_CW = 1, MAX_CW = 280;
const STATS_ROW = 15;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const DEFAULT_CW: Record<ChartStyle, number> = { candles: 8, footprint: 110, heatmap: 4 };

export class ChartEngine {
  cv: HTMLCanvasElement; ctx: CanvasRenderingContext2D;
  W = 0; H = 0; dpr = 1;
  sym: SymbolInfo | null = null;
  md: MarketData | null = null;
  opt: EngineOpts;
  cb: EngineCallbacks = {};
  B: BarBuilder | null = null;
  klines: KBar[] = []; private kKey = '';
  /** cw = bar width px · off = bars scrolled into history (0 = live) · auto = price auto-scale */
  view = { cw: 8, off: 0, auto: true, y: null as null | { mid: number; span: number } };
  drawings: Drawing[] = [];
  sel: string | null = null;
  tool = 'cursor';
  plots: Plot[] = [];
  paper: PaperBroker | null = null;
  replayIdx: number | null = null;
  hidden = false; locked = false;
  mouse: { x: number; y: number } | null = null;
  hoverId: string | null = null;

  private unsub: (() => void) | null = null;
  private dirty = true; private raf = 0; private lastDraw = 0;
  private creating: Drawing | null = null; private createDown: { x: number; y: number } | null = null;
  private drag: null | { kind: 'pan' | 'yaxis' | 'xaxis' | 'move' | 'handle'; x: number; y: number; off: number; cw: number; y0: { mid: number; span: number }; orig?: Pt[]; hi?: number; t0?: number; p0?: number } = null;
  private undo: string[] = []; private redo: string[] = [];
  private G: any = {};
  private ro: ResizeObserver;
  private lastN = 0; private lastB: BarBuilder | null = null; private lastVS = '';

  constructor(cv: HTMLCanvasElement, opt: EngineOpts) {
    this.cv = cv; this.ctx = cv.getContext('2d')!; this.opt = opt;
    this.view.cw = DEFAULT_CW[opt.style];
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
    this.md = md; this.sym = sym; this.kKey = ''; this.klines = [];
    this.view = { cw: DEFAULT_CW[this.opt.style], off: 0, auto: true, y: null };
    this.unsub = md.on((e, d) => {
      if (e === 'snap') this.rebuild();
      else if (e === 'tk' && this.B) { for (const t of d) this.B.add(t); }
      this.dirty = true;
    });
    this.rebuild();
  }
  setOptions(o: Partial<EngineOpts>) {
    const prev = this.opt; this.opt = { ...this.opt, ...o };
    if ((o.spec && JSON.stringify(o.spec) !== JSON.stringify(prev.spec)) || (o.rowMult && o.rowMult !== prev.rowMult) || (o.bigUsd && o.bigUsd !== prev.bigUsd)) this.rebuild();
    if (o.style && o.style !== prev.style) this.reset();
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

  /* ================================================================ navigation API */
  private rpad(cw: number) {
    if (this.opt.style === 'heatmap') return 120;
    if (this.opt.style === 'footprint') return cw * 0.9 + 50;
    return Math.max(cw * 5, 70);
  }
  /** Zoom time by factor f keeping the bar under pixel x fixed (no x: right edge when live, else centre). */
  zoomAt(f: number, x?: number) {
    const G = this.G, n = G.n || 0, plotW = G.plotW || this.W, v = this.view;
    const cw = clamp(v.cw * f, MIN_CW, MAX_CW);
    if (!n || (x === undefined && Math.abs(v.off) <= 0.5)) { v.cw = cw; if (x === undefined) v.off = 0; this.dirty = true; return; }
    // positions from the *current* view state (G may be one frame old)
    const rp0 = this.rpad(v.cw), ax = x ?? plotW / 2;
    const i = n - 1 - (plotW - rp0 + v.off * v.cw - ax) / v.cw;
    const rp1 = this.rpad(cw);
    v.cw = cw;
    v.off = (ax - plotW + rp1 + (n - 1 - i) * cw) / cw;
    this.dirty = true;
  }
  zoomIn() { this.zoomAt(1.25); }
  zoomOut() { this.zoomAt(1 / 1.25); }
  /** k > 0 scrolls back into history, k < 0 towards real-time. */
  scrollBars(k: number) { this.view.off += k; this.dirty = true; }
  goLive() { this.view.off = 0; this.view.auto = true; this.view.y = null; this.dirty = true; }
  reset() { this.view = { cw: DEFAULT_CW[this.opt.style], off: 0, auto: true, y: null }; this.dirty = true; }
  fit() {
    const n = this.bars.length, G = this.G; if (!n || !G.plotW) return;
    this.view.cw = clamp((G.plotW - 60) / n, MIN_CW, MAX_CW); this.view.off = 0; this.view.auto = true; this.view.y = null; this.dirty = true;
  }
  setAutoScale(on: boolean) {
    this.view.auto = on;
    this.view.y = on ? null : (this.G.hi != null ? { mid: (this.G.hi + this.G.lo) / 2, span: this.G.hi - this.G.lo } : null);
    this.dirty = true;
  }
  resetY() { this.setAutoScale(true); }

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

  /* ================================================================ geometry */
  private geom() {
    const panes = this.subPanes();
    const axisW = 78, ladW = this.opt.style === 'heatmap' && this.sym?.hasBook ? 36 : 0, timeH = 24;
    const statsH = this.opt.ov.stats && this.opt.style !== 'heatmap' ? STATS_ROW * 4 + 2 : 0;
    const avail = this.H - timeH - statsH;
    const subH = panes.length ? Math.max(56, Math.round(avail * (panes.length > 2 ? 0.11 : 0.15))) : 0;
    const mainH = Math.max(60, avail - subH * panes.length), plotW = Math.max(60, this.W - axisW - ladW);
    return { axisW, ladW, timeH, subH, statsH, mainH, plotW, panes };
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

  /* ================================================================ render */
  private draw() {
    const ctx = this.ctx, W = this.W, H = this.H; if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const sym = this.sym, bars = this.bars, n = bars.length;
    const style = this.opt.style, fp = style === 'footprint', heat = style === 'heatmap', ov = this.opt.ov;
    const bg = fp ? '#151521' : '#1a1a1a';
    const bgG = ctx.createLinearGradient(0, 0, 0, H); bgG.addColorStop(0, fp ? '#191930' : '#1e1e21'); bgG.addColorStop(1, bg);
    ctx.fillStyle = bgG; ctx.fillRect(0, 0, W, H);
    if (!sym || !n) {
      ctx.fillStyle = '#777'; ctx.font = `14px ${FONT}`; ctx.textAlign = 'center';
      ctx.fillText(!sym ? 'Loading symbols…' : this.md?.ready ? (sym.volume === 'none' ? 'Waiting for the first price…' : 'Waiting for trades…') : 'Connecting to data feed…', W / 2, H / 2);
      ctx.textAlign = 'left'; this.emitView(true); return;
    }
    const { axisW, ladW, timeH, subH, statsH, mainH, plotW, panes } = this.geom();

    /* ---------- keep the view sane (prevents "lost" charts) ---------- */
    // when scrolled back, new bars must not push the view: keep the same bars on screen
    if (this.lastB === this.B && n > this.lastN && n - this.lastN < 10 && this.view.off > 0.5) this.view.off += n - this.lastN;
    this.lastB = this.B; this.lastN = n;
    const cw = (this.view.cw = clamp(this.view.cw, MIN_CW, MAX_CW));
    const rpad = this.rpad(cw);
    const offMin = Math.min(0, (rpad - plotW / 2) / cw);             // empty future space: at most half the screen
    const offMax = (rpad - plotW / 2) / cw + (n - 1);                // oldest bar may not pass the middle of the screen
    this.view.off = offMin > offMax ? 0 : clamp(this.view.off, offMin, offMax);
    if (!isFinite(this.view.off)) this.view.off = 0;
    const off = this.view.off;
    const xOf = (i: number) => plotW - rpad - (n - 1 - i) * cw + off * cw;
    const iOf = (x: number) => n - 1 - (plotW - rpad + off * cw - x) / cw;
    const first = Math.max(0, Math.floor(iOf(0)) - 1), last = Math.min(n - 1, Math.ceil(iOf(plotW)) + 1);

    let vlo = Infinity, vhi = -Infinity, iHi = last, iLo = last;
    for (let i = first; i <= last; i++) { if (bars[i].l < vlo) { vlo = bars[i].l; iLo = i; } if (bars[i].h > vhi) { vhi = bars[i].h; iHi = i; } }
    if (!isFinite(vlo)) { vlo = bars[n - 1].l; vhi = bars[n - 1].h; }
    let lo: number, hi: number;
    const y = this.view.y;
    if (!this.view.auto && y && isFinite(y.mid) && y.span > 0 && isFinite(y.span) && !(vhi < y.mid - y.span / 2 || vlo > y.mid + y.span / 2)) {
      lo = y.mid - y.span / 2; hi = y.mid + y.span / 2;
    } else {
      if (!this.view.auto) { this.view.auto = true; this.view.y = null; }   // price left the screen → snap back
      const pad = Math.max((vhi - vlo) * 0.1, sym.tick * 8); lo = vlo - pad; hi = vhi + pad;
    }
    const yOf = (p: number) => ((hi - p) / (hi - lo)) * mainH, pOf = (yy: number) => hi - (yy / mainH) * (hi - lo);
    const row = this.rowSize(), pxRow = (mainH * row) / (hi - lo);
    this.G = { xOf, iOf, yOf, pOf, plotW, mainH, bars, n, lo, hi, first, last, cw };
    const fmtP = (p: number) => p.toFixed(sym.dec);
    const ms = this.barMs();

    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, plotW, mainH); ctx.clip();

    /* ---------- grid, session separators, watermark ---------- */
    const gs = niceStep((hi - lo) / 9);
    ctx.strokeStyle = fp ? '#1e1e30' : '#232326'; ctx.lineWidth = 1;
    for (let p = Math.ceil(lo / gs) * gs; p < hi; p += gs) { const yy = Math.round(yOf(p)) + 0.5; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); }
    const every = Math.max(1, Math.ceil(110 / cw));
    for (let i = first; i <= last; i++) if (i % every === 0) { const x = Math.round(xOf(i)) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, mainH); ctx.stroke(); }
    if (!ms || ms < 86_400_000) {
      ctx.strokeStyle = '#3b3b48'; ctx.setLineDash([4, 4]);
      for (let i = Math.max(1, first); i <= last; i++) if (new Date(bars[i].t).getDate() !== new Date(bars[i - 1].t).getDate()) { const x = Math.round(xOf(i) - cw / 2) + 0.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
      ctx.setLineDash([]);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(255,255,255,0.035)'; ctx.font = `700 ${Math.min(96, plotW / 7)}px ${FONT}`; ctx.fillText(sym.id, plotW / 2, mainH / 2);
    ctx.fillStyle = 'rgba(255,255,255,0.05)'; ctx.font = `14px ${FONT}`; ctx.fillText(`${sym.venues} · FlowScope`, plotW / 2, mainH / 2 + Math.min(60, plotW / 12));
    ctx.textAlign = 'left';

    /* ---------- liquidity heatmap ---------- */
    if (heat && this.md) {
      const cols = this.md.heat, tEnd = this.replayIdx != null ? bars[n - 1].t + (ms || 1000) : Infinity;
      const tLo = this.xToTime(0), tHi = this.xToTime(plotW);
      let a = 0, b = cols.length - 1; while (a <= b) { const m = (a + b) >> 1; if (cols[m].t < tLo) a = m + 1; else b = m - 1; }
      const i0 = Math.max(0, a - 1);
      let mx = 1; for (let i = i0; i < cols.length && cols[i].t <= tHi && cols[i].t <= tEnd; i++) for (const l of cols[i].l) if (l[1] > mx) mx = l[1];
      mx *= 0.5;
      const rowH = Math.max(1, pxRow);
      for (let i = i0; i < cols.length && cols[i].t <= tHi && cols[i].t <= tEnd; i++) {
        const c = cols[i], x = this.timeToX(c.t), nx = i + 1 < cols.length ? this.timeToX(cols[i + 1].t) : x + Math.max(1, cw / 2);
        const w = Math.max(1, Math.min(nx - x, cw * 4) + 0.6);
        for (const [p, q, s] of c.l) {
          const yy = yOf(p + row); if (yy > mainH || yy + rowH < 0) continue;
          const ix = Math.min(63, Math.floor(Math.pow(Math.min(1, q / mx), 0.55) * 63)); if (ix < 4) continue;
          ctx.fillStyle = s > 0 ? HEAT_BID[ix] : HEAT_ASK[ix]; ctx.fillRect(x, yy, w, rowH + 0.6);
        }
      }
      ctx.lineWidth = 1.4;
      for (let i = Math.max(first, 1); i <= last; i++) { const p0 = bars[i - 1], c = bars[i]; ctx.strokeStyle = c.c >= p0.c ? BULL : '#8a45b4'; ctx.beginPath(); ctx.moveTo(xOf(i - 1), yOf(p0.c)); ctx.lineTo(xOf(i), yOf(c.c)); ctx.stroke(); }
      for (let i = first; i <= last; i++) { if (cw < 3 && i % 2) continue; const c = bars[i]; ctx.fillStyle = c.b >= c.s ? '#7be36f' : '#b27ae6'; ctx.beginPath(); ctx.arc(xOf(i), yOf(c.c), 1.8, 0, 7); ctx.fill(); }
      if (ov.bubbles) for (let i = first; i <= last; i++) for (const t of bars[i].big) this.bubble(xOf(i), yOf(t[1]), t[2], t[1], t[3], true);
    }

    /* ---------- order-flow zones behind price ---------- */
    if (ov.imbl && !heat) this.drawImbalanceZones(bars, first, last, xOf, yOf, row, plotW, cw);
    if (ov.walls && !heat && this.md && sym.hasBook) this.drawWalls(yOf, plotW, mainH, row, xOf(n - 1));

    /* ---------- candles ---------- */
    if (style === 'candles') {
      for (let i = first; i <= last; i++) {
        const c = bars[i], x = Math.round(xOf(i)), up = c.c >= c.o, bw = Math.max(1, Math.round(cw * 0.7) | 1);
        ctx.fillStyle = up ? BULL : BEAR;
        ctx.fillRect(x, Math.round(yOf(c.h)), 1, Math.max(1, Math.round(yOf(c.l) - yOf(c.h))));
        const y1 = Math.round(yOf(Math.max(c.o, c.c))), y2 = Math.round(yOf(Math.min(c.o, c.c)));
        ctx.fillRect(x - (bw >> 1), y1, bw, Math.max(1, y2 - y1));
        if (bw >= 5 && y2 - y1 > 2) { ctx.fillStyle = up ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.07)'; ctx.fillRect(x - (bw >> 1), y1, Math.max(1, bw >> 2), y2 - y1); }
      }
      if (ov.bubbles) for (let i = first; i <= last; i++) {
        let bb: any = null, bs: any = null;
        for (const t of bars[i].big) { if (t[3] > 0) { if (!bb || t[2] > bb[2]) bb = t; } else if (!bs || t[2] > bs[2]) bs = t; }
        for (const t of [bb, bs]) if (t) this.bubble(xOf(i), yOf(t[1]), t[2], t[1], t[3], false);
      }
    }

    /* ---------- footprint ---------- */
    if (fp) this.drawFootprint(bars, first, last, xOf, yOf, row, pxRow, cw);

    /* ---------- overlays ---------- */
    const S = buildSeries(bars);
    const line = (v: (number | null)[], col: string, w = 1.5, dash?: number[]) => {
      ctx.strokeStyle = col; ctx.lineWidth = w; ctx.setLineDash(dash || []); ctx.beginPath(); let st = false;
      for (let i = first; i <= last; i++) { const yy = v[i]; if (yy == null || !isFinite(yy)) { st = false; continue; } st ? ctx.lineTo(xOf(i), yOf(yy)) : ctx.moveTo(xOf(i), yOf(yy)); st = true; }
      ctx.stroke(); ctx.setLineDash([]); ctx.lineWidth = 1;
    };
    if (ov.vwap) {
      line(S.vwap, '#ffffff', 1.6); const sd = TA.stdev(S.close, 50);
      line(S.vwap.map((v, i) => sd[i] != null ? v + sd[i]! : null), '#ffffff55', 1, [4, 4]); line(S.vwap.map((v, i) => sd[i] != null ? v - sd[i]! : null), '#ffffff55', 1, [4, 4]);
      this.edgeTag(plotW, yOf(S.vwap[last]), 'VWAP', '#e6e6e6', '#111');
    }
    if (ov.visp || ov.dlyp) this.drawProfile(bars, first, last, n, yOf, row, pxRow, plotW);
    for (const p of this.plots) if (p.pane !== 'sub') {
      if (p.type === 'dots') { ctx.fillStyle = p.color; for (let i = first; i <= last; i++) { const v = p.values[i]; if (v == null) continue; const x = xOf(i), yy = yOf(v); ctx.beginPath(); ctx.moveTo(x, yy - 6); ctx.lineTo(x + 5, yy); ctx.lineTo(x, yy + 6); ctx.lineTo(x - 5, yy); ctx.closePath(); ctx.globalAlpha = 0.9; ctx.fill(); ctx.globalAlpha = 1; } }
      else line(p.values, p.color, 1.5);
    }

    /* ---------- visible high / low markers ---------- */
    if (!heat && last - first > 3) {
      ctx.font = `11px ${FONT}`; ctx.fillStyle = '#a0a0a8'; ctx.textBaseline = 'middle';
      const mark = (i: number, p: number, dy: number) => { const x = xOf(i), yy = yOf(p) + dy; const s = fmtP(p), w = ctx.measureText(s).width; const left = x + w + 22 > plotW; ctx.strokeStyle = '#6a6a72'; ctx.beginPath(); ctx.moveTo(x, yy); ctx.lineTo(left ? x - 12 : x + 12, yy); ctx.stroke(); ctx.textAlign = left ? 'right' : 'left'; ctx.fillText(s, left ? x - 15 : x + 15, yy); };
      if (yOf(vhi) > 10) mark(iHi, vhi, -6);
      if (yOf(vlo) < mainH - 10) mark(iLo, vlo, 6);
      ctx.textAlign = 'left';
    }

    /* ---------- paper trading ---------- */
    const lastC = bars[n - 1];
    const tag = (x: number, yy: number, s: string, b: string) => { ctx.font = `12px ${FONT}`; const w = ctx.measureText(s).width + 12; ctx.fillStyle = b; ctx.fillRect(x, yy - 9, w, 18); ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(s, x + 6, yy); };
    if (this.paper && this.paper.sym === sym.id) {
      const P = this.paper;
      if (P.pos.qty) { const yy = yOf(P.pos.avg), pl = (lastC.c - P.pos.avg) * P.pos.qty; ctx.strokeStyle = pl >= 0 ? BULL : '#b27ae6'; ctx.setLineDash([6, 3]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]); tag(plotW - 240, yy, `${P.pos.qty > 0 ? 'LONG' : 'SHORT'} ${Math.abs(P.pos.qty)} @ ${fmtP(P.pos.avg)}  ${pl >= 0 ? '+' : ''}${pl.toFixed(2)}`, pl >= 0 ? '#0e5b0d' : '#4a1f6f'); }
      for (const o of P.orders) { const yy = yOf(o.px); ctx.strokeStyle = o.side > 0 ? '#42da45' : '#a66be0'; ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); tag(plotW - 180, yy, `${o.type.toUpperCase()} ${o.side > 0 ? 'BUY' : 'SELL'} ${o.qty} @ ${fmtP(o.px)}`, o.side > 0 ? '#0e5b0d' : '#4a1f6f'); }
    }

    /* ---------- drawings ---------- */
    if (!this.hidden) {
      const V = this.dview(), painter = new Painter(ctx);
      // selected drawing last so its info card sits on top
      for (const d of this.drawings) if (!d.hidden && d.id !== this.sel) renderDrawing(painter, d, V, { sel: false, hover: d.id === this.hoverId });
      const sd0 = this.selected(); if (sd0 && !sd0.hidden) renderDrawing(painter, sd0, V, { sel: true, hover: false });
      if (this.creating) renderDrawing(painter, this.creating, V, { sel: false, hover: true });
      const s = this.selected();
      if (s) for (const [hx, hy] of handlesOf(s, V)) { ctx.fillStyle = '#1a1a1a'; ctx.strokeStyle = s.locked ? '#888' : '#7be36f'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fill(); ctx.stroke(); ctx.lineWidth = 1; }
    }
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
      for (const [k, [q, s]] of lv) { if (k % step) continue; const yy = yOf((k + 0.5) * row); if (yy < 6 || yy > mainH - 6) continue; ctx.globalAlpha = 0.35 + 0.65 * Math.min(1, (q / mx) * 2); ctx.fillStyle = s > 0 ? '#1aa51a' : '#6b2fb3'; ctx.fillRect(lx, yy - 6.5, 4 + Math.min(1, q / mx) * 30, 13); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillText(fmtQ(q), lx + 3, yy); }
    }
    const ax = plotW + ladW;

    /* ---------- bar statistics strip ---------- */
    if (statsH) {
      const st = mainH;
      ctx.fillStyle = '#141416'; ctx.fillRect(0, st, W, statsH); ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, st, W, 1);
      const pct = S.delta.map((d, i) => S.volume[i] ? (d / S.volume[i]) * 100 : 0), big = S.bigBuy.map((b, i) => b - S.bigSell[i]);
      const rows: [string, number[], boolean][] = [['Volume', S.volume, false], ['Delta', S.delta, true], ['Delta %', pct, true], ['Big Δ', big, true]];
      ctx.save(); ctx.beginPath(); ctx.rect(0, st + 1, plotW, statsH - 1); ctx.clip();
      ctx.font = `10.5px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      rows.forEach(([, v, signed], r) => {
        let mx = 1e-12; for (let i = first; i <= last; i++) mx = Math.max(mx, Math.abs(v[i]));
        const yy = st + 1 + r * STATS_ROW;
        for (let i = first; i <= last; i++) {
          const a = Math.min(1, Math.abs(v[i]) / mx), x = xOf(i) - cw / 2 + 0.5, w = Math.max(1, cw - 1);
          ctx.fillStyle = !signed ? `rgba(190,190,200,${0.05 + 0.45 * a})` : v[i] >= 0 ? `rgba(1,212,3,${0.06 + 0.6 * a})` : `rgba(138,69,180,${0.08 + 0.7 * a})`;
          ctx.fillRect(x, yy, w, STATS_ROW - 1);
          if (cw >= 34) { ctx.fillStyle = a > 0.55 ? '#fff' : '#cfcfcf'; ctx.fillText(r === 2 ? `${v[i].toFixed(0)}%` : fmtQ(v[i]), xOf(i), yy + STATS_ROW / 2); }
        }
      });
      ctx.restore();
      ctx.fillStyle = '#141416'; ctx.fillRect(ax, st + 1, axisW, statsH - 1);
      ctx.font = `11px ${FONT}`; ctx.textAlign = 'left'; ctx.fillStyle = '#9a9aa2';
      rows.forEach(([name], r) => ctx.fillText(name, ax + 8, st + 1 + r * STATS_ROW + STATS_ROW / 2));
    }

    /* ---------- sub panes ---------- */
    panes.forEach((pane, pi) => {
      const st = mainH + statsH + pi * subH; ctx.fillStyle = bg; ctx.fillRect(0, st, plotW + ladW, subH); ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, st, W, 1);
      ctx.save(); ctx.beginPath(); ctx.rect(0, st + 1, plotW, subH - 1); ctx.clip();
      let label = '', axisTxt = '';
      const lineSub = (v: (number | null)[], col: string, fill = false) => {
        let a = Infinity, b = -Infinity; for (let i = first; i <= last; i++) { const yy = v[i]; if (yy != null && isFinite(yy)) { a = Math.min(a, yy); b = Math.max(b, yy); } } if (!isFinite(a)) return; if (a === b) { a -= 1; b += 1; }
        const Y = (q: number) => st + 8 + ((b - q) / (b - a)) * (subH - 16);
        ctx.beginPath(); let s0 = false, x0 = 0, xl = 0; for (let i = first; i <= last; i++) { const yy = v[i]; if (yy == null) continue; const x = xOf(i); if (!s0) x0 = x; xl = x; s0 ? ctx.lineTo(x, Y(yy)) : ctx.moveTo(x, Y(yy)); s0 = true; }
        ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.stroke(); ctx.lineWidth = 1;
        if (fill && s0) { ctx.lineTo(xl, st + subH); ctx.lineTo(x0, st + subH); ctx.closePath(); const g = ctx.createLinearGradient(0, st, 0, st + subH); g.addColorStop(0, col + '44'); g.addColorStop(1, col + '00'); ctx.fillStyle = g; ctx.fill(); }
        axisTxt = fmtQ(v[last] ?? 0);
      };
      const histSub = (v: (number | null)[], pos: string, neg: string) => { let m = 0; for (let i = first; i <= last; i++) { const yy = v[i]; if (yy != null) m = Math.max(m, Math.abs(yy)); } const mid = st + subH / 2; ctx.fillStyle = '#2a2a2e'; ctx.fillRect(0, mid, plotW, 1); for (let i = first; i <= last; i++) { const yy = v[i]; if (yy == null) continue; const h = (yy / (m || 1)) * (subH / 2 - 6); ctx.fillStyle = yy >= 0 ? pos : neg; ctx.fillRect(xOf(i) - Math.max(0.5, cw * 0.35), Math.min(mid, mid - h), Math.max(1, cw * 0.7), Math.abs(h)); } axisTxt = fmtQ(v[last] ?? 0); };
      if (pane === 'volume') {
        label = 'Volume'; let mx = 1; for (let i = first; i <= last; i++) mx = Math.max(mx, bars[i].v);
        for (let i = first; i <= last; i++) {
          const c = bars[i], h = (c.v / mx) * (subH - 22), x = xOf(i), bw = Math.max(1, cw * 0.7), base = st + subH;
          if (c.est || c.v <= 0) { ctx.fillStyle = c.c >= c.o ? BULL : BEAR; ctx.fillRect(x - bw / 2, base - h, bw, h); continue; }
          const hb = h * (c.b / c.v);                         // stacked: buy volume (bottom) + sell volume (top)
          ctx.fillStyle = 'rgba(1,212,3,0.85)'; ctx.fillRect(x - bw / 2, base - hb, bw, hb);
          ctx.fillStyle = 'rgba(138,69,180,0.9)'; ctx.fillRect(x - bw / 2, base - h, bw, h - hb);
        }
        axisTxt = fmtQ(mx);
      } else if (pane === 'cvd') { label = 'CVD'; lineSub(S.cvd, '#18e0f0', true); }
      else if (pane === 'delta') { label = 'Delta'; histSub(S.delta, '#42da45', '#8a45b4'); }
      else { const p = this.plots[+pane.slice(5)]; label = p.name; p.type === 'hist' ? histSub(p.values, p.color, '#8a45b4') : lineSub(p.values, p.color); }
      ctx.restore();
      ctx.fillStyle = '#e0e0e0'; ctx.font = `600 12px ${FONT}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillText(label, 6, st + 15);
      ctx.fillStyle = bg; ctx.fillRect(plotW + ladW, st + 1, axisW, subH - 1); ctx.fillStyle = '#9a9a9a'; ctx.font = `11px ${FONT}`; ctx.fillText(axisTxt, plotW + ladW + 8, st + 16);
    });

    /* ---------- price axis ---------- */
    ctx.fillStyle = bg; ctx.fillRect(ax, 0, axisW, mainH); ctx.fillStyle = '#2f2e31'; ctx.fillRect(ax, 0, 1, mainH);
    ctx.font = `12px ${FONT}`; ctx.fillStyle = '#c8c8cc'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    for (let p = Math.ceil(lo / gs) * gs; p < hi; p += gs) { const yy = yOf(p); if (yy > 8 && yy < mainH - 8) ctx.fillText(fmtP(p), ax + 9, yy); }
    const up = lastC.c >= lastC.o, lyRaw = yOf(lastC.c), ly = clamp(lyRaw, 10, mainH - 10);
    if (lyRaw >= 0 && lyRaw <= mainH) { ctx.strokeStyle = up ? '#01d40388' : '#a66be099'; ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.moveTo(0, lyRaw); ctx.lineTo(plotW, lyRaw); ctx.stroke(); ctx.setLineDash([]); }
    ctx.fillStyle = up ? BULL : BEAR;
    ctx.beginPath(); ctx.moveTo(ax - 5, ly); ctx.lineTo(ax + 1, ly - 10); ctx.lineTo(ax + axisW, ly - 10); ctx.lineTo(ax + axisW, ly + 10); ctx.lineTo(ax + 1, ly + 10); ctx.closePath(); ctx.fill();
    ctx.fillStyle = up ? '#04140a' : '#fff'; ctx.font = `600 12px ${FONT}`;
    ctx.fillText((lyRaw < 0 ? '▲ ' : lyRaw > mainH ? '▼ ' : '') + fmtP(lastC.c), ax + 6, ly);
    if (ms && this.replayIdx == null) { const s = Math.floor(Math.max(0, lastC.t + ms - Date.now()) / 1000); ctx.fillStyle = up ? BULL : BEAR_HI; ctx.font = `10.5px ${FONT}`; ctx.fillText(s >= 3600 ? `${Math.floor(s / 3600)}h${String(Math.floor(s / 60) % 60).padStart(2, '0')}m` : `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`, ax + 8, ly + (ly > mainH - 30 ? -19 : 19)); }
    const sd = this.selected();
    if (sd && !this.hidden) for (const pt of sd.pts.slice(0, 3)) { const yy = yOf(pt.p); if (yy < 0 || yy > mainH) continue; ctx.fillStyle = '#62b156'; ctx.fillRect(ax + 1, yy - 9, axisW, 18); ctx.fillStyle = '#0c1a0a'; ctx.font = `12px ${FONT}`; ctx.fillText(fmtP(pt.p), ax + 7, yy); }
    if (!this.view.auto) { ctx.fillStyle = '#ffb020'; ctx.font = `10px ${FONT}`; ctx.fillText('manual scale', ax + 8, mainH - 9); }

    /* ---------- time axis ---------- */
    ctx.fillStyle = bg; ctx.fillRect(0, H - timeH, W, timeH); ctx.fillStyle = '#3a3a3a'; ctx.fillRect(0, H - timeH, W, 1);
    ctx.fillStyle = '#c8c8cc'; ctx.font = `12px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const withSec = ms > 0 && ms < 60000;
    const tl = (t: number, prev?: number) => { const d = new Date(t); if (prev != null && new Date(prev).getDate() !== d.getDate()) return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); return withSec ? d.toTimeString().slice(0, 8) : ms >= 86_400_000 ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }) : d.toTimeString().slice(0, 5); };
    let prevT: number | undefined;
    for (let i = first; i <= last; i++) if (i % every === 0) { const x = xOf(i); if (x > 30 && x < plotW - 30) { const isDay = prevT != null && new Date(prevT).getDate() !== new Date(bars[i].t).getDate(); ctx.font = `${isDay ? '600 ' : ''}12px ${FONT}`; ctx.fillText(tl(bars[i].t, prevT), x, H - timeH / 2); } prevT = bars[i].t; }

    /* ---------- crosshair ---------- */
    let hc = lastC, hp: number | null = null;
    if (this.mouse && this.mouse.x < plotW && this.mouse.y < H - timeH && !this.drag) {
      const { x, y: my } = this.mouse, hi_ = Math.round(iOf(x)); if (hi_ >= 0 && hi_ < n) hc = bars[hi_];
      const sx = hi_ >= 0 && hi_ < n ? xOf(hi_) : x;      // snap vertical line to the bar centre
      ctx.strokeStyle = '#9a9aa2'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, H - timeH); if (my < mainH) { ctx.moveTo(0, my); ctx.lineTo(plotW, my); } ctx.stroke(); ctx.setLineDash([]);
      if (my < mainH) { hp = pOf(my); ctx.fillStyle = '#e0e0e4'; ctx.fillRect(ax + 1, my - 10, axisW, 20); ctx.fillStyle = '#111'; ctx.textAlign = 'left'; ctx.font = `12px ${FONT}`; ctx.fillText(fmtP(hp), ax + 7, my); }
      const t = hi_ >= 0 && hi_ < n ? bars[hi_].t : this.xToTime(x), lbl = new Date(t).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: withSec ? '2-digit' : undefined });
      ctx.font = `12px ${FONT}`; const tw = ctx.measureText(lbl).width + 16; ctx.fillStyle = '#e0e0e4'; ctx.fillRect(clamp(sx - tw / 2, 0, plotW - tw), H - timeH + 1, tw, timeH - 1); ctx.fillStyle = '#111'; ctx.textAlign = 'center'; ctx.fillText(lbl, clamp(sx, tw / 2, plotW - tw / 2), H - timeH / 2);
    }
    ctx.textAlign = 'left';

    /* ---------- legend & gauges ---------- */
    if (this.cb.legend) {
      const col = hc.c >= hc.o ? '#42da45' : BEAR_HI, dv = hc.b - hc.s;
      const plots = this.plots.map(p => `<span style="color:${p.color}">${p.name}</span>`).join('');
      let cell = '';
      if (hp != null && hc.fp.size) { const k = Math.round(hp / row), c = hc.fp.get(k); if (c) cell = `<span style="color:#ffd23f">@ ${fmtP(k * row)}  <span style="color:${BEAR_HI}">${fmtQ(c[0])}</span> × <span style="color:#42da45">${fmtQ(c[1])}</span>  Δ ${fmtQ(c[1] - c[0])}</span>`; }
      const note = sym.volume === 'none' ? '<span class="note">Price-only feed — no real traded volume is available for this market.</span>' : hc.k ? '<span class="note">Older bars come from exchange candles (no tick-level footprint). Live bars carry full order flow.</span>' : '';
      this.cb.legend(`<span style="color:${col}">O ${fmtP(hc.o)}</span><span style="color:${col}">H ${fmtP(hc.h)}</span><span style="color:${col}">L ${fmtP(hc.l)}</span><span style="color:${col}">C ${fmtP(hc.c)}</span><span style="color:${col}">${(((hc.c / hc.o) - 1) * 100).toFixed(2)}%</span><span style="color:#ddd">V ${fmtQ(hc.v)}</span>${hc.est ? '' : `<span style="color:${dv >= 0 ? '#42da45' : '#ff3df5'}">Δ ${fmtQ(dv)}</span>`}${cell}${plots}${note}`);
    }
    this.cb.gauges?.(lastC.b - lastC.s, S.cvd[n - 1] || 0);
    this.emitView(Math.abs(this.view.off) <= 0.5);
  }

  private emitView(live: boolean) {
    const s = `${live}|${this.view.auto}`;
    if (s !== this.lastVS) { this.lastVS = s; this.cb.view?.({ live, auto: this.view.auto }); }
  }

  /* ---------- render helpers ---------- */
  private bubble(x: number, y: number, q: number, p: number, side: number, solid: boolean) {
    const ctx = this.ctx, r = Math.min(solid ? 24 : 26, (solid ? 3 : 5) + Math.sqrt((q * p) / this.opt.bigUsd) * (solid ? 4.2 : 4));
    const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.1, x, y, r);
    if (side > 0) { g.addColorStop(0, solid ? '#b8ff9c' : 'rgba(120,255,110,0.55)'); g.addColorStop(1, solid ? '#2fa82c' : 'rgba(20,200,20,0.18)'); }
    else { g.addColorStop(0, solid ? '#e3c2ff' : 'rgba(210,160,255,0.55)'); g.addColorStop(1, solid ? '#8a45b4' : 'rgba(138,69,180,0.22)'); }
    ctx.globalAlpha = solid ? 0.85 : 1; ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
    if (!solid) { ctx.strokeStyle = side > 0 ? '#14c814' : '#8a45b4'; ctx.lineWidth = 1.6; ctx.stroke(); ctx.lineWidth = 1; }
    if (r >= 12) { ctx.fillStyle = '#fff'; ctx.font = `600 ${Math.min(12, r * 0.6)}px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(fmtQ(q), x, y + 0.5); ctx.textAlign = 'left'; }
  }

  private edgeTag(plotW: number, y: number, s: string, bgc: string, fg: string) {
    if (!isFinite(y)) return; const ctx = this.ctx;
    ctx.font = `600 10.5px ${FONT}`; const w = ctx.measureText(s).width + 10;
    ctx.fillStyle = bgc; ctx.fillRect(plotW - w - 2, y - 8, w, 16); ctx.fillStyle = fg; ctx.textBaseline = 'middle'; ctx.textAlign = 'left'; ctx.fillText(s, plotW - w + 3, y);
  }

  private drawFootprint(bars: Bar[], first: number, last: number, xOf: (i: number) => number, yOf: (p: number) => number, row: number, pxRow: number, cw: number) {
    const ctx = this.ctx, mode = this.opt.fpMode || 'ba';
    const mul = Math.max(1, Math.ceil(16 / pxRow)), rowPx = pxRow * mul, colW = cw * 0.88, showTxt = cw >= 56 && rowPx >= 11;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    for (let i = first; i <= last; i++) {
      const c = bars[i], x0 = xOf(i) - colW / 2, up = c.c >= c.o;
      ctx.fillStyle = up ? BULL : '#8a2ae0';
      ctx.fillRect(x0, yOf(c.h), 2, Math.max(1, yOf(c.l) - yOf(c.h)));
      const yb = yOf(Math.max(c.o, c.c)); ctx.fillRect(x0 - 1, yb, 5, Math.max(2, yOf(Math.min(c.o, c.c)) - yb));
      if (!c.fp.size) {
        ctx.fillStyle = '#ffffff10'; ctx.fillRect(x0 + 8, yOf(c.h), colW - 10, Math.max(1, yOf(c.l) - yOf(c.h)));
        if (showTxt) { ctx.fillStyle = '#666'; ctx.font = `10px ${FONT}`; ctx.fillText('no tick data', x0 + colW / 2, (yOf(c.h) + yOf(c.l)) / 2); }
        continue;
      }
      const rows = new Map<number, [number, number]>();
      for (const [k, [s, b]] of c.fp) { const rk = Math.floor(k / mul); const r = rows.get(rk) || [0, 0]; r[0] += s; r[1] += b; rows.set(rk, r); }
      let mx = 0, poc = 0, mxD = 1e-12; for (const [rk, r] of rows) { const t = r[0] + r[1]; if (t > mx) { mx = t; poc = rk; } mxD = Math.max(mxD, Math.abs(r[1] - r[0])); }
      const cx0 = x0 + 8, cW = colW - 10, half = cW / 2;
      for (const [rk, [s, b]] of rows) {
        const yy = yOf((rk + 1) * mul * row - row / 2), h = Math.max(1, rowPx - 1.5), tot = s + b, d = b - s, fs = Math.min(12, rowPx * 0.72);
        if (mode === 'delta') {
          const a = Math.abs(d) / mxD; ctx.fillStyle = d >= 0 ? `rgba(1,212,3,${0.12 + 0.6 * a})` : `rgba(138,69,180,${0.15 + 0.65 * a})`; ctx.fillRect(cx0, yy + 1, cW, h);
          if (showTxt) { ctx.font = `${a > 0.6 ? '700 ' : ''}${fs}px ${FONT}`; ctx.fillStyle = '#f2f2f2'; ctx.fillText((d > 0 ? '+' : '') + fmtQ(d), cx0 + half, yy + 1 + h / 2); }
        } else if (mode === 'vol') {
          ctx.fillStyle = b >= s ? '#8ab88b' : '#a795b6'; ctx.fillRect(cx0, yy + 1, Math.max(3, (tot / mx) * cW), h);
          if (showTxt) { ctx.font = `${fs}px ${FONT}`; ctx.fillStyle = '#f2f2f2'; ctx.textAlign = 'left'; ctx.fillText(fmtQ(tot), cx0 + 4, yy + 1 + h / 2); ctx.textAlign = 'center'; }
        } else {
          const strong = Math.abs(d) / (tot || 1) > 0.45 && tot > mx * 0.35;
          ctx.fillStyle = b >= s ? (strong ? '#4db84f' : '#8ab88b') : (strong ? '#8a45b4' : '#a795b6');
          ctx.fillRect(cx0, yy + 1, Math.max(4, (tot / mx) * half), h);
          if (showTxt) {
            const below = rows.get(rk - 1), above = rows.get(rk + 1);
            const imbB = !!below && b > below[0] * 3 && b > 0, imbS = !!above && s > above[1] * 3 && s > 0;
            ctx.font = `${imbS ? '700 ' : ''}${fs}px ${FONT}`; ctx.fillStyle = imbS ? '#ff3df5' : '#eeeeee'; ctx.fillText(fmtQ(s), cx0 + half * 0.5, yy + 1 + h / 2);
            ctx.font = `${imbB ? '700 ' : ''}${fs}px ${FONT}`; ctx.fillStyle = imbB ? '#00e5ff' : '#eeeeee'; ctx.fillText(fmtQ(b), cx0 + half * 1.5, yy + 1 + h / 2);
          }
        }
        if (rk === poc) { ctx.strokeStyle = '#e6e62a'; ctx.lineWidth = 1.5; ctx.strokeRect(cx0 + 0.5, yy + 1.5, cW - 1, h - 1); ctx.lineWidth = 1; }
      }
      if (showTxt) { const dl = c.b - c.s; ctx.font = `600 11px ${FONT}`; ctx.fillStyle = dl >= 0 ? '#42da45' : '#c38bff'; ctx.fillText(`Δ ${dl > 0 ? '+' : ''}${fmtQ(dl)}`, x0 + colW / 2, yOf(c.l) + rowPx / 2 + 12); ctx.fillStyle = '#8a8a92'; ctx.font = `10.5px ${FONT}`; ctx.fillText(`V ${fmtQ(c.v)}`, x0 + colW / 2, yOf(c.l) + rowPx / 2 + 26); }
    }
    ctx.textAlign = 'left';
  }

  private drawProfile(bars: Bar[], first: number, last: number, n: number, yOf: (p: number) => number, row: number, pxRow: number, plotW: number) {
    const ctx = this.ctx, ov = this.opt.ov;
    const prof = new Map<number, [number, number]>(); let mx = 0, poc = 0, tot = 0;
    let f0 = first; if (ov.dlyp && !ov.visp) { const d0 = new Date(bars[last].t); d0.setHours(0, 0, 0, 0); f0 = 0; while (f0 < n && bars[f0].t < d0.getTime()) f0++; }
    const add = (k: number, s: number, b: number) => { const r = prof.get(k) || [0, 0]; r[0] += s; r[1] += b; prof.set(k, r); tot += s + b; if (r[0] + r[1] > mx) { mx = r[0] + r[1]; poc = k; } };
    for (let i = f0; i <= last; i++) { const c = bars[i]; if (c.fp.size) for (const [k, [s, b]] of c.fp) add(k, s, b); else add(Math.round(((c.h + c.l + c.c) / 3) / row), c.s, c.b); }
    if (!mx) return;
    const sorted = [...prof.entries()].sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1])); let acc = 0; const va = new Set<number>();
    for (const [k, r] of sorted) { if (acc > tot * 0.7) break; acc += r[0] + r[1]; va.add(k); }
    let vah = -Infinity, val = Infinity; for (const k of va) { vah = Math.max(vah, k); val = Math.min(val, k); }
    const maxW = Math.min(220, plotW * 0.22), h = Math.max(1, pxRow - 0.5);
    for (const [k, [s, b]] of prof) {
      const yy = yOf(k * row) - h / 2, w = ((s + b) / mx) * maxW, inVa = va.has(k), wb = w * (b / (s + b || 1));
      if (k === poc) { ctx.fillStyle = '#e6e62acc'; ctx.fillRect(plotW - w, yy, w, h); continue; }
      ctx.fillStyle = inVa ? 'rgba(1,212,3,0.38)' : 'rgba(1,212,3,0.16)'; ctx.fillRect(plotW - w, yy, wb, h);
      ctx.fillStyle = inVa ? 'rgba(138,69,180,0.5)' : 'rgba(138,69,180,0.2)'; ctx.fillRect(plotW - w + wb, yy, w - wb, h);
    }
    const lines: [number, string, string][] = [[poc, '#e6e62a', 'POC'], [vah, '#9a9aa2', 'VAH'], [val, '#9a9aa2', 'VAL']];
    for (const [k, col, lbl] of lines) { const yy = yOf(k * row); ctx.strokeStyle = col; ctx.setLineDash(lbl === 'POC' ? [6, 4] : [2, 4]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.setLineDash([]); this.edgeTag(plotW - maxW - 4, yy, lbl, col, '#111'); }
  }

  /** Stacked imbalances (3+ diagonal imbalances in a row) drawn as zones that extend until price trades through them. */
  private drawImbalanceZones(bars: Bar[], first: number, last: number, xOf: (i: number) => number, yOf: (p: number) => number, row: number, plotW: number, cw: number) {
    const ctx = this.ctx, n = bars.length, zones: { i: number; lo: number; hi: number; side: 1 | -1 }[] = [];
    for (let i = Math.max(0, first - 200); i <= last; i++) {
      const c = bars[i]; if (c.fp.size < 4) continue; const ks = [...c.fp.keys()].sort((a, b) => a - b);
      let rb = 0, bS = 0, bE = 0, rs = 0, sS = 0, sE = 0;
      for (let j = 1; j <= ks.length; j++) {
        const cur = j < ks.length ? c.fp.get(ks[j])! : null, prev = c.fp.get(ks[j - 1])!, adj = !!cur && ks[j] === ks[j - 1] + 1;
        if (adj && cur![1] > prev[0] * 3 && cur![1] > 0) { if (!rb) bS = ks[j]; bE = ks[j]; rb++; } else { if (rb >= 3) zones.push({ i, lo: (bS - 0.5) * row, hi: (bE + 0.5) * row, side: 1 }); rb = 0; }
        if (adj && prev[0] > cur![1] * 3 && prev[0] > 0) { if (!rs) sS = ks[j - 1]; sE = ks[j - 1]; rs++; } else { if (rs >= 3) zones.push({ i, lo: (sS - 0.5) * row, hi: (sE + 0.5) * row, side: -1 }); rs = 0; }
      }
    }
    for (const z of zones) {
      let end = n;
      for (let j = z.i + 1; j < n; j++) if (z.side > 0 ? bars[j].l < z.lo : bars[j].h > z.hi) { end = j; break; }
      if (end < first) continue;
      const x1 = xOf(z.i) - cw / 2, x2 = end >= n ? plotW : xOf(end), y1 = yOf(z.hi), y2 = yOf(z.lo), open = end >= n;
      const col = z.side > 0 ? '0,229,255' : '255,61,245';
      ctx.fillStyle = `rgba(${col},${open ? 0.16 : 0.07})`; ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
      ctx.fillStyle = `rgba(${col},${open ? 0.9 : 0.4})`; ctx.fillRect(x1, y1, 2, y2 - y1);
      if (open) { ctx.strokeStyle = `rgba(${col},0.55)`; ctx.beginPath(); ctx.moveTo(x1, y1 + 0.5); ctx.lineTo(x2, y1 + 0.5); ctx.moveTo(x1, y2 - 0.5); ctx.lineTo(x2, y2 - 0.5); ctx.stroke(); }
    }
  }

  /** Largest resting orders in the live book, drawn as levels across the chart. */
  private drawWalls(yOf: (p: number) => number, plotW: number, mainH: number, row: number, xLast: number) {
    const ctx = this.ctx, md = this.md!, lv = new Map<number, [number, 1 | -1]>();
    for (const [p, q] of md.book.b) { const k = Math.floor(p / row); const e = lv.get(k) || [0, 1]; e[0] += q; lv.set(k, e); }
    for (const [p, q] of md.book.a) { const k = Math.floor(p / row); const e = lv.get(k) || [0, -1]; e[0] += q; e[1] = -1; lv.set(k, e); }
    if (lv.size < 6) return;
    const sizes = [...lv.values()].map(e => e[0]).sort((a, b) => a - b), med = sizes[sizes.length >> 1] || 1, mx = sizes[sizes.length - 1];
    const pick = (side: 1 | -1) => [...lv.entries()].filter(([, e]) => e[1] === side && e[0] >= med * 3).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3);
    ctx.font = `600 10.5px ${FONT}`; ctx.textBaseline = 'middle';
    for (const [k, [q, side]] of [...pick(1), ...pick(-1)]) {
      const yy = yOf((k + 0.5) * row); if (yy < 4 || yy > mainH - 4) continue;
      const col = side > 0 ? '66,218,69' : '178,122,230', w = 1 + 3 * (q / mx), x0 = Math.max(0, xLast + 6);
      ctx.strokeStyle = `rgba(${col},0.18)`; ctx.lineWidth = 1; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(x0, yy); ctx.stroke(); ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(${col},0.75)`; ctx.lineWidth = w; ctx.beginPath(); ctx.moveTo(x0, yy); ctx.lineTo(plotW, yy); ctx.stroke(); ctx.lineWidth = 1;
      const s = `${side > 0 ? 'BID' : 'ASK'} ${fmtQ(q)}`, tw = ctx.measureText(s).width + 10;
      ctx.fillStyle = side > 0 ? '#0e5b0d' : '#4a1f6f'; ctx.fillRect(plotW - tw - 4, yy - 8, tw, 16); ctx.fillStyle = '#fff'; ctx.textAlign = 'left'; ctx.fillText(s, plotW - tw + 1, yy);
    }
  }

  /* ================================================================ interaction */
  private handlers: [string, any, any?][] = [];
  private on(t: EventTarget, ev: string, f: any, opt?: any) { t.addEventListener(ev, f, opt); this.handlers.push([ev, f, t]); }
  private unbind() { for (const [ev, f, t] of this.handlers) (t as EventTarget).removeEventListener(ev, f); this.handlers = []; }

  private pos(e: MouseEvent) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  private curY() { const G = this.G; return this.view.y || { mid: (G.hi + G.lo) / 2, span: G.hi - G.lo }; }
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
    const s = this.selected(); if (s && !s.hidden && hitDrawing(s, V, x, y, true) < 6) return s;
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
      const { x, y } = this.pos(e), G = this.G, base = { x, y, off: this.view.off, cw: this.view.cw, y0: this.curY() };
      if (x > G.plotW && y < G.mainH) { this.drag = { kind: 'yaxis', ...base }; return; }
      if (y > this.H - 24) { this.drag = { kind: 'xaxis', ...base }; return; }
      if (y > G.mainH) { this.drag = { kind: 'pan', ...base }; return; }
      const pt = this.ptAt(x, y, e);
      if (this.tool !== 'cursor') {
        const def = TOOL_MAP.get(this.tool); if (!def) return;
        if (def.n === 1) return this.commit(this.newDrawing(this.tool, pt));
        if (def.n === 0) { this.creating = this.newDrawing(this.tool, pt); this.createDown = { x, y }; return; }
        if (!this.creating) { this.creating = this.newDrawing(this.tool, pt); this.creating.pts.push({ ...pt }); this.createDown = { x, y }; return; }
        const c = this.creating; c.pts[c.pts.length - 1] = pt;
        if (def.n > 0 && c.pts.length >= def.n) return this.commit(c);
        c.pts.push({ ...pt }); this.dirty = true; return;
      }
      const hi = this.handleAt(x, y), s = this.selected();
      if (hi >= 0 && s) {
        this.snapshot();
        if (s.type === 'brush' || s.type === 'highlighter') this.drag = { kind: 'move', ...base, orig: s.pts.map(p => ({ ...p })), t0: pt.t, p0: G.pOf(y) };
        else this.drag = { kind: 'handle', ...base, hi };
        return;
      }
      const hit = this.hitTop(x, y);
      if (hit) {
        this.select(hit.id);
        if (!hit.locked) { this.snapshot(); this.drag = { kind: 'move', ...base, orig: hit.pts.map(p => ({ ...p })), t0: this.xToTime(x), p0: G.pOf(y) }; }
        return;
      }
      if (this.sel) this.select(null);
      this.drag = { kind: 'pan', ...base };
      cv.style.cursor = 'grabbing';
    });
    this.on(window, 'mousemove', (e: MouseEvent) => {
      const m = this.pos(e), inside = m.x >= 0 && m.y >= 0 && m.x <= this.W && m.y <= this.H;
      const prevMouse = this.mouse; this.mouse = inside ? m : null;
      if (inside || prevMouse) this.dirty = true;
      const d = this.drag, G = this.G;
      if (d) {
        if (d.kind === 'yaxis') { this.view.auto = false; this.view.y = { mid: d.y0.mid, span: d.y0.span * Math.exp((m.y - d.y) / 160) }; }
        else if (d.kind === 'xaxis') { this.view.cw = clamp(d.cw * Math.exp((m.x - d.x) / 140), MIN_CW, MAX_CW); }
        else if (d.kind === 'pan') {
          this.view.off = d.off + (m.x - d.x) / this.view.cw;
          if (!this.view.auto) this.view.y = { mid: d.y0.mid + ((m.y - d.y) / G.mainH) * d.y0.span, span: d.y0.span };
        } else if (d.kind === 'move') {
          const s = this.selected(); if (s && d.orig) { const dt = this.xToTime(m.x) - d.t0!, dp = G.pOf(m.y) - d.p0!; s.pts = d.orig.map(p => ({ t: p.t + dt, p: p.p + dp })); }
        } else if (d.kind === 'handle') {
          const s = this.selected(); if (s) { const pt = this.ptAt(m.x, m.y, e), def = TOOL_MAP.get(s.type); if (def?.moveHandle) def.moveHandle(s, d.hi!, pt); else s.pts[d.hi!] = pt; }
        }
        this.dirty = true;
        return;
      }
      if (this.creating && inside) {
        const def = TOOL_MAP.get(this.creating.type)!, pt = this.ptAt(m.x, m.y, e);
        if (def.n === 0) { const lp = this.creating.pts[this.creating.pts.length - 1]; if (Math.hypot(this.timeToX(lp.t) - m.x, G.yOf(lp.p) - m.y) > 3) this.creating.pts.push(pt); }
        else this.creating.pts[this.creating.pts.length - 1] = pt;
        return;
      }
      if (!inside || !G.plotW) return;
      if (m.x >= G.plotW && m.y < G.mainH) cv.style.cursor = 'ns-resize';
      else if (m.y > this.H - 24) cv.style.cursor = 'ew-resize';
      else if (this.tool === 'cursor' && m.y < G.mainH) {
        const h = this.hitTop(m.x, m.y), hid = h ? h.id : null;
        if (hid !== this.hoverId) { this.hoverId = hid; this.dirty = true; }
        cv.style.cursor = this.handleAt(m.x, m.y) >= 0 ? 'move' : h ? 'pointer' : 'crosshair';
      }
      else if (this.tool === 'cursor') cv.style.cursor = 'default';
    });
    this.on(window, 'mouseup', (e: MouseEvent) => {
      const d = this.drag; this.drag = null;
      if (d && (d.kind === 'move' || d.kind === 'handle')) this.changed();
      if (d) this.dirty = true;
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
      if (x > this.G.plotW && y < this.G.mainH) return this.setAutoScale(true);
      if (y > this.H - 24) return this.reset();
      if (!this.hitTop(x, y)) this.goLive();
    });
    this.on(cv, 'wheel', (e: WheelEvent) => {
      e.preventDefault(); const G = this.G; if (!G.bars?.length) return;
      const { x, y } = this.pos(e), unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      const dx = e.deltaX * unit, dy = e.deltaY * unit;
      if ((x > G.plotW && y < G.mainH) || e.altKey) {                    // price zoom
        const f = clamp(Math.exp(dy * 0.0015), 0.7, 1.4), c = this.curY();
        this.view.auto = false; this.view.y = { mid: c.mid, span: c.span * f };
      } else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {             // horizontal scroll
        this.view.off -= (e.shiftKey ? dy : dx) / this.view.cw;
      } else {                                                           // time zoom around mouse
        this.zoomAt(clamp(Math.exp(-dy * 0.0015), 0.7, 1.4), Math.min(x, G.plotW));
      }
      this.dirty = true;
    }, { passive: false });
    this.on(cv, 'mouseleave', () => { this.mouse = null; this.hoverId = null; this.dirty = true; });
    this.on(cv, 'contextmenu', (e: MouseEvent) => { e.preventDefault(); const { x, y } = this.pos(e); const hit = this.hitTop(x, y); if (hit) this.select(hit.id); this.cb.context?.(e, this.G.pOf ? this.G.pOf(y) : 0); });
    this.on(cv, 'keydown', (e: KeyboardEvent) => {
      const k = e.key;
      if (k === 'Escape') { this.creating = null; this.setTool('cursor'); this.select(null); }
      else if ((k === 'Delete' || k === 'Backspace') && this.sel) { e.preventDefault(); this.deleteSelected(); }
      else if (k === 'Enter' && this.creating) { const def = TOOL_MAP.get(this.creating.type)!; if (def.n === -1 && this.creating.pts.length > 2) { this.creating.pts.pop(); this.commit(this.creating); } }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? this.redoDraw() : this.undoDraw(); }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'y') { e.preventDefault(); this.redoDraw(); }
      else if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === 'd' && this.sel) { e.preventDefault(); this.cloneSelected(); }
      else if (k === 'ArrowLeft') { e.preventDefault(); this.scrollBars(e.shiftKey ? 20 : 3); }
      else if (k === 'ArrowRight') { e.preventDefault(); this.scrollBars(e.shiftKey ? -20 : -3); }
      else if (k === 'ArrowUp' || k === '+' || k === '=') { e.preventDefault(); this.zoomIn(); }
      else if (k === 'ArrowDown' || k === '-') { e.preventDefault(); this.zoomOut(); }
      else if (k === 'Home') { e.preventDefault(); this.reset(); }
      else if (k === 'End') { e.preventDefault(); this.goLive(); }
    });
  }

  screenshot(): string { return this.cv.toDataURL('image/png'); }
}
