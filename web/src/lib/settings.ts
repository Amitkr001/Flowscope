import type { ChartStyle, Drawing, FpMode, Overlays } from './types';
import { createStore, loadRaw } from './store';
import { localDoc, saveDoc, pullDoc } from './api';

export interface Settings {
  sym: string; spec: string; style: ChartStyle; ov: Overlays;
  docks: { dom: boolean; tp: boolean; ts: boolean; wl: boolean };
  rowMult: number; bigUsd: Record<string, number>;
  acct: { size: number; risk: number }; magnet: boolean;
  tabs: string[]; watch: string[];
  /** footprint cell display: bid x ask, delta per price, or volume per price */
  fpMode: FpMode;
}
const DEFAULTS: Settings = {
  sym: 'BTCUSD', spec: 't:60', style: 'candles',
  ov: { bubbles: true, volume: true, vwap: false, cvd: false, delta: false, imbl: true, visp: false, dlyp: false, stats: true, walls: true },
  docks: { dom: false, tp: true, ts: false, wl: false },
  rowMult: 1, bigUsd: {}, acct: { size: 10_000, risk: 1 }, magnet: true,
  tabs: ['BTCUSD', 'XAUUSDT', 'SP500'], watch: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XAUUSDT', 'XAGUSDT', 'GOLD', 'SILVER', 'SP500', 'NDX', 'WTI', 'DEMO'],
  fpMode: 'ba',
};

const FP_MODES: FpMode[] = ['ba', 'delta', 'vol'];

/** Merge saved settings with defaults so new keys always exist and bad values are reset. */
function normalize(s: Partial<Settings>): Settings {
  const out: Settings = {
    ...DEFAULTS, ...s,
    ov: { ...DEFAULTS.ov, ...(s.ov || {}) },
    docks: { ...DEFAULTS.docks, ...(s.docks || {}) },
    acct: { ...DEFAULTS.acct, ...(s.acct || {}) },
  };
  if (!FP_MODES.includes(out.fpMode)) out.fpMode = DEFAULTS.fpMode;
  if (!Array.isArray(out.tabs) || !out.tabs.length) out.tabs = DEFAULTS.tabs;
  if (!Array.isArray(out.watch)) out.watch = DEFAULTS.watch;
  return out;
}

export const settings = createStore<Settings>(normalize(localDoc<Partial<Settings>>('settings', {})));
settings.subscribe(() => saveDoc('settings', settings.get()));

/* ---- drawings per symbol ---- */
export const drawingsStore = createStore<{ bySym: Record<string, Drawing[]> }>({ bySym: localDoc('drawings', {}) });
export function saveDrawings(sym: string, list: Drawing[]) {
  drawingsStore.set(s => ({ bySym: { ...s.bySym, [sym]: list } }));
  saveDoc('drawings', drawingsStore.get().bySym);
}

/** After sign-in: pull cloud copies (cloud wins if present). */
export async function syncFromCloud() {
  const [s, d] = await Promise.all([pullDoc<Settings>('settings'), pullDoc<Record<string, Drawing[]>>('drawings')]);
  if (s) settings.set(normalize(s));
  if (d) drawingsStore.set({ bySym: d });
}
export const bigFor = (id: string, def: number) => settings.get().bigUsd[id] ?? def;
export { loadRaw };
