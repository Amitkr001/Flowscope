/**
 * Exchange adapters. Each `start*` function opens the public streams for ONE symbol on ONE venue,
 * normalises messages into Trade / book updates and reports connection status.
 *
 * Endpoints (public, no API key):
 *   Binance USDⓈ-M futures  trades: wss://fstream.binance.com/market/stream   (aggTrade)
 *                           book:   wss://fstream.binance.com/public/stream   (diff depth @100ms) + REST snapshot
 *   Binance spot            wss://stream.binance.com:9443/stream
 *   Bybit v5 linear         wss://stream.bybit.com/v5/public/linear           (publicTrade)
 *   OKX v5                  wss://ws.okx.com:8443/ws/v5/public                (trades; sz in contracts × ctVal)
 *   Hyperliquid             wss://api.hyperliquid.xyz/ws                      (trades, l2Book; HIP-3 coins "xyz:GOLD")
 */
import type { FeedEvents, SourceDef, SymbolDef } from '../types.ts';
import { LiveSocket, getJSON } from './socket.ts';
import { log } from '../log.ts';
import { startSim } from './sim.ts';

export const ENDPOINTS = {
  binanceFutMarket: process.env.BINANCE_F_MARKET_WS || 'wss://fstream.binance.com/market/stream',
  binanceFutPublic: process.env.BINANCE_F_PUBLIC_WS || 'wss://fstream.binance.com/public/stream',
  binanceFutRest: process.env.BINANCE_F_REST || 'https://fapi.binance.com',
  binanceSpotWs: 'wss://stream.binance.com:9443/stream',
  binanceSpotRest: 'https://api.binance.com',
  bybitWs: 'wss://stream.bybit.com/v5/public/linear',
  bybitRest: 'https://api.bybit.com',
  okxWs: 'wss://ws.okx.com:8443/ws/v5/public',
  hlWs: process.env.HL_WS || 'wss://api.hyperliquid.xyz/ws',
  hlRest: process.env.HL_REST || 'https://api.hyperliquid.xyz/info',
  pollRest: process.env.POLL_REST || 'https://biquote.io/api/',
};

export interface Running { stop(): void }

export function startSource(def: SymbolDef, idx: number, ev: FeedEvents): Running {
  const src = def.sources[idx];
  const withBook = def.bookFrom === idx;
  switch (src.ex) {
    case 'binance-f': return binanceFutures(def.id, src.sym, withBook, ev);
    case 'binance-s': return binanceSpot(def.id, src.sym, ev);
    case 'bybit': return bybit(def.id, src.sym, ev);
    case 'okx': return okx(def.id, src.sym, src.ct, ev);
    case 'hl': return hyperliquid(def.id, src.coin, src.sig, withBook, ev);
    case 'poll': return poll(def.id, src.sym, ev);
    case 'sim': return startSim(def, src, ev);
  }
}

export const sourceLabel = (s: SourceDef) => s.ex === 'hl' ? 'hyperliquid' : s.ex;

/* ------------------------------------------------------------------ Binance futures */
function binanceFutures(id: string, sym: string, withBook: boolean, ev: FeedEvents): Running {
  const lc = sym.toLowerCase();
  const trades = new LiveSocket(`binance-f:${sym}:trades`, `${ENDPOINTS.binanceFutMarket}?streams=${lc}@aggTrade`, {
    open: () => ev.status(id, 'binance-f', true),
    close: () => ev.status(id, 'binance-f', false),
    msg: (m) => {
      const d = m.data ?? m;
      if (d.e !== 'aggTrade') return;
      ev.trade(id, { t: d.T, p: +d.p, q: +d.q, s: d.m ? -1 : 1, ex: 'binance-f' });
    },
  }).start();
  if (!withBook) return { stop: () => trades.stop() };

  // Diff-depth sync per Binance docs: buffer → REST snapshot → apply where u >= lastUpdateId, check pu continuity.
  let synced = false, lastU = 0, buffer: any[] = [], syncing = false, first = true;
  const resync = async () => {
    if (syncing) return; syncing = true; synced = false;
    try {
      const snap = await getJSON<any>(`${ENDPOINTS.binanceFutRest}/fapi/v1/depth?symbol=${sym}&limit=1000`);
      ev.book(id, snap.bids.map((x: string[]) => [+x[0], +x[1]]), snap.asks.map((x: string[]) => [+x[0], +x[1]]), true);
      lastU = snap.lastUpdateId; first = true;
      const pending = buffer.filter(e => e.u >= lastU); buffer = [];
      synced = true;
      for (const e of pending) apply(e);
    } catch (e) { log.warn(`[binance-f:${sym}] depth snapshot failed: ${(e as Error).message}`); setTimeout(() => { syncing = false; resync(); }, 5000); return; }
    syncing = false;
  };
  const apply = (e: any) => {
    if (e.u < lastU) return;
    if (!first && e.pu !== undefined && e.pu !== lastU) { log.warn(`[binance-f:${sym}] depth gap, resync`); return void resync(); }
    first = false; lastU = e.u;
    ev.book(id, e.b.map((x: string[]) => [+x[0], +x[1]]), e.a.map((x: string[]) => [+x[0], +x[1]]), false);
  };
  const depth = new LiveSocket(`binance-f:${sym}:depth`, `${ENDPOINTS.binanceFutPublic}?streams=${lc}@depth@100ms`, {
    open: () => { buffer = []; resync(); },
    msg: (m) => {
      const d = m.data ?? m;
      if (d.e !== 'depthUpdate') return;
      if (!synced) { buffer.push(d); if (buffer.length > 2000) buffer.shift(); return; }
      apply(d);
    },
  }).start();
  return { stop: () => { trades.stop(); depth.stop(); } };
}

/* ------------------------------------------------------------------ Binance spot (trades only) */
function binanceSpot(id: string, sym: string, ev: FeedEvents): Running {
  const s = new LiveSocket(`binance-s:${sym}`, `${ENDPOINTS.binanceSpotWs}?streams=${sym.toLowerCase()}@aggTrade`, {
    open: () => ev.status(id, 'binance-s', true), close: () => ev.status(id, 'binance-s', false),
    msg: (m) => { const d = m.data ?? m; if (d.e === 'aggTrade') ev.trade(id, { t: d.T, p: +d.p, q: +d.q, s: d.m ? -1 : 1, ex: 'binance-s' }); },
  }).start();
  return { stop: () => s.stop() };
}

/* ------------------------------------------------------------------ Bybit */
function bybit(id: string, sym: string, ev: FeedEvents): Running {
  const s = new LiveSocket(`bybit:${sym}`, ENDPOINTS.bybitWs, {
    open: (so) => { so.send({ op: 'subscribe', args: [`publicTrade.${sym}`] }); ev.status(id, 'bybit', true); },
    close: () => ev.status(id, 'bybit', false),
    ping: () => JSON.stringify({ op: 'ping' }), pingMs: 20_000,
    msg: (m) => {
      if (!m.topic?.startsWith('publicTrade.') || !Array.isArray(m.data)) return;
      for (const d of m.data) ev.trade(id, { t: +d.T, p: +d.p, q: +d.v, s: d.S === 'Buy' ? 1 : -1, ex: 'bybit' });
    },
  }).start();
  return { stop: () => s.stop() };
}

/* ------------------------------------------------------------------ OKX */
function okx(id: string, instId: string, ct: number, ev: FeedEvents): Running {
  const s = new LiveSocket(`okx:${instId}`, ENDPOINTS.okxWs, {
    open: (so) => { so.send({ op: 'subscribe', args: [{ channel: 'trades', instId }] }); ev.status(id, 'okx', true); },
    close: () => ev.status(id, 'okx', false),
    ping: () => 'ping', pingMs: 25_000,
    msg: (m) => {
      if (m.arg?.channel !== 'trades' || !Array.isArray(m.data)) return;
      for (const d of m.data) ev.trade(id, { t: +d.ts, p: +d.px, q: +d.sz * ct, s: d.side === 'buy' ? 1 : -1, ex: 'okx' });
    },
  }).start();
  return { stop: () => s.stop() };
}

/* ------------------------------------------------------------------ Hyperliquid (incl. HIP-3 "xyz:" markets) */
function hyperliquid(id: string, coin: string, sig: number | undefined, withBook: boolean, ev: FeedEvents): Running {
  const s = new LiveSocket(`hl:${coin}`, ENDPOINTS.hlWs, {
    open: (so) => {
      so.send({ method: 'subscribe', subscription: { type: 'trades', coin } });
      if (withBook) so.send({ method: 'subscribe', subscription: sig ? { type: 'l2Book', coin, nSigFigs: sig } : { type: 'l2Book', coin } });
      ev.status(id, 'hyperliquid', true);
    },
    close: () => ev.status(id, 'hyperliquid', false),
    ping: () => JSON.stringify({ method: 'ping' }), pingMs: 45_000,
    msg: (m) => {
      if (m.channel === 'trades' && Array.isArray(m.data)) {
        // side: "B" = buy aggressor, "A" = sell aggressor
        for (const d of m.data) if (d.coin === coin) ev.trade(id, { t: +d.time, p: +d.px, q: +d.sz, s: d.side === 'B' ? 1 : -1, ex: 'hyperliquid' });
      } else if (m.channel === 'l2Book' && m.data?.levels) {
        const [b, a] = m.data.levels as { px: string; sz: string }[][];
        ev.book(id, b.map(x => [+x.px, +x.sz]), a.map(x => [+x.px, +x.sz]), true);
      }
    },
  }).start();
  return { stop: () => s.stop() };
}

/* ------------------------------------------------------------------ price-only REST poll */
function poll(id: string, sym: string, ev: FeedEvents): Running {
  let stopped = false, fails = 0, ok = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const d = await getJSON<any>(ENDPOINTS.pollRest + encodeURIComponent(sym), undefined, 5000);
      const p = +(d.mid ?? d.price ?? d.last ?? ((+d.bid + +d.ask) / 2));
      if (!isFinite(p) || p <= 0) throw new Error('no price in response');
      if (!ok) { ok = true; ev.status(id, 'poll', true); }
      fails = 0;
      ev.trade(id, { t: Date.now(), p, q: 0, s: 1, ex: 'poll' });
    } catch (e) {
      if (++fails === 3) { ok = false; ev.status(id, 'poll', false, (e as Error).message); }
    }
    setTimeout(tick, fails > 3 ? 15_000 : 1500);
  };
  tick();
  return { stop: () => { stopped = true; } };
}
