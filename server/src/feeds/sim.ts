/** Deterministic order-flow simulator — keeps the app usable when exchanges are unreachable. */
import type { FeedEvents, SymbolDef, Trade, Side } from '../types.ts';

type SimSrc = { ex: 'sim'; base: number; vol: number };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export class SimGen {
  private R: () => number;
  p: number; private anchor: number; private trend = 0; private flow = 0;
  private def: SymbolDef; private src: SimSrc;
  constructor(def: SymbolDef, src: SimSrc, seed = 7) { this.def = def; this.src = src; this.R = rng(seed); this.p = this.anchor = src.base; }
  private randn() { return Math.sqrt(-2 * Math.log(this.R() + 1e-12)) * Math.cos(2 * Math.PI * this.R()); }
  next(t: number): Trade {
    const R = this.R, v = this.src.vol;
    if (R() < 0.0015) this.trend = (R() - 0.5) * v * 0.06;
    this.anchor += this.trend + this.randn() * v * 0.18;
    this.flow = this.flow * 0.97 + (R() - 0.5) * 0.12;
    const pull = Math.max(-0.25, Math.min(0.25, (this.anchor - this.p) / (v * 60)));
    const buy = R() < 0.5 + pull + this.flow;
    let q = Math.exp(this.randn() * 0.9 - 0.7);
    if (R() < 0.012) q *= 6 + R() * 25;
    const big = this.def.bigUsd / this.p;
    const sz = Math.min(4, (q / Math.max(big, 1e-9)) * 3);
    this.p += (buy ? 1 : -1) * v * (R() < 0.5 ? 0 : 0.4 + R() * 0.8) * (1 + sz);
    const tk = this.def.tick;
    return { t, p: +(Math.round(this.p / tk) * tk).toFixed(8), q: +q.toFixed(3), s: (buy ? 1 : -1) as Side, ex: 'sim' };
  }
  history(minutes: number): Trade[] {
    const out: Trade[] = [];
    let t = Date.now() - minutes * 60_000;
    while (t < Date.now()) { out.push(this.next(t)); t += -Math.log(this.R() + 1e-9) * 420; }
    return out;
  }
  book(price = this.p, now = Date.now()): { bids: [number, number][]; asks: [number, number][] } {
    const tk = this.def.tick, base = Math.round(price / tk), ep = Math.floor(now / (20 * 60_000));
    const h = (n: number) => { n = Math.sin(n * 12.9898 + 78.233) * 43758.5453; return n - Math.floor(n); };
    const bids: [number, number][] = [], asks: [number, number][] = [];
    for (let k = 1; k <= 400; k++) {
      for (const side of [-1, 1]) {
        const lv = base + side * k;
        let s = (0.2 + h(lv * 0.37 + ep) * 0.8) * (1 + k / 60) * (h(lv * 0.91) > 0.55 ? 1 : 0.15);
        if (h(lv * 1.73 + ep * 3.1) > 0.985) s += 30 + h(lv + ep) * 90;
        if (h(lv * 0.11 + ep * 7.7) > 0.997) s += 160;
        s *= 0.85 + 0.3 * this.R();
        (side < 0 ? bids : asks).push([+(lv * tk).toFixed(8), +s.toFixed(3)]);
      }
    }
    return { bids, asks };
  }
}

const gens = new Map<string, SimGen>();
export function simGen(def: SymbolDef): SimGen {
  let g = gens.get(def.id);
  if (!g) { g = new SimGen(def, def.sources[0] as SimSrc, def.id.length * 131 + 7); gens.set(def.id, g); }
  return g;
}

export function startSim(def: SymbolDef, _src: SimSrc, ev: FeedEvents) {
  const g = simGen(def);
  ev.status(def.id, 'sim', true);
  const a = setInterval(() => { const n = 1 + Math.floor(Math.random() * 4); for (let i = 0; i < n; i++) ev.trade(def.id, g.next(Date.now())); }, 160);
  const b = setInterval(() => { const bk = g.book(); ev.book(def.id, bk.bids, bk.asks, true); }, 250);
  return { stop: () => { clearInterval(a); clearInterval(b); } };
}
