/** 1 = buyer was the aggressor (lifted the offer), -1 = seller hit the bid. */
export type Side = 1 | -1;

/** Normalised trade from any venue. q is in base units (BTC, oz, index units…). */
export interface Trade { t: number; p: number; q: number; s: Side; ex: string }

/** Compact wire / storage format: [timeMs, price, qty, side]. */
export type Tick = [number, number, number, Side];

/** Heatmap column: time + resting liquidity per binned price ([price, size, side]). */
export interface HeatCol { t: number; l: [number, number, Side][] }

export interface Bar { t: number; o: number; h: number; l: number; c: number; v: number; b: number; s: number }

export type AssetClass = 'crypto' | 'metal' | 'index' | 'commodity' | 'fx' | 'demo';

export type SourceDef =
  | { ex: 'binance-f'; sym: string }
  | { ex: 'binance-s'; sym: string }
  | { ex: 'bybit'; sym: string }
  | { ex: 'okx'; sym: string; ct: number }
  | { ex: 'hl'; coin: string; sig?: number }
  | { ex: 'poll'; sym: string }
  | { ex: 'sim'; base: number; vol: number };

export interface SymbolDef {
  id: string;
  name: string;
  desc: string;
  cls: AssetClass;
  /** Exchange tick size. */
  tick: number;
  /** Default footprint / profile row height in price units. */
  row: number;
  /** Price decimals for display. */
  dec: number;
  /** Default "big trade" threshold in quote currency (USD). */
  bigUsd: number;
  /** 'real' = exchange prints with aggressor side; 'none' = price-only feed. */
  volume: 'real' | 'none';
  /** All trade sources. More than one = aggregated volume across venues. */
  sources: SourceDef[];
  /** Index into sources used for the order book / heatmap. -1 = none. */
  bookFrom: number;
  /** Index into sources used for historical klines. */
  klinesFrom: number;
  /** Label shown in the UI (venue names). */
  venues: string;
}

export interface FeedEvents {
  trade(symId: string, t: Trade): void;
  /** Full replace of one book side set (snapshot=true) or incremental updates. qty 0 = remove. */
  book(symId: string, bids: [number, number][], asks: [number, number][], snapshot: boolean): void;
  status(symId: string, ex: string, ok: boolean, note?: string): void;
}
