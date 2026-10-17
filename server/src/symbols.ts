import type { SymbolDef } from './types.ts';

/**
 * Symbol catalog. Edit freely — every entry is data-driven.
 *
 * Crypto: perpetual futures from Binance + Bybit + OKX are merged into one aggregated tape
 *         (the largest share of crypto volume). Book/heatmap comes from Binance Futures.
 * Metals: Binance Futures TradFi perps (XAUUSDT / XAGUSDT) and Hyperliquid trade.xyz HIP-3 perps.
 *         Both are real venues with real prints and order books (not CME volume).
 * Indices / commodities: Hyperliquid trade.xyz HIP-3 perps (S&P 500, Nasdaq-100, WTI, Brent).
 * FX / other indices: price-only REST feed (no volume) — clearly labelled in the UI.
 * DEMO: built-in simulator so the app always works, even offline.
 */
export const SYMBOLS: SymbolDef[] = [
  // ---------- crypto (aggregated) ----------
  { id: 'BTCUSD', name: 'BTCUSD', desc: 'Bitcoin · aggregated perps', cls: 'crypto', tick: 0.1, row: 5, dec: 1, bigUsd: 250_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'BTCUSDT' }, { ex: 'bybit', sym: 'BTCUSDT' }, { ex: 'okx', sym: 'BTC-USDT-SWAP', ct: 0.01 }],
    bookFrom: 0, klinesFrom: 0, venues: 'Binance · Bybit · OKX' },
  { id: 'ETHUSD', name: 'ETHUSD', desc: 'Ethereum · aggregated perps', cls: 'crypto', tick: 0.01, row: 0.5, dec: 2, bigUsd: 150_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'ETHUSDT' }, { ex: 'bybit', sym: 'ETHUSDT' }, { ex: 'okx', sym: 'ETH-USDT-SWAP', ct: 0.1 }],
    bookFrom: 0, klinesFrom: 0, venues: 'Binance · Bybit · OKX' },
  { id: 'SOLUSD', name: 'SOLUSD', desc: 'Solana · aggregated perps', cls: 'crypto', tick: 0.01, row: 0.05, dec: 2, bigUsd: 75_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'SOLUSDT' }, { ex: 'bybit', sym: 'SOLUSDT' }, { ex: 'okx', sym: 'SOL-USDT-SWAP', ct: 1 }],
    bookFrom: 0, klinesFrom: 0, venues: 'Binance · Bybit · OKX' },
  { id: 'XRPUSD', name: 'XRPUSD', desc: 'XRP · aggregated perps', cls: 'crypto', tick: 0.0001, row: 0.001, dec: 4, bigUsd: 50_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'XRPUSDT' }, { ex: 'bybit', sym: 'XRPUSDT' }, { ex: 'okx', sym: 'XRP-USDT-SWAP', ct: 100 }],
    bookFrom: 0, klinesFrom: 0, venues: 'Binance · Bybit · OKX' },
  { id: 'DOGEUSD', name: 'DOGEUSD', desc: 'Dogecoin · aggregated perps', cls: 'crypto', tick: 0.00001, row: 0.0002, dec: 5, bigUsd: 50_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'DOGEUSDT' }, { ex: 'bybit', sym: 'DOGEUSDT' }, { ex: 'okx', sym: 'DOGE-USDT-SWAP', ct: 1000 }],
    bookFrom: 0, klinesFrom: 0, venues: 'Binance · Bybit · OKX' },
  { id: 'HYPEUSD', name: 'HYPEUSD', desc: 'Hyperliquid HYPE perp', cls: 'crypto', tick: 0.001, row: 0.02, dec: 3, bigUsd: 50_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'HYPE', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid' },

  // ---------- metals ----------
  { id: 'XAUUSDT', name: 'XAUUSDT', desc: 'Gold · Binance Futures TradFi perp', cls: 'metal', tick: 0.01, row: 0.5, dec: 2, bigUsd: 100_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'XAUUSDT' }], bookFrom: 0, klinesFrom: 0, venues: 'Binance Futures' },
  { id: 'XAGUSDT', name: 'XAGUSDT', desc: 'Silver · Binance Futures TradFi perp', cls: 'metal', tick: 0.001, row: 0.02, dec: 3, bigUsd: 50_000, volume: 'real',
    sources: [{ ex: 'binance-f', sym: 'XAGUSDT' }], bookFrom: 0, klinesFrom: 0, venues: 'Binance Futures' },
  { id: 'GOLD', name: 'GOLD', desc: 'Gold · Hyperliquid trade.xyz perp', cls: 'metal', tick: 0.1, row: 0.5, dec: 1, bigUsd: 100_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:GOLD', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },
  { id: 'SILVER', name: 'SILVER', desc: 'Silver · Hyperliquid trade.xyz perp', cls: 'metal', tick: 0.001, row: 0.02, dec: 3, bigUsd: 50_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:SILVER', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },

  // ---------- indices ----------
  { id: 'SP500', name: 'SP500', desc: 'S&P 500 · Hyperliquid trade.xyz perp', cls: 'index', tick: 0.1, row: 1, dec: 1, bigUsd: 100_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:SP500', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },
  { id: 'NDX', name: 'NDX', desc: 'Nasdaq-100 (XYZ100) · Hyperliquid trade.xyz perp', cls: 'index', tick: 1, row: 5, dec: 0, bigUsd: 100_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:XYZ100', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },

  // ---------- commodities ----------
  { id: 'WTI', name: 'WTI', desc: 'WTI crude oil · Hyperliquid trade.xyz perp', cls: 'commodity', tick: 0.001, row: 0.05, dec: 3, bigUsd: 75_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:CL', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },
  { id: 'BRENT', name: 'BRENT', desc: 'Brent crude oil · Hyperliquid trade.xyz perp', cls: 'commodity', tick: 0.001, row: 0.05, dec: 3, bigUsd: 75_000, volume: 'real',
    sources: [{ ex: 'hl', coin: 'xyz:BRENTOIL', sig: 4 }], bookFrom: 0, klinesFrom: 0, venues: 'Hyperliquid · trade.xyz' },

  // ---------- price-only (no real volume exists for these via free feeds) ----------
  // Symbol names follow the biquote.io catalogue — verify at https://biquote.io/api/symbols
  { id: 'EURUSD', name: 'EURUSD', desc: 'Euro / US Dollar · price only', cls: 'fx', tick: 0.00001, row: 0.0001, dec: 5, bigUsd: 1e12, volume: 'none',
    sources: [{ ex: 'poll', sym: 'EURUSD' }], bookFrom: -1, klinesFrom: -1, venues: 'biquote.io (price only)' },
  { id: 'GER40', name: 'GER40', desc: 'DAX 40 CFD · price only', cls: 'index', tick: 0.1, row: 5, dec: 1, bigUsd: 1e12, volume: 'none',
    sources: [{ ex: 'poll', sym: 'GER40' }], bookFrom: -1, klinesFrom: -1, venues: 'biquote.io (price only)' },
  { id: 'JP225', name: 'JP225', desc: 'Nikkei 225 CFD · price only', cls: 'index', tick: 1, row: 10, dec: 0, bigUsd: 1e12, volume: 'none',
    sources: [{ ex: 'poll', sym: 'JP225' }], bookFrom: -1, klinesFrom: -1, venues: 'biquote.io (price only)' },

  // ---------- demo ----------
  { id: 'DEMO', name: 'DEMO', desc: 'Simulated order flow (always available)', cls: 'demo', tick: 0.5, row: 5, dec: 1, bigUsd: 1_000_000, volume: 'real',
    sources: [{ ex: 'sim', base: 67250, vol: 1.6 }], bookFrom: 0, klinesFrom: 0, venues: 'Simulator' },
];

export const SYMBOL_MAP = new Map(SYMBOLS.map(s => [s.id, s]));
