/**
 * Backtest engine.
 *  • Tick mode: bars + footprint are rebuilt from recorded ticks; stops/targets are checked on every trade.
 *  • Bar mode: uses exchange candles; intrabar path assumed O→H→L→C (bull) or O→L→H→C (bear).
 * Signals are evaluated on each CLOSED bar and filled on the next tick / next bar open (no look-ahead).
 */
import type { Bar, KBar, Tick } from '../lib/types';
import { BarBuilder, buildSeries, type Series } from '../data/bars';
import { TA } from '../lib/ta';
import { runScript, type Script } from '../indicators/runtime';

export interface BtParams { dir: 'both' | 'long' | 'short'; qty: number; slTicks: number; tpTicks: number; slipTicks: number; feePerSide: number; exitOnOpposite: boolean; h1: number; h2: number; maxPerDay: number; tick: number; pointValue: number }
export interface BtTrade { dir: 1 | -1; entry: number; et: number; ei: number; exit: number; xt: number; xi: number; why: string; pnl: number; mae: number; mfe: number; sl: number; tp: number }
export interface BtResult { bars: Bar[]; d: Series; trades: BtTrade[]; ticks: number; ms: number }

export function compileRule(code: string) {
  return new Function('d', 'ta', 'i', 'ind', '"use strict";\n' + code) as (d: Series, ta: typeof TA, i: number, ind: Record<string, any>) => number;
}

function indicators(d: Series, scripts: Script[]) {
  const ind: Record<string, any> = {};
  for (const s of scripts) { const r = runScript(s, d); if (!r.err) ind[s.name] = r.plots; }
  return ind;
}

export function runBacktest(src: { ticks?: Tick[]; klines?: KBar[] }, tfSec: number, row: number, bigUsd: number, code: string, P: BtParams, scripts: Script[]): BtResult {
  const t0 = performance.now();
  const rule = compileRule(code);
  let bars: Bar[];
  if (src.ticks?.length) { const B = new BarBuilder({ kind: 'time', sec: tfSec }, row, bigUsd); B.addAll(src.ticks); bars = B.bars; }
  else { const B = new BarBuilder({ kind: 'time', sec: tfSec }, row, bigUsd); B.seedKlines(src.klines || [], false); bars = B.bars.map(b => ({ ...b, k: false })); }
  const d = buildSeries(bars), ind = indicators(d, scripts);
  const sig = new Int8Array(bars.length);
  for (let i = 1; i < bars.length; i++) { const s = +rule(d, TA, i, ind) || 0; sig[i] = s > 0 ? 1 : s < 0 ? -1 : 0; }

  const tk = P.tick, sl = P.slTicks * tk, tp = P.tpTicks * tk, slip = P.slipTicks * tk, mult = P.qty * P.pointValue;
  const trades: BtTrade[] = []; const perDay: Record<string, number> = {};
  let pos: (Omit<BtTrade, 'exit' | 'xt' | 'xi' | 'why' | 'pnl'>) | null = null, pending: 0 | 1 | -1 = 0;
  const allowed = (s: number) => P.dir === 'both' || (P.dir === 'long' && s > 0) || (P.dir === 'short' && s < 0);
  const close = (px: number, t: number, xi: number, why: string) => { if (!pos) return; trades.push({ ...pos, exit: px, xt: t, xi, why, pnl: (px - pos.entry) * pos.dir * mult - P.feePerSide * 2 }); pos = null; };
  const tryOpen = (px: number, t: number, bi: number) => {
    if (!pending || pos) { pending = 0; return; }
    const dt = new Date(t), hr = dt.getHours(), day = dt.toDateString();
    if (hr >= P.h1 && hr < P.h2 && (perDay[day] || 0) < P.maxPerDay) {
      const e = px + pending * slip; pos = { dir: pending, entry: e, et: t, ei: bi, sl: e - pending * sl, tp: e + pending * tp, mae: 0, mfe: 0 }; perDay[day] = (perDay[day] || 0) + 1;
    }
    pending = 0;
  };
  const onPrice = (p: number, t: number, bi: number) => {
    if (!pos) return;
    const ex = (p - pos.entry) * pos.dir; if (ex < pos.mae) pos.mae = ex; if (ex > pos.mfe) pos.mfe = ex;
    if (pos.dir > 0 ? p <= pos.sl : p >= pos.sl) { const fill = pos.dir > 0 ? Math.min(p, pos.sl) : Math.max(p, pos.sl); close(fill - pos.dir * slip, t, bi, 'Stop'); }
    else if (pos.dir > 0 ? p >= pos.tp : p <= pos.tp) close(pos.tp, t, bi, 'Target');
  };
  const onBarClose = (bi: number, t: number, px: number) => {
    const s = sig[bi];
    if (pos && P.exitOnOpposite && s === -pos.dir) close(px - pos.dir * slip, t, bi, 'Signal');
    if (!pos && s && allowed(s)) pending = s as 1 | -1;
  };

  let n = 0;
  if (src.ticks?.length) {
    let bi = 0;
    for (const [t, p] of src.ticks) {
      n++;
      while (bi < bars.length - 1 && t >= bars[bi + 1].t) { onBarClose(bi, t, p); bi++; }
      if (pending) tryOpen(p, t, bi);
      onPrice(p, t, bi);
    }
  } else {
    for (let bi = 0; bi < bars.length; bi++) {
      const b = bars[bi];
      if (pending) tryOpen(b.o, b.t, bi);
      const path = b.c >= b.o ? [b.o, b.h, b.l, b.c] : [b.o, b.l, b.h, b.c];
      for (const p of path) { n++; onPrice(p, b.t, bi); }
      onBarClose(bi, b.t + tfSec * 1000, b.c);
    }
  }
  if (pos && bars.length) close(bars[bars.length - 1].c, bars[bars.length - 1].t, bars.length - 1, 'End');
  return { bars, d, trades, ticks: n, ms: performance.now() - t0 };
}

export function stats(tr: BtTrade[]) {
  const w = tr.filter(t => t.pnl > 0), l = tr.filter(t => t.pnl <= 0), net = tr.reduce((a, t) => a + t.pnl, 0);
  const gw = w.reduce((a, t) => a + t.pnl, 0), gl = -l.reduce((a, t) => a + t.pnl, 0);
  let eq = 0, pk = 0, dd = 0, cons = 0, maxCons = 0; const curve = [0];
  for (const t of tr) { eq += t.pnl; curve.push(eq); pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); cons = t.pnl <= 0 ? cons + 1 : 0; maxCons = Math.max(maxCons, cons); }
  const mean = tr.length ? net / tr.length : 0, sd = Math.sqrt(tr.reduce((a, t) => a + (t.pnl - mean) ** 2, 0) / (tr.length || 1));
  return { n: tr.length, net, gw, gl, wr: tr.length ? (w.length / tr.length) * 100 : 0, pf: gl ? gw / gl : gw ? Infinity : 0, dd, aw: w.length ? gw / w.length : 0, al: l.length ? gl / l.length : 0, exp: mean, sqn: sd ? (mean / sd) * Math.sqrt(tr.length) : 0, maxCons, curve };
}

export const PRESETS: Record<string, string> = {
  'Big trades + VWAP': `// Big buyers dominate above VWAP → long, big sellers below VWAP → short
const bb = d.bigBuy[i], bs = d.bigSell[i];
if (bb > bs * 2 && bb > 0 && d.close[i] > d.vwap[i]) return 1;
if (bs > bb * 2 && bs > 0 && d.close[i] < d.vwap[i]) return -1;
return 0;`,
  'Delta divergence': `// New 20-bar high with negative delta → short; new low with positive delta → long
const hh = ta.highest(d.high, 20), ll = ta.lowest(d.low, 20);
if (d.high[i] >= hh[i] && d.delta[i] < 0) return -1;
if (d.low[i] <= ll[i] && d.delta[i] > 0) return 1;
return 0;`,
  'CVD trend + EMA pullback': `// Trade with the CVD trend, enter on a pullback to EMA 20
const e = ta.ema(d.close, 20), c = ta.ema(d.cvd, 10);
const up = c[i] > c[i - 5], dn = c[i] < c[i - 5];
if (up && d.low[i] <= e[i] && d.close[i] > e[i]) return 1;
if (dn && d.high[i] >= e[i] && d.close[i] < e[i]) return -1;
return 0;`,
  'EMA 9/21 cross': `const f = ta.ema(d.close, 9), s = ta.ema(d.close, 21);
if (ta.cross(f, s, i)) return 1;
if (ta.crossunder(f, s, i)) return -1;
return 0;`,
  'Use my indicator': `// Saved indicators are available as ind['Name'] → array of plots
const spike = ind['Delta Spike']?.[0]?.values;
if (spike && spike[i] != null) return d.delta[i] > 0 ? 1 : -1;
return 0;`,
};
