import type { Bar, BarSpec, KBar, Tick } from '../lib/types';

/** Builds candles + footprint incrementally from ticks; can be seeded with exchange klines for older history. */
export class BarBuilder {
  bars: Bar[] = [];
  readonly spec: BarSpec;
  readonly row: number;
  readonly bigUsd: number;
  private n = 0;

  constructor(spec: BarSpec, row: number, bigUsd: number) { this.spec = spec; this.row = row; this.bigUsd = bigUsd; }

  static ms(spec: BarSpec) { return spec.kind === 'time' ? spec.sec * 1000 : 0; }

  add(tk: Tick): void {
    const [t, p, q, s] = tk;
    let c = this.bars[this.bars.length - 1];
    let fresh = !c || c.k;
    if (!fresh) {
      const sp = this.spec;
      if (sp.kind === 'time') fresh = Math.floor(t / (sp.sec * 1000)) * sp.sec * 1000 > c.t;
      else if (sp.kind === 'vol') fresh = c.v >= sp.size;
      else fresh = this.n >= sp.count;
    }
    if (c && c.k && this.spec.kind === 'time') {
      const bt = Math.floor(t / (this.spec.sec * 1000)) * this.spec.sec * 1000;
      if (bt === c.t) { // live tick lands in the last kline bar: convert it to a tick bar (keeps OHLC)
        c.k = false; fresh = false;
      } else if (bt < c.t) return;
    }
    if (fresh) {
      const bt = this.spec.kind === 'time' ? Math.floor(t / (this.spec.sec * 1000)) * this.spec.sec * 1000 : t;
      c = { t: bt, o: p, h: p, l: p, c: p, v: 0, b: 0, s: 0, fp: new Map(), big: [] };
      this.bars.push(c); this.n = 0;
    }
    if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p;
    c.v += q; s > 0 ? (c.b += q) : (c.s += q); this.n++;
    const k = Math.round(p / this.row);
    let cell = c.fp.get(k); if (!cell) { cell = [0, 0]; c.fp.set(k, cell); }
    cell[s > 0 ? 1 : 0] += q;
    if (q * p >= this.bigUsd) c.big.push(tk);
  }

  addAll(ticks: Tick[], from = 0) { for (let i = from; i < ticks.length; i++) this.add(ticks[i]); }

  /** Prepend kline bars that are older than the first tick-built bar. */
  seedKlines(k: KBar[], estimated: boolean) {
    if (this.spec.kind !== 'time' || !k.length) return;
    const first = this.bars[0]?.t ?? Infinity;
    const older: Bar[] = [];
    for (const x of k) if (x.t < first) older.push({ ...x, fp: new Map(), big: [], k: true, est: estimated });
    this.bars = older.concat(this.bars);
  }
}

/** Plain series used by indicators, backtests and overlays. */
export interface Series {
  length: number;
  time: number[]; open: number[]; high: number[]; low: number[]; close: number[]; volume: number[];
  buy: number[]; sell: number[]; delta: number[]; cvd: number[]; vwap: number[]; bigBuy: number[]; bigSell: number[];
}

export function buildSeries(bars: Bar[]): Series {
  const n = bars.length;
  const d: Series = { length: n, time: new Array(n), open: new Array(n), high: new Array(n), low: new Array(n), close: new Array(n), volume: new Array(n), buy: new Array(n), sell: new Array(n), delta: new Array(n), cvd: new Array(n), vwap: new Array(n), bigBuy: new Array(n), bigSell: new Array(n) };
  let cv = 0, pv = 0, vv = 0, day = -1;
  for (let i = 0; i < n; i++) {
    const c = bars[i];
    const dd = Math.floor(c.t / 86_400_000);
    if (dd !== day) { day = dd; pv = 0; vv = 0; }            // VWAP resets at 00:00 UTC
    d.time[i] = c.t; d.open[i] = c.o; d.high[i] = c.h; d.low[i] = c.l; d.close[i] = c.c; d.volume[i] = c.v;
    d.buy[i] = c.b; d.sell[i] = c.s; d.delta[i] = c.est ? 0 : c.b - c.s; cv += d.delta[i]; d.cvd[i] = cv;
    pv += ((c.h + c.l + c.c) / 3) * c.v; vv += c.v; d.vwap[i] = vv ? pv / vv : c.c;
    let bb = 0, bs = 0; for (const t of c.big) t[3] > 0 ? (bb += t[2]) : (bs += t[2]);
    d.bigBuy[i] = bb; d.bigSell[i] = bs;
  }
  return d;
}

export const specLabel = (s: BarSpec) => s.kind === 'time' ? (s.sec < 60 ? `${s.sec}s` : s.sec < 3600 ? `${s.sec / 60}m` : s.sec < 86400 ? `${s.sec / 3600}h` : `${s.sec / 86400}D`) : s.kind === 'vol' ? `${s.size} Vol` : `${s.count} Tick`;
export const BAR_SPECS: BarSpec[] = [
  { kind: 'time', sec: 5 }, { kind: 'time', sec: 15 }, { kind: 'time', sec: 30 },
  { kind: 'time', sec: 60 }, { kind: 'time', sec: 180 }, { kind: 'time', sec: 300 }, { kind: 'time', sec: 900 }, { kind: 'time', sec: 1800 },
  { kind: 'time', sec: 3600 }, { kind: 'time', sec: 14400 }, { kind: 'time', sec: 86400 },
  { kind: 'tick', count: 100 }, { kind: 'tick', count: 500 }, { kind: 'tick', count: 1000 },
  { kind: 'vol', size: 50 }, { kind: 'vol', size: 250 }, { kind: 'vol', size: 1000 },
];
export const specKey = (s: BarSpec) => s.kind === 'time' ? `t:${s.sec}` : s.kind === 'vol' ? `v:${s.size}` : `k:${s.count}`;
export const parseSpec = (k: string): BarSpec => { const [a, b] = k.split(':'); return a === 't' ? { kind: 'time', sec: +b } : a === 'v' ? { kind: 'vol', size: +b } : { kind: 'tick', count: +b }; };
