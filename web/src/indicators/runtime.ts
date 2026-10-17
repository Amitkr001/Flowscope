import type { Plot } from '../lib/types';
import type { Series } from '../data/bars';
import { TA } from '../lib/ta';
import { createStore } from '../lib/store';
import { localDoc, saveDoc, pullDoc } from '../lib/api';

export interface Script { id: string; name: string; on: boolean; inputs: { k: string; label: string; v: number }[]; code: string }

const cache = new Map<string, { code: string; fn: Function | null; err: string | null }>();
function compile(s: Script) {
  const c = cache.get(s.id);
  if (c && c.code === s.code) return c;
  let fn: Function | null = null, err: string | null = null;
  try { fn = new Function('d', 'ta', 'input', '"use strict";\n' + s.code); } catch (e) { err = (e as Error).message; }
  const r = { code: s.code, fn, err }; cache.set(s.id, r); return r;
}

/** Runs a user script against series data. Scripts run only in the user's own browser. */
export function runScript(s: Script, d: Series): { plots: Plot[]; err: string | null; ms: number } {
  const t0 = performance.now();
  const c = compile(s);
  if (c.err || !c.fn) return { plots: [], err: c.err, ms: 0 };
  try {
    const input: Record<string, number> = {}; for (const x of s.inputs || []) input[x.k] = +x.v;
    const out = c.fn(d, TA, input);
    if (!Array.isArray(out)) return { plots: [], err: 'Script must return an array of plots', ms: performance.now() - t0 };
    for (const p of out) if (!p || !Array.isArray(p.values)) return { plots: [], err: 'Every plot needs a values array (same length as d.close)', ms: performance.now() - t0 };
    return { plots: out.map((p: Plot) => ({ name: p.name || 'Plot', values: p.values, color: p.color || '#4da3ff', pane: p.pane === 'sub' ? 'sub' : 'main', type: p.type || 'line' })), err: null, ms: performance.now() - t0 };
  } catch (e) { return { plots: [], err: (e as Error).message, ms: performance.now() - t0 }; }
}

export const SAMPLE_SCRIPTS: Script[] = [
  { id: 's1', name: 'Delta Spike', on: false, inputs: [{ k: 'mult', label: 'Multiplier', v: 2.5 }, { k: 'len', label: 'Lookback', v: 20 }],
    code: `// Mark bars where |delta| is much larger than its average
const abs = d.delta.map(Math.abs);
const avg = ta.sma(abs, input.len);
const dots = d.delta.map((v, i) => {
  if (!avg[i] || Math.abs(v) < avg[i] * input.mult) return null;
  return v > 0 ? d.low[i] : d.high[i];
});
return [{ name: 'Delta Spike', values: dots, color: '#ffd23f', pane: 'main', type: 'dots' }];` },
  { id: 's2', name: 'Big Trade Pressure', on: false, inputs: [{ k: 'len', label: 'Smoothing', v: 5 }],
    code: `// Big buyer volume minus big seller volume, smoothed
const raw = d.bigBuy.map((b, i) => b - d.bigSell[i]);
return [{ name: 'Big Pressure', values: ta.ema(raw, input.len), color: '#42da45', pane: 'sub', type: 'hist' }];` },
];

export const scripts = createStore<{ list: Script[] }>({ list: localDoc<Script[] | null>('scripts', null) ?? SAMPLE_SCRIPTS });
export function saveScripts(list: Script[]) { scripts.set({ list }); saveDoc('scripts', list); }
export async function syncScripts() { const l = await pullDoc<Script[]>('scripts'); if (l) scripts.set({ list: l }); }
