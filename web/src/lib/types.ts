export type Side = 1 | -1;
export type Tick = [number, number, number, Side];           // [time, price, qty, side]
export interface HeatCol { t: number; l: [number, number, Side][] }
export interface Book { b: [number, number][]; a: [number, number][] }

export interface SymbolInfo {
  id: string; name: string; desc: string; cls: string;
  tick: number; row: number; dec: number; bigUsd: number;
  volume: 'real' | 'none'; venues: string; hasBook: boolean;
  last: number; live: boolean; recordedFrom: number | null;
}

/** Candle with footprint. fp key = round(price/row); value = [sellVol, buyVol]. */
export interface Bar {
  t: number; o: number; h: number; l: number; c: number;
  v: number; b: number; s: number;
  fp: Map<number, [number, number]>;
  big: Tick[];
  /** true when built from klines (no tick detail) */
  k?: boolean;
  /** true when buy/sell split is unknown */
  est?: boolean;
}

export interface KBar { t: number; o: number; h: number; l: number; c: number; v: number; b: number; s: number }

export type BarSpec = { kind: 'time'; sec: number } | { kind: 'vol'; size: number } | { kind: 'tick'; count: number };

export type ChartStyle = 'candles' | 'footprint' | 'heatmap';

/** Footprint cell display: bid × ask numbers, delta per price, or total volume per price. */
export type FpMode = 'ba' | 'delta' | 'vol';

export interface Overlays {
  bubbles: bo
