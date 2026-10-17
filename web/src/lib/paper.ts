/** Simulated (paper) broker: market/limit/stop orders, OCO brackets, realised & open P&L. No real money. */
import type { Tick } from './types';
import { loadRaw, saveRaw } from './store';

export interface Order { id: number; type: 'lmt' | 'stp'; side: 1 | -1; qty: number; px: number; oco?: boolean }
export interface Fill { t: number; side: 1 | -1; qty: number; px: number; pnl: number }

export class PaperBroker {
  sym: string;
  pos = { qty: 0, avg: 0 };
  realized = 0;
  orders: Order[] = [];
  fills: Fill[] = [];
  oco = { on: false, sl: 20, tp: 40 };
  last = 0;
  private id = 1;
  onChange: (msg?: string) => void = () => {};

  constructor(sym: string) {
    this.sym = sym;
    const s = loadRaw<any>(`fs.paper.${sym}`, null);
    if (s) { this.pos = s.pos; this.realized = s.realized; this.orders = s.orders; this.fills = s.fills || []; this.oco = s.oco || this.oco; this.id = s.id || 1; }
  }
  private save() { saveRaw(`fs.paper.${this.sym}`, { pos: this.pos, realized: this.realized, orders: this.orders, fills: this.fills.slice(-200), oco: this.oco, id: this.id }); }

  openPnl(px = this.last) { return this.pos.qty ? (px - this.pos.avg) * this.pos.qty : 0; }

  exec(side: 1 | -1, qty: number, px: number) {
    const p = this.pos; let pnl = 0;
    if (!p.qty || Math.sign(p.qty) === side) { p.avg = (p.avg * Math.abs(p.qty) + px * qty) / (Math.abs(p.qty) + qty); p.qty = +(p.qty + side * qty).toFixed(8); }
    else {
      const close = Math.min(qty, Math.abs(p.qty)); pnl = (px - p.avg) * close * Math.sign(p.qty); this.realized += pnl;
      p.qty = +(p.qty + side * qty).toFixed(8);
      if (p.qty && Math.sign(p.qty) === side) p.avg = px;
      if (!p.qty) p.avg = 0;
    }
    this.fills.push({ t: Date.now(), side, qty, px, pnl });
    this.orders = this.orders.filter(o => !o.oco);
    if (this.oco.on && p.qty) this.bracket();
    this.save(); this.onChange(`${side > 0 ? 'Bought' : 'Sold'} ${qty} @ ${px} (paper)`);
  }
  bracket(tick = this.tickSize) {
    const p = this.pos, s = Math.sign(p.qty) as 1 | -1; if (!p.qty) return;
    this.orders = this.orders.filter(o => !o.oco);
    this.orders.push({ id: this.id++, type: 'stp', side: (-s) as 1 | -1, qty: Math.abs(p.qty), px: +(p.avg - s * this.oco.sl * tick).toFixed(8), oco: true });
    this.orders.push({ id: this.id++, type: 'lmt', side: (-s) as 1 | -1, qty: Math.abs(p.qty), px: +(p.avg + s * this.oco.tp * tick).toFixed(8), oco: true });
  }
  tickSize = 1;
  place(type: 'lmt' | 'stp', side: 1 | -1, qty: number, px: number) {
    this.orders.push({ id: this.id++, type, side, qty, px }); this.save();
    this.onChange(`${type.toUpperCase()} ${side > 0 ? 'BUY' : 'SELL'} ${qty} @ ${px} working`);
  }
  cancelAll() { this.orders = []; this.save(); this.onChange('All working orders cancelled'); }
  breakeven() {
    if (!this.pos.qty) return this.onChange('No open position');
    this.orders = this.orders.filter(o => o.type !== 'stp');
    this.orders.push({ id: this.id++, type: 'stp', side: (-Math.sign(this.pos.qty)) as 1 | -1, qty: Math.abs(this.pos.qty), px: this.pos.avg, oco: true });
    this.save(); this.onChange('Stop moved to breakeven');
  }
  flatten() { this.orders = []; if (this.pos.qty) this.exec((-Math.sign(this.pos.qty)) as 1 | -1, Math.abs(this.pos.qty), this.last); else { this.save(); this.onChange('Flat'); } }
  reset() { this.pos = { qty: 0, avg: 0 }; this.realized = 0; this.orders = []; this.fills = []; this.save(); this.onChange('Paper account reset'); }

  onTicks(ts: Tick[]) {
    for (const [, p] of ts) {
      this.last = p;
      for (const o of [...this.orders]) {
        const hit = o.type === 'lmt' ? (o.side > 0 ? p <= o.px : p >= o.px) : (o.side > 0 ? p >= o.px : p <= o.px);
        if (hit) { this.orders = this.orders.filter(x => x.id !== o.id); this.exec(o.side, o.qty, o.px); }
      }
    }
  }
}
