import type { ChartStyle, Drawing, Overlays } from './types';
import { createStore, loadRaw } from './store';
import { localDoc, saveDoc, pullDoc } from './api';

export interface Settings {
  sym: string; spec: string; style: ChartStyle; ov: Overlays;
  docks: { dom: boolean; tp: boolean; ts: boolean; wl: boolean };
  rowMult: number; bigUsd: Record<string, number>;
  acct: { size: number; risk: number }; magnet: boolean;
  tabs: string[]; watch: string[];
}
const DEFAULTS: Settings = {
  sym: 'BTCUSD', spec: 't:60', style: 'candles',
  ov: { bubbles: true, volume: true, vwap: false, cvd: false, delta: false, imbl: false, visp: false, dlyp: false },
  docks: { dom: false, tp: true, ts: false, wl: false },
  rowMult: 1, bigUsd: {}, acct: { size: 10_000, risk: 1 }, magnet: true,
  tabs: ['BTCUSD', 'XAUUSDT', 'SP500'], watch: ['BTCUSD', 'ETHUSD', 'SOLUSD', 'XAUUSDT', 'XAGUSDT', 'GOLD', 'SILVER', 'SP500', 'NDX', 'WTI', 'DEMO'],
};
const initial = { ...DEFAULTS, ...localDoc<Partial<Settings>>('settings', {}) };
initial.ov = { ...DEFAULTS.ov, ...initial.ov }; initial.docks = { ...DEFAULTS.docks, ...initial.docks };
export const settings = createStore<Settings>(initial);
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
  if (s) settings.set({ ...DEFAULTS, ...s, ov: { ...DEFAULTS.ov, ...s.ov }, docks: { ...DEFAULTS.docks, ...s.docks } });
  if (d) drawingsStore.set({ bySym: d });
}
export const bigFor = (id: string, def: number) => settings.get().bigUsd[id] ?? def;
export { loadRaw };
