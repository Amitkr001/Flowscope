/** Persists compressed ticks + heat columns to MongoDB in time buckets (no-op without Mongo). */
import type { HeatCol, Tick } from '../types.ts';
import { mongo } from './mongo.ts';
import { log } from '../log.ts';

const tickBuf = new Map<string, Tick[]>();
const heatBuf = new Map<string, HeatCol[]>();
let enabled: boolean | null = null;

mongo().then(db => { enabled = !!db; if (!enabled) { tickBuf.clear(); heatBuf.clear(); } });

async function flush() {
  if (!enabled) return;
  const db = await mongo(); if (!db) return;
  const now = new Date();
  for (const [sym, arr] of tickBuf) {
    if (!arr.length) continue;
    tickBuf.set(sym, []);
    try { await db.collection('ticks').insertOne({ sym, t0: arr[0][0], t1: arr[arr.length - 1][0], d: arr, at: now }); }
    catch (e) { log.warn(`persist ticks ${sym}: ${(e as Error).message}`); }
  }
  for (const [sym, arr] of heatBuf) {
    if (arr.length < 30) continue;   // ~30 s per document
    heatBuf.set(sym, []);
    try { await db.collection('heat').insertOne({ sym, t0: arr[0].t, t1: arr[arr.length - 1].t, d: arr, at: now }); }
    catch (e) { log.warn(`persist heat ${sym}: ${(e as Error).message}`); }
  }
}
setInterval(flush, 5000);

export const persist = {
  tick(sym: string, t: Tick) {
    if (enabled === false) return;
    let a = tickBuf.get(sym); if (!a) tickBuf.set(sym, (a = []));
    a.push(t);
  },
  heat(sym: string, c: HeatCol) {
    if (enabled === false) return;
    let a = heatBuf.get(sym); if (!a) heatBuf.set(sym, (a = []));
    a.push(c);
  },
  async ticksRange(sym: string, from: number, to: number): Promise<Tick[]> {
    const db = await mongo(); if (!db) return [];
    const docs = await db.collection('ticks').find({ sym, t1: { $gte: from }, t0: { $lte: to } }).sort({ t0: 1 }).limit(20_000).toArray();
    const out: Tick[] = [];
    for (const d of docs) for (const t of d.d as Tick[]) if (t[0] >= from && t[0] <= to) out.push(t);
    return out;
  },
  async heatRange(sym: string, from: number, to: number): Promise<HeatCol[]> {
    const db = await mongo(); if (!db) return [];
    const docs = await db.collection('heat').find({ sym, t1: { $gte: from }, t0: { $lte: to } }).sort({ t0: 1 }).limit(2000).toArray();
    return docs.flatMap((d: any) => (d.d as HeatCol[]).filter(c => c.t >= from && c.t <= to));
  },
};
