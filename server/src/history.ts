/** Historical candles (klines) from the venues, used to fill the chart beyond recorded tick history. */
import type { Bar, SymbolDef, Tick } from './types.ts';
import { ENDPOINTS } from './feeds/exchanges.ts';
import { getJSON } from './feeds/socket.ts';

const INTERVALS: [number, string][] = [[86400, '1d'], [14400, '4h'], [7200, '2h'], [3600, '1h'], [1800, '30m'], [900, '15m'], [300, '5m'], [180, '3m'], [60, '1m']];
const HL_OK = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '1d']);
const cache = new Map<string, { at: number; bars: Bar[] }>();

/** Largest native interval that divides tf. */
function baseInterval(tfSec: number): [number, string] | null {
  for (const iv of INTERVALS) if (tfSec % iv[0] === 0) return iv;
  return null;
}

export function aggregate(bars: Bar[], tfMs: number): Bar[] {
  const out: Bar[] = [];
  for (const b of bars) {
    const t = Math.floor(b.t / tfMs) * tfMs;
    const c = out[out.length - 1];
    if (!c || c.t !== t) out.push({ ...b, t });
    else { c.h = Math.max(c.h, b.h); c.l = Math.min(c.l, b.l); c.c = b.c; c.v += b.v; c.b += b.b; c.s += b.s; }
  }
  return out;
}

export function barsFromTicks(ticks: Tick[], tfMs: number): Bar[] {
  const out: Bar[] = [];
  for (const [t, p, q, s] of ticks) {
    const bt = Math.floor(t / tfMs) * tfMs;
    let c = out[out.length - 1];
    if (!c || c.t !== bt) { c = { t: bt, o: p, h: p, l: p, c: p, v: 0, b: 0, s: 0 }; out.push(c); }
    if (p > c.h) c.h = p; if (p < c.l) c.l = p; c.c = p; c.v += q; s > 0 ? (c.b += q) : (c.s += q);
  }
  return out;
}

export async function klines(def: SymbolDef, tfSec: number, limit: number, memTicks: Tick[]): Promise<Bar[]> {
  limit = Math.max(10, Math.min(limit, 3000));
  const key = `${def.id}:${tfSec}:${limit}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 15_000) return hit.bars;
  let bars: Bar[] = [];
  const src = def.klinesFrom >= 0 ? def.sources[def.klinesFrom] : null;
  const iv = baseInterval(tfSec);
  if (src && iv && src.ex !== 'sim' && src.ex !== 'poll') {
    const n = Math.min(1500, Math.ceil(limit * tfSec / iv[0]));
    if (src.ex === 'binance-f' || src.ex === 'binance-s') {
      const base = src.ex === 'binance-f' ? `${ENDPOINTS.binanceFutRest}/fapi/v1/klines` : `${ENDPOINTS.binanceSpotRest}/api/v3/klines`;
      const rows = await getJSON<any[]>(`${base}?symbol=${src.sym}&interval=${iv[1]}&limit=${n}`);
      bars = rows.map(r => { const v = +r[5], b = +r[9]; return { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v, b, s: v - b }; });
    } else if (src.ex === 'hl' && HL_OK.has(iv[1])) {
      const end = Date.now(), start = end - n * iv[0] * 1000;
      const rows = await getJSON<any[]>(ENDPOINTS.hlRest, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'candleSnapshot', req: { coin: src.coin, interval: iv[1], startTime: start, endTime: end } }) });
      // Hyperliquid candles carry no aggressor split → split unknown (b = s = v/2, flagged on client as estimated)
      bars = rows.map(r => { const v = +r.v; return { t: +r.t, o: +r.o, h: +r.h, l: +r.l, c: +r.c, v, b: v / 2, s: v / 2 }; });
    } else if (src.ex === 'bybit') {
      const ivB = iv[1].endsWith('m') ? iv[1].slice(0, -1) : iv[1] === '1d' ? 'D' : String(iv[0] / 60);
      const d = await getJSON<any>(`${ENDPOINTS.bybitRest}/v5/market/kline?category=linear&symbol=${src.sym}&interval=${ivB}&limit=${Math.min(1000, n)}`);
      bars = (d.result?.list ?? []).reverse().map((r: string[]) => { const v = +r[5]; return { t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v, b: v / 2, s: v / 2 }; });
    }
    if (iv[0] !== tfSec) bars = aggregate(bars, tfSec * 1000);
  } else {
    bars = barsFromTicks(memTicks, tfSec * 1000);
  }
  bars = bars.slice(-limit);
  cache.set(key, { at: Date.now(), bars });
  return bars;
}
