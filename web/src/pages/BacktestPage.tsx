import { useEffect, useMemo, useRef, useState } from 'react';
import { MenuBar } from '../components/MenuBar';
import { Icon } from '../lib/icons';
import { data, net } from '../data/client';
import { settings, bigFor } from '../lib/settings';
import { scripts } from '../indicators/runtime';
import { PRESETS, runBacktest, stats, type BtParams, type BtResult } from '../backtest/engine';
import { FONT, MONO, fmtUsd, hidpi, niceStep } from '../lib/format';
import type { Tick } from '../lib/types';

const TFS: [number, string][] = [[15, '15 sec'], [60, '1 min'], [180, '3 min'], [300, '5 min'], [900, '15 min'], [3600, '1 hour']];
const RANGES: [number, string][] = [[2, '2 hours'], [6, '6 hours'], [12, '12 hours'], [24, '1 day'], [48, '2 days'], [168, '7 days']];

export function BacktestPage() {
  const syms = net.use(s => s.symbols), curSym = settings.use(s => s.sym), list = scripts.use(s => s.list);
  const [sym, setSym] = useState(curSym), [tf, setTf] = useState(300), [hours, setHours] = useState(48), [mode, setMode] = useState<'tick' | 'bar'>('tick');
  const [preset, setPreset] = useState(Object.keys(PRESETS)[0]), [code, setCode] = useState(PRESETS[Object.keys(PRESETS)[0]]);
  const [P, setP] = useState({ dir: 'both' as BtParams['dir'], qty: 1, slTicks: 60, tpTicks: 120, slipTicks: 1, feePerSide: 1, exitOnOpposite: true, h1: 0, h2: 24, maxPerDay: 50 });
  const [res, setRes] = useState<BtResult | null>(null), [status, setStatus] = useState({ msg: 'Pick a strategy and press Run backtest', err: false, prog: 0 });
  const [tab, setTab] = useState<'ov' | 'tl' | 'an'>('ov'), [sel, setSel] = useState(-1), [resH, setResH] = useState(330);
  const info = syms.find(s => s.id === sym);

  // default SL/TP scale with tick size so presets make sense on every market
  useEffect(() => { if (!info) return; const base = info.row / info.tick; setP(p => ({ ...p, slTicks: Math.round(base * 6), tpTicks: Math.round(base * 12) })); }, [info?.id]);

  const run = async () => {
    if (!info) return;
    setStatus({ msg: 'Loading data…', err: false, prog: 15 });
    try {
      const to = Date.now(), from = to - hours * 3_600_000;
      let ticks: Tick[] = [], klines = undefined as any;
      if (mode === 'tick') {
        ticks = await data.ticksRange(sym, from, to);
        if (ticks.length < 50) { setStatus({ msg: `Only ${ticks.length} recorded ticks for ${sym} in that range. The server records from when it started — switch to Bar mode or shorten the range.`, err: true, prog: 0 }); return; }
      } else {
        klines = await data.klines(sym, tf, Math.min(3000, Math.ceil((hours * 3600) / tf)));
        if (!klines.length) { setStatus({ msg: 'No candle history available for this market.', err: true, prog: 0 }); return; }
      }
      setStatus({ msg: 'Running…', err: false, prog: 60 });
      await new Promise(r => setTimeout(r, 20));
      const r = runBacktest(mode === 'tick' ? { ticks } : { klines }, tf, info.row, bigFor(info.id, info.bigUsd), code, { ...P, tick: info.tick, pointValue: 1 }, list);
      setRes(r); setSel(-1);
      setStatus({ msg: `✓ ${r.trades.length} trades · ${r.ticks.toLocaleString()} ${mode === 'tick' ? 'ticks' : 'price points'} replayed in ${Math.round(r.ms)} ms`, err: false, prog: 100 });
      setTimeout(() => setStatus(s => ({ ...s, prog: 0 })), 800);
    } catch (e) { setStatus({ msg: '✗ ' + (e as Error).message, err: true, prog: 0 }); }
  };

  const s = useMemo(() => res ? stats(res.trades) : null, [res]);
  return (
    <div className="page">
      <MenuBar active="backtest" right={<><a className="btn" href="#/indicators"><Icon n="code" size={15} />Indicators</a><a className="btn" href="#/chart"><Icon n="candles" size={15} />Open chart</a></>} />
      <div className="bt-page">
        <div className="toolrow">
          <label>Symbol <select value={sym} onChange={e => setSym(e.target.value)}>{syms.map(x => <option key={x.id}>{x.id}</option>)}</select></label>
          <label>Bars <select value={tf} onChange={e => setTf(+e.target.value)}>{TFS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>History <select value={hours} onChange={e => setHours(+e.target.value)}>{RANGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
          <label>Fills <select value={mode} onChange={e => setMode(e.target.value as any)}><option value="tick">Tick-by-tick (recorded order flow)</option><option value="bar">Bar OHLC (exchange candles)</option></select></label>
          <span style={{ flex: 1 }} />
          <span style={{ color: status.err ? '#ff7a8a' : 'var(--text-2)', maxWidth: 520, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={status.msg}>{status.msg}</span>
          <div className="prog"><i style={{ width: status.prog + '%' }} /></div>
          <button className="btn pri" style={{ marginLeft: 12 }} onClick={run}><Icon n="play" size={14} />Run backtest</button>
        </div>
        <div className="bt-wrap">
          <aside className="bt-cfg">
            <div className="sec">Strategy</div>
            <div className="fld"><select value={preset} style={{ textAlign: 'left' }} onChange={e => { setPreset(e.target.value); setCode(PRESETS[e.target.value]); }} aria-label="Preset">{Object.keys(PRESETS).map(k => <option key={k}>{k}</option>)}</select></div>
            <div className="sec">Entry rule <span className="hint" style={{ textTransform: 'none', letterSpacing: 0 }}>1 long · -1 short · 0</span></div>
            <textarea className="rule" spellCheck={false} value={code} onChange={e => setCode(e.target.value)} aria-label="Entry rule"
              onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget; t.setRangeText('  ', t.selectionStart, t.selectionEnd, 'end'); setCode(t.value); } if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') run(); }} />
            <div className="hint">Runs on every closed bar <b style={{ color: '#bbb' }}>i</b> with <b style={{ color: '#bbb' }}>d</b> (order-flow series), <b style={{ color: '#bbb' }}>ta</b> helpers and <b style={{ color: '#bbb' }}>ind</b> (your saved indicators). Fills happen on the next tick — no look-ahead.</div>
            <div className="sec">Direction</div>
            <div className="seg">{(['both', 'long', 'short'] as const).map(v => <span key={v} className={P.dir === v ? 'on' : ''} onClick={() => setP({ ...P, dir: v })}>{v[0].toUpperCase() + v.slice(1)}</span>)}</div>
            <div className="sec">Risk</div>
            <div className="row2"><div className="fld">Qty<input type="number" value={P.qty} step={0.01} onChange={e => setP({ ...P, qty: +e.target.value })} /></div><div className="fld">Max/day<input type="number" value={P.maxPerDay} onChange={e => setP({ ...P, maxPerDay: +e.target.value })} /></div></div>
            <div className="row2"><div className="fld">SL tk<input type="number" value={P.slTicks} onChange={e => setP({ ...P, slTicks: +e.target.value })} /></div><div className="fld">TP tk<input type="number" value={P.tpTicks} onChange={e => setP({ ...P, tpTicks: +e.target.value })} /></div></div>
            <div className="row2"><div className="fld">Slip tk<input type="number" value={P.slipTicks} onChange={e => setP({ ...P, slipTicks: +e.target.value })} /></div><div className="fld">Fee $<input type="number" value={P.feePerSide} step={0.1} onChange={e => setP({ ...P, feePerSide: +e.target.value })} /></div></div>
            <div className="hint">Tick size {info?.tick} → SL {info ? (P.slTicks * info.tick).toPrecision(4) : '—'} · TP {info ? (P.tpTicks * info.tick).toPrecision(4) : '—'} price units</div>
            <div className="fld"><span className="mini"><span className={`chk ${P.exitOnOpposite ? 'on' : ''}`} onClick={() => setP({ ...P, exitOnOpposite: !P.exitOnOpposite })} role="checkbox" aria-checked={P.exitOnOpposite} />Exit on opposite signal</span></div>
            <div className="sec">Session (local time)</div>
            <div className="row2"><div className="fld">From<input type="number" min={0} max={23} value={P.h1} onChange={e => setP({ ...P, h1: +e.target.value })} /></div><div className="fld">To<input type="number" min={1} max={24} value={P.h2} onChange={e => setP({ ...P, h2: +e.target.value })} /></div></div>
            <div className="hint" style={{ marginTop: 8 }}>{info?.recordedFrom ? `Tick data for ${sym} recorded since ${new Date(info.recordedFrom).toLocaleString()}.` : `No tick data recorded for ${sym} yet — use Bar mode.`}</div>
          </aside>
          <section className="bt-center" style={{ gridTemplateRows: `1fr 6px ${resH}px` }}>
            <BtChart res={res} dec={info?.dec ?? 2} sel={sel} title={`${sym} · ${TFS.find(x => x[0] === tf)?.[1]} · ${preset}`} />
            <div className="bt-split" onMouseDown={e => { const y0 = e.clientY, h0 = resH; const mv = (ev: MouseEvent) => setResH(Math.max(160, Math.min(window.innerHeight - 260, h0 - (ev.clientY - y0)))); const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); }; addEventListener('mousemove', mv); addEventListener('mouseup', up); }} />
            <div className="bt-res">
              <div className="rtabs">{([['ov', 'Overview'], ['tl', 'List of trades'], ['an', 'Analysis']] as const).map(([k, l]) => <div key={k} className={`rtab ${tab === k ? 'on' : ''}`} onClick={() => setTab(k)}>{l}</div>)}</div>
              {tab === 'ov' && <div className="rpane"><div className="ov">
                <div className="kpis">{s && <>
                  <div className="kpi hero"><div><small>Net profit</small><b className={s.net >= 0 ? 'pos' : 'neg'}>{fmtUsd(s.net)}</b></div><div style={{ textAlign: 'right' }}><small>Profit factor</small><b>{isFinite(s.pf) ? s.pf.toFixed(2) : '∞'}</b></div></div>
                  {([['Total trades', s.n, ''], ['Win rate', s.wr.toFixed(1) + '%', s.wr >= 50 ? 'pos' : ''], ['Max drawdown', fmtUsd(-s.dd), 'neg'], ['Avg win', fmtUsd(s.aw), 'pos'], ['Avg loss', fmtUsd(-s.al), 'neg'], ['Expectancy', fmtUsd(s.exp), s.exp >= 0 ? 'pos' : 'neg'], ['Gross profit', fmtUsd(s.gw), 'pos'], ['Gross loss', fmtUsd(-s.gl), 'neg'], ['SQN', s.sqn.toFixed(2), '']] as [string, any, string][]).map(([l, v, c]) => <div className="kpi" key={l}><small>{l}</small><b className={c}>{v}</b></div>)}
                </>}</div>
                <div className="eqbox"><Equity curve={s?.curve || [0]} /></div>
              </div></div>}
              {tab === 'tl' && <div className="rpane"><table className="grid"><thead><tr><th>#</th><th>Side</th><th>Entry time</th><th>Entry</th><th>Exit time</th><th>Exit</th><th>Reason</th><th>MAE</th><th>MFE</th><th style={{ textAlign: 'right' }}>P&amp;L $</th><th style={{ textAlign: 'right' }}>Cum. $</th></tr></thead><tbody>
                {(() => { let cum = 0; return res?.trades.map((t, i) => { cum += t.pnl; return (
                  <tr key={i} className={sel === i ? 'sel' : ''} style={{ cursor: 'pointer' }} onClick={() => setSel(i)}>
                    <td>{i + 1}</td><td className={t.dir > 0 ? 'pos' : 'neg'}>{t.dir > 0 ? 'Long' : 'Short'}</td><td>{new Date(t.et).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</td><td>{t.entry.toFixed(info?.dec)}</td><td>{new Date(t.xt).toLocaleTimeString('en-GB')}</td><td>{t.exit.toFixed(info?.dec)}</td><td>{t.why}</td><td className="neg">{t.mae.toFixed(info?.dec)}</td><td className="pos">{t.mfe.toFixed(info?.dec)}</td><td style={{ textAlign: 'right' }} className={t.pnl >= 0 ? 'pos' : 'neg'}>{t.pnl.toFixed(2)}</td><td style={{ textAlign: 'right' }}>{cum.toFixed(2)}</td>
                  </tr>); }); })()}
                {res && !res.trades.length && <tr><td colSpan={11} className="muted">No trades — loosen the rule, widen the session or try another range.</td></tr>}
              </tbody></table></div>}
              {tab === 'an' && res && <div className="rpane"><Analysis res={res} /></div>}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Equity({ curve }: { curve: number[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const { ctx: x, w, h } = hidpi(ref.current!); const c = curve, mn = Math.min(...c), mx = Math.max(...c, mn + 1);
      const Y = (v: number) => 12 + ((mx - v) / (mx - mn)) * (h - 34), X = (i: number) => 8 + (i / (c.length - 1 || 1)) * (w - 70);
      x.fillStyle = '#1f1f1f'; x.fillRect(0, 0, w, h); x.strokeStyle = '#2c2c2c'; x.fillStyle = '#888'; x.font = `11px ${FONT}`;
      const gs = niceStep((mx - mn) / 4 || 1); for (let v = Math.ceil(mn / gs) * gs; v <= mx; v += gs) { x.beginPath(); x.moveTo(8, Y(v)); x.lineTo(w - 62, Y(v)); x.stroke(); x.fillText(fmtUsd(v).replace('.00', ''), w - 58, Y(v) + 4); }
      let pk = 0; x.fillStyle = '#8a45b433'; x.beginPath(); x.moveTo(X(0), Y(0)); c.forEach((v, i) => { pk = Math.max(pk, v); x.lineTo(X(i), Y(pk)); }); for (let i = c.length - 1; i >= 0; i--) x.lineTo(X(i), Y(c[i])); x.fill();
      const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, '#01d40355'); g.addColorStop(1, '#01d40300');
      x.beginPath(); c.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.strokeStyle = c[c.length - 1] >= 0 ? '#01d403' : '#a66be0'; x.lineWidth = 2; x.stroke(); x.lineTo(X(c.length - 1), h); x.lineTo(X(0), h); x.fillStyle = g; x.fill(); x.lineWidth = 1;
      x.fillStyle = '#bbb'; x.font = `12px ${FONT}`; x.fillText('Equity curve · purple = drawdown', 12, h - 8);
    };
    draw(); const ro = new ResizeObserver(draw); ro.observe(ref.current!); return () => ro.disconnect();
  }, [curve]);
  return <canvas ref={ref} />;
}

function Bars({ vals, label, cols }: { vals: number[]; label: (i: number) => string; cols?: string[] }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const draw = () => {
      const { ctx: x, w, h } = hidpi(ref.current!); x.fillStyle = '#1f1f1f'; x.fillRect(0, 0, w, h);
      const m = Math.max(...vals.map(Math.abs), 1e-9), neg = vals.some(v => v < 0), base = neg ? (h - 18) / 2 : h - 18, bw = (w - 16) / (vals.length || 1);
      vals.forEach((v, i) => { const hh = (v / m) * (neg ? (h - 26) / 2 : h - 26); x.fillStyle = cols ? cols[i] : v >= 0 ? '#01d403' : '#8a45b4'; x.fillRect(8 + i * bw + 1, Math.min(base, base - hh), bw - 2, Math.abs(hh)); x.fillStyle = '#777'; x.font = '10px Arial'; x.textAlign = 'center'; const t = label(i); if (t) x.fillText(t, 8 + i * bw + bw / 2, h - 5); });
      x.strokeStyle = '#333'; x.beginPath(); x.moveTo(8, base); x.lineTo(w - 8, base); x.stroke();
    };
    draw(); const ro = new ResizeObserver(draw); ro.observe(ref.current!); return () => ro.disconnect();
  }, [vals]);
  return <canvas ref={ref} />;
}

function Analysis({ res }: { res: BtResult }) {
  const byH = new Array(24).fill(0); res.trades.forEach(t => { byH[new Date(t.et).getHours()] += t.pnl; });
  const ps = res.trades.map(t => t.pnl), mn = Math.min(...ps, 0), mx = Math.max(...ps, 0), nb = 16, bw = (mx - mn) / nb || 1, bins = new Array(nb).fill(0);
  ps.forEach(p => { bins[Math.min(nb - 1, Math.floor((p - mn) / bw))]++; });
  const L = stats(res.trades.filter(t => t.dir > 0)), S = stats(res.trades.filter(t => t.dir < 0));
  const row = (l: string, a: any, b: any) => <tr key={l}><td className="muted">{l}</td><td>{a}</td><td>{b}</td></tr>;
  return (
    <div className="an">
      <div className="abox"><h6>P&amp;L by hour of day (local)</h6><Bars vals={byH} label={i => (i % 3 ? '' : String(i).padStart(2, '0'))} /></div>
      <div className="abox"><h6>Trade P&amp;L distribution</h6><Bars vals={bins} label={i => (i % 4 ? '' : String(Math.round(mn + i * bw)))} cols={bins.map((_, i) => (mn + (i + 0.5) * bw >= 0 ? '#01d403' : '#8a45b4'))} /></div>
      <div className="abox"><h6>Long vs short</h6><div style={{ overflow: 'auto' }}><table className="grid"><thead><tr><th /><th>Long</th><th>Short</th></tr></thead><tbody>
        {row('Trades', L.n, S.n)}{row('Net', <span className={L.net >= 0 ? 'pos' : 'neg'}>{fmtUsd(L.net)}</span>, <span className={S.net >= 0 ? 'pos' : 'neg'}>{fmtUsd(S.net)}</span>)}
        {row('Win rate', L.wr.toFixed(1) + '%', S.wr.toFixed(1) + '%')}{row('Profit factor', isFinite(L.pf) ? L.pf.toFixed(2) : '∞', isFinite(S.pf) ? S.pf.toFixed(2) : '∞')}
        {row('Avg win', fmtUsd(L.aw), fmtUsd(S.aw))}{row('Avg loss', fmtUsd(-L.al), fmtUsd(-S.al))}
      </tbody></table></div></div>
    </div>
  );
}

function BtChart({ res, dec, sel, title }: { res: BtResult | null; dec: number; sel: number; title: string }) {
  const ref = useRef<HTMLCanvasElement>(null), v = useRef({ cw: 6, off: 0 }), leg = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (res && sel >= 0) { const t = res.trades[sel]; v.current.cw = Math.max(v.current.cw, 8); v.current.off = res.bars.length - 1 - t.ei - (ref.current!.clientWidth * 0.45) / v.current.cw; }
    else if (res && sel < 0) { v.current.off = 0; v.current.cw = Math.max(2, Math.min(9, ((ref.current?.clientWidth || 800) / Math.max(1, res.bars.length)) * 2.2)); }
  }, [res, sel]);
  useEffect(() => {
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const cv = ref.current; if (!cv) return; const { ctx: C, w: W, h: H } = hidpi(cv);
      C.fillStyle = '#1a1a1a'; C.fillRect(0, 0, W, H);
      if (!res || !res.bars.length) { C.fillStyle = '#666'; C.font = `14px ${FONT}`; C.textAlign = 'center'; C.fillText('Pick a strategy and press Run backtest', W / 2, H / 2); C.textAlign = 'left'; return; }
      const bars = res.bars, n = bars.length, axisW = 78, timeH = 22, plotW = W - axisW, mainH = H - timeH, cw = v.current.cw;
      const xOf = (i: number) => plotW - 30 - (n - 1 - i) * cw + v.current.off * cw, iOf = (x: number) => n - 1 - (plotW - 30 + v.current.off * cw - x) / cw;
      const first = Math.max(0, Math.floor(iOf(0)) - 1), last = Math.min(n - 1, Math.ceil(iOf(plotW)) + 1);
      let lo = Infinity, hi = -Infinity; for (let i = first; i <= last; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); } const pd = (hi - lo) * 0.08 || 1; lo -= pd; hi += pd;
      const yOf = (p: number) => ((hi - p) / (hi - lo)) * mainH;
      C.save(); C.beginPath(); C.rect(0, 0, plotW, mainH); C.clip();
      res.trades.forEach((t, k) => { if (t.xi < first - 2 || t.ei > last + 2) return; const x1 = xOf(t.ei), x2 = Math.max(x1 + 3, xOf(t.xi)); C.globalAlpha = sel === -1 || sel === k ? 1 : 0.35;
        C.fillStyle = '#01d40322'; C.fillRect(x1, yOf(Math.max(t.tp, t.entry)), x2 - x1, Math.abs(yOf(t.tp) - yOf(t.entry))); C.fillStyle = '#8a45b42e'; C.fillRect(x1, yOf(Math.max(t.sl, t.entry)), x2 - x1, Math.abs(yOf(t.sl) - yOf(t.entry))); C.globalAlpha = 1; });
      for (let i = first; i <= last; i++) { const c = bars[i], x = Math.round(xOf(i)), bw = Math.max(1, Math.round(cw * 0.66)); C.fillStyle = c.c >= c.o ? '#01d403' : '#7a33bf'; C.fillRect(x, yOf(c.h), 1, Math.max(1, yOf(c.l) - yOf(c.h))); const y1 = yOf(Math.max(c.o, c.c)); C.fillRect(x - Math.floor(bw / 2), y1, bw, Math.max(1, yOf(Math.min(c.o, c.c)) - y1)); }
      res.trades.forEach((t, k) => { if (t.xi < first - 2 || t.ei > last + 2) return; const x1 = xOf(t.ei), x2 = xOf(t.xi), y1 = yOf(t.entry), y2 = yOf(t.exit), win = t.pnl >= 0;
        C.strokeStyle = win ? '#42da45' : '#b27ae6'; C.setLineDash([4, 3]); C.beginPath(); C.moveTo(x1, y1); C.lineTo(x2, y2); C.stroke(); C.setLineDash([]);
        C.fillStyle = t.dir > 0 ? '#42da45' : '#b27ae6'; C.beginPath(); if (t.dir > 0) { C.moveTo(x1, y1 + 4); C.lineTo(x1 - 6, y1 + 14); C.lineTo(x1 + 6, y1 + 14); } else { C.moveTo(x1, y1 - 4); C.lineTo(x1 - 6, y1 - 14); C.lineTo(x1 + 6, y1 - 14); } C.fill();
        C.strokeStyle = '#fff'; C.lineWidth = 1.6; C.beginPath(); C.moveTo(x2 - 4, y2 - 4); C.lineTo(x2 + 4, y2 + 4); C.moveTo(x2 + 4, y2 - 4); C.lineTo(x2 - 4, y2 + 4); C.stroke(); C.lineWidth = 1;
        if (sel === k || cw >= 10) { C.font = `11px ${FONT}`; const s = (win ? '+' : '') + t.pnl.toFixed(2), tw = C.measureText(s).width + 8; C.fillStyle = win ? '#0e5b0d' : '#4a1f6f'; C.fillRect(x2 + 6, y2 - 8, tw, 16); C.fillStyle = '#fff'; C.textBaseline = 'middle'; C.fillText(s, x2 + 10, y2); } });
      C.restore();
      C.fillStyle = '#1a1a1a'; C.fillRect(plotW, 0, axisW, H); C.fillStyle = '#2f2e31'; C.fillRect(plotW, 0, 1, mainH);
      C.fillStyle = '#dcdcdc'; C.font = `12.5px ${FONT}`; C.textBaseline = 'middle'; const gs = niceStep((hi - lo) / 8); for (let p = Math.ceil(lo / gs) * gs; p < hi; p += gs) C.fillText(p.toFixed(dec), plotW + 8, yOf(p));
      C.fillStyle = '#1a1a1a'; C.fillRect(0, mainH, plotW, timeH); C.fillStyle = '#3a3a3a'; C.fillRect(0, mainH, W, 1); C.fillStyle = '#bbb'; C.textAlign = 'center';
      const ev = Math.max(1, Math.ceil(100 / cw)); for (let i = first; i <= last; i++) if (i % ev === 0) { const x = xOf(i); if (x > 30 && x < plotW - 30) C.fillText(new Date(bars[i].t).toLocaleString('en-GB', { day: '2-digit', hour: '2-digit', minute: '2-digit' }), x, mainH + timeH / 2); }
      C.textAlign = 'left';
      if (leg.current) { const st = stats(res.trades); const html = `<span style="color:#ddd">${title}</span> &nbsp; <span class="${st.net >= 0 ? 'pos' : 'neg'}">${fmtUsd(st.net)}</span> <span class="muted">· ${st.n} trades · ▲ entry ✕ exit · green/purple = target/stop</span>`; if (leg.current.innerHTML !== html) leg.current.innerHTML = html; }
    };
    draw(); return () => cancelAnimationFrame(raf);
  }, [res, sel, dec, title]);
  useEffect(() => {
    const cv = ref.current!; let drag: { x: number; off: number } | null = null;
    const down = (e: MouseEvent) => { drag = { x: e.clientX, off: v.current.off }; };
    const move = (e: MouseEvent) => { if (drag) v.current.off = drag.off + (e.clientX - drag.x) / v.current.cw; };
    const up = () => { drag = null; };
    const wheel = (e: WheelEvent) => { e.preventDefault(); v.current.cw = Math.max(1, Math.min(60, v.current.cw * (e.deltaY < 0 ? 1.12 : 1 / 1.12))); };
    cv.addEventListener('mousedown', down); addEventListener('mousemove', move); addEventListener('mouseup', up); cv.addEventListener('wheel', wheel, { passive: false });
    return () => { cv.removeEventListener('mousedown', down); removeEventListener('mousemove', move); removeEventListener('mouseup', up); cv.removeEventListener('wheel', wheel); };
  }, []);
  return <div className="bt-chart"><canvas ref={ref} /><div className="bt-leg" ref={leg} style={{ fontFamily: MONO }} /></div>;
}
