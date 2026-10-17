import { useEffect, useReducer, useState } from 'react';
import type { PaperBroker } from '../lib/paper';
import type { SymbolInfo } from '../lib/types';

const money = (v: number) => (v < 0 ? '-' : '') + Math.abs(v).toFixed(2).replace('.', ',') + ' $';

export function TradingPanel({ broker, sym, syms, onSym }: { broker: PaperBroker; sym: SymbolInfo; syms: SymbolInfo[]; onSym(id: string): void }) {
  const [, force] = useReducer(x => x + 1, 0);
  const [qty, setQty] = useState(1), [ticks, setTicks] = useState(4), [useTicks, setUseTicks] = useState(true);
  useEffect(() => { const h = setInterval(force, 400); return () => clearInterval(h); }, []);
  const open = broker.openPnl(), daily = broker.realized + open;
  const px = broker.last, tk = sym.tick;
  const order = (o: string, side: 1 | -1) => {
    if (!px) return;
    const q = Math.max(tk, qty), off = (useTicks ? ticks : 0) * tk;
    if (o === 'mkt') return broker.exec(side, q, +(px + side * tk).toFixed(sym.dec));
    if (o === 'bid') return broker.place('lmt', side, q, +(px - tk).toFixed(sym.dec));
    if (o === 'ask') return broker.place('lmt', side, q, +(px + tk).toFixed(sym.dec));
    if (o === 'lmt') return broker.place('lmt', side, q, +(px - side * off).toFixed(sym.dec));
    if (o === 'stp' || o === 'stplmt') return broker.place('stp', side, q, +(px + side * off).toFixed(sym.dec));
  };
  const col = (v: number) => ({ color: v > 0 ? 'var(--bull-2)' : v < 0 ? '#b980ef' : undefined });
  return (
    <aside className="side" aria-label="Paper trading panel">
      <div className="fld big"><select value={sym.id} onChange={e => onSym(e.target.value)} style={{ textAlign: 'left' }} aria-label="Symbol">{syms.map(s => <option key={s.id}>{s.id}</option>)}</select></div>
      <div className="gap" />
      <div className="fld">Open Qty <b>{+broker.pos.qty.toFixed(6)}</b></div>
      <div className="fld">Open P/L <b style={col(open)}>{money(open)}</b></div>
      <div className="fld">Daily P/L <b style={col(daily)}>{money(daily)}</b></div>
      <div className="gap" />
      <div className="row2"><div className="fld">Qty</div><div className="fld"><input type="number" value={qty} min={0} step={sym.cls === 'crypto' ? 0.01 : 1} onChange={e => setQty(+e.target.value)} aria-label="Order quantity" /></div></div>
      <div className="fld">Broker <b>PAPER</b></div>
      <div className="fld">Account <b>SIM 1</b></div>
      <div className="fld"><span className="mini"><span className={`chk ${useTicks ? 'on' : ''}`} onClick={() => setUseTicks(!useTicks)} role="checkbox" aria-checked={useTicks} />Ticks diff.</span><input type="number" value={ticks} onChange={e => setTicks(+e.target.value)} style={{ width: 50 }} aria-label="Ticks offset" /></div>
      <div className="hd"><span>BUY</span><span>SELL</span></div>
      {[['MKT', 'mkt', 'mkt'], ['BID', 'bid', 'ask'], ['LMT', 'lmt', 'lmt'], ['STP', 'stp', 'stp'], ['STP LMT', 'stplmt', 'stplmt']].map(([l, b, s]) => (
        <div className="row2" key={l}><button className="ob b" onClick={() => order(b, 1)}>{l}</button><button className="ob s" onClick={() => order(s, -1)}>{l === 'BID' ? 'ASK' : l}</button></div>
      ))}
      <div className="row2" style={{ marginTop: 2 }}><button className="ob o" onClick={() => broker.cancelAll()}>Cancel</button><button className="ob o" onClick={() => broker.breakeven()}>Breakeven</button></div>
      <button className="ob of" onClick={() => broker.flatten()}>Cancel and Flat</button>
      <div className="gap" />
      <div className="ptitle">OCO Strategy <span className={`sw ${broker.oco.on ? 'on' : ''}`} role="switch" aria-checked={broker.oco.on} onClick={() => { broker.oco.on = !broker.oco.on; if (broker.oco.on) broker.bracket(); force(); }} /></div>
      <div className={broker.oco.on ? '' : 'disabled'} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="fld">Mode <b>SL/TP</b></div>
        <div className="row2"><div className="fld">SL tk<input type="number" value={broker.oco.sl} onChange={e => { broker.oco.sl = +e.target.value; force(); }} /></div><div className="fld">TP tk<input type="number" value={broker.oco.tp} onChange={e => { broker.oco.tp = +e.target.value; force(); }} /></div></div>
      </div>
      <div className="gap" />
      <div className="ptitle">Working orders <span className="muted">{broker.orders.length}</span></div>
      {broker.orders.slice(-6).map(o => <div key={o.id} className="muted" style={{ fontSize: 12 }}>{o.type.toUpperCase()} {o.side > 0 ? 'BUY' : 'SELL'} {o.qty} @ {o.px}</div>)}
      <button className="btn" style={{ marginTop: 6, justifyContent: 'center' }} onClick={() => { if (confirm('Reset the paper account for ' + sym.id + '?')) broker.reset(); }}>Reset paper account</button>
      <p className="muted" style={{ fontSize: 11 }}>Paper trading only. No orders are sent to any exchange.</p>
    </aside>
  );
}
