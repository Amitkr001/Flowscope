import { useEffect, useReducer, type ReactElement } from 'react';
import type { MarketData } from '../data/client';
import { net } from '../data/client';
import type { Bar, SymbolInfo } from '../lib/types';
import { fmtQ, fmtT } from '../lib/format';
import { settings } from '../lib/settings';

function useTick(ms: number) { const [, f] = useReducer(x => x + 1, 0); useEffect(() => { const h = setInterval(f, ms); return () => clearInterval(h); }, [ms]); }

export function DomDock({ md, sym, lastBar, row }: { md: MarketData; sym: SymbolInfo; lastBar: () => Bar | undefined; row: number }) {
  useTick(250);
  const px = md.lastPrice; if (!px) return <section className="dock" style={{ width: 236 }}><h5>DOM</h5><p className="muted" style={{ padding: 10 }}>Waiting for data…</p></section>;
  const bk = new Map<number, [number, number]>(); let mx = 1;
  for (const [p, q] of md.book.b) { const k = Math.floor(p / row); const e = bk.get(k) || [0, 0]; e[0] += q; bk.set(k, e); }
  for (const [p, q] of md.book.a) { const k = Math.floor(p / row); const e = bk.get(k) || [0, 0]; e[1] += q; bk.set(k, e); }
  for (const e of bk.values()) mx = Math.max(mx, e[0], e[1]);
  const lb = lastBar(), base = Math.floor(px / row), vol = new Map<number, number>();
  // bar footprint keys use round(p/row); DOM rows use floor(p/row) — map via the level price
  if (lb) for (const [k, [s, b]] of lb.fp) { const kk = Math.floor((k * row + row * 1e-6) / row); vol.set(kk, (vol.get(kk) || 0) + s + b); }
  const rows: ReactElement[] = [];
  for (let k = 22; k >= -22; k--) {
    const lv = base + k, e = bk.get(lv) || [0, 0], v = vol.get(lv) || 0;
    rows.push(<tr key={lv} className={k === 0 ? 'last' : ''}>
      <td className="bd">{e[0] > 0 && <><div className="f" style={{ width: `${Math.min(100, (e[0] / mx) * 140)}%` }} /><span>{fmtQ(e[0])}</span></>}</td>
      <td className="px">{(lv * row).toFixed(sym.dec)}</td>
      <td className="ak">{e[1] > 0 && <><div className="f" style={{ width: `${Math.min(100, (e[1] / mx) * 140)}%` }} /><span>{fmtQ(e[1])}</span></>}</td>
      <td className="vl">{v ? fmtQ(v) : ''}</td></tr>);
  }
  return (
    <section className="dock" style={{ width: 250 }} aria-label="Depth of market">
      <h5>DOM <span className="muted">{sym.hasBook ? `row ${row}` : 'no book for this market'}</span></h5>
      <div className="body"><table className="dom-t"><tbody>{rows}</tbody></table></div>
    </section>
  );
}

export function TapeDock({ md, sym, bigQ }: { md: MarketData; sym: SymbolInfo; bigQ: number }) {
  useTick(300);
  const out: ReactElement[] = [];
  for (let i = md.ticks.length - 1; i >= 0 && out.length < 120; i--) {
    const [t, p, q, s] = md.ticks[i];
    out.push(<tr key={i} className={`${s > 0 ? 'b' : 's'} ${q * p >= bigQ ? 'big' : ''}`}><td>{fmtT(t)}</td><td>{p.toFixed(sym.dec)}</td><td style={{ textAlign: 'right' }}>{fmtQ(q)}</td></tr>);
  }
  return (
    <section className="dock" style={{ width: 220 }} aria-label="Time and sales">
      <h5>Time &amp; Sales <span className="muted">bold = big</span></h5>
      <div className="body"><table className="ts-t"><tbody>{out}</tbody></table></div>
    </section>
  );
}

export function WatchDock({ cur, onPick }: { cur: string; onPick(id: string): void }) {
  const syms = net.use(s => s.symbols), watch = settings.use(s => s.watch);
  return (
    <section className="dock" style={{ width: 230 }} aria-label="Watchlist">
      <h5>Watchlist <span className="muted">{watch.length}</span></h5>
      <div className="body">
        {watch.map(id => { const s = syms.find(x => x.id === id); if (!s) return null; return (
          <div key={id} className={`wl-row ${id === cur ? 'on' : ''}`} onClick={() => onPick(id)}>
            <b>{id}</b><span>{s.last ? s.last.toFixed(s.dec) : '—'}</span>
            <small>{s.venues}</small><span className={`tag ${s.volume}`}>{s.volume === 'real' ? (s.live ? 'live' : 'idle') : 'price'}</span>
          </div>); })}
      </div>
    </section>
  );
}
