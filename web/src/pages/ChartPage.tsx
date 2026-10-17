import { useEffect, useMemo, useRef, useState } from 'react';
import { MenuBar } from '../components/MenuBar';
import { LeftToolbar } from '../components/LeftToolbar';
import { DrawingBar } from '../components/DrawingBar';
import { StatusBar } from '../components/StatusBar';
import { TradingPanel } from '../components/TradingPanel';
import { DomDock, TapeDock, WatchDock } from '../components/Docks';
import { SymbolSearch } from '../components/SymbolSearch';
import { ChartEngine } from '../chart/engine';
import { data, net, type MarketData } from '../data/client';
import { BAR_SPECS, parseSpec, specKey, specLabel } from '../data/bars';
import { settings, saveDrawings, drawingsStore, bigFor } from '../lib/settings';
import { scripts, saveScripts, runScript } from '../indicators/runtime';
import { PaperBroker } from '../lib/paper';
import { Icon } from '../lib/icons';
import { toast } from '../lib/api';
import type { Drawing, Overlays } from '../lib/types';

const ROW_MULTS = [1, 2, 4, 5, 10, 20, 50];

export function ChartPage() {
  const st = settings.use(s => s);
  const syms = net.use(s => s.symbols), connected = net.use(s => s.connected);
  const list = scripts.use(s => s.list);
  const sym = syms.find(s => s.id === st.sym) || syms.find(s => s.id === 'DEMO') || syms[0];
  const cvRef = useRef<HTMLCanvasElement>(null), legRef = useRef<HTMLDivElement>(null);
  const gImb = useRef<HTMLElement>(null), gCvd = useRef<HTMLElement>(null), gImbT = useRef<HTMLSpanElement>(null), gCvdT = useRef<HTMLSpanElement>(null);
  const eng = useRef<ChartEngine | null>(null);
  const [md, setMd] = useState<MarketData | null>(null);
  const [broker, setBroker] = useState<PaperBroker | null>(null);
  const [selD, setSelD] = useState<Drawing | null>(null);
  const [tool, setTool] = useState('cursor');
  const [search, setSearch] = useState<null | 'switch' | 'tab'>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; p: number } | null>(null);
  const [replay, setReplay] = useState<{ idx: number; on: boolean; speed: number } | null>(null);
  const [lockAll, setLockAll] = useState(false), [hideAll, setHideAll] = useState(false);
  const [statusTick, setStatusTick] = useState(0);
  const spec = parseSpec(st.spec);
  const bigUsd = sym ? bigFor(sym.id, sym.bigUsd) : 1e9;

  /* engine lifecycle */
  useEffect(() => {
    const e = new ChartEngine(cvRef.current!, { style: st.style, ov: st.ov, spec, rowMult: st.rowMult, bigUsd, acct: st.acct, magnet: st.magnet });
    e.cb = {
      select: d => setSelD(d ? { ...d } : null),
      tool: t => setTool(t),
      context: (ev, p) => setMenu({ x: ev.clientX, y: ev.clientY, p }),
      legend: html => { if (legRef.current && legRef.current.innerHTML !== html) legRef.current.innerHTML = html; },
      gauges: (imb, cvd) => {
        if (!gImb.current) return;
        gImb.current.style.left = Math.max(0, Math.min(96, 50 + (imb / (Math.abs(imb) + 20)) * 48)) + '%';
        gCvd.current!.style.left = Math.max(0, Math.min(96, 50 + (cvd / (Math.abs(cvd) + 300)) * 48)) + '%';
        gImbT.current!.textContent = 'Imb: ' + Math.round(imb); gCvdT.current!.textContent = 'Cvd: ' + Math.round(cvd);
      },
    };
    eng.current = e;
    return () => { e.destroy(); eng.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* market subscription */
  useEffect(() => {
    if (!sym) return;
    const m = data.get(sym.id); setMd(m);
    const b = new PaperBroker(sym.id); b.tickSize = sym.tick; b.onChange = (msg) => { if (msg) toast(msg); eng.current?.invalidate(); };
    setBroker(b);
    const off = m.on((ev, d) => { if (ev === 'tk') b.onTicks(d); if (ev === 'snap' && m.ticks.length) b.last = m.lastPrice; if (ev === 'st' || ev === 'snap') setStatusTick(x => x + 1); });
    if (m.ready) b.last = m.lastPrice;
    const e = eng.current!;
    e.paper = b;
    e.setOptions({ bigUsd: bigFor(sym.id, sym.bigUsd) });
    e.setMarket(m, sym);
    e.cb.drawings = list => saveDrawings(sym.id, list);
    e.setDrawings(JSON.parse(JSON.stringify(drawingsStore.get().bySym[sym.id] || [])));
    setReplay(null); e.replayIdx = null;
    return () => { off(); data.release(sym.id); };
  }, [sym?.id]);

  /* options → engine */
  useEffect(() => { eng.current?.setOptions({ style: st.style, ov: st.ov, spec, rowMult: st.rowMult, bigUsd, acct: st.acct, magnet: st.magnet }); }, [st.style, st.ov, st.spec, st.rowMult, bigUsd, st.acct, st.magnet]);
  useEffect(() => { if (eng.current) { eng.current.hidden = hideAll; eng.current.invalidate(); } }, [hideAll]);
  useEffect(() => { const e = eng.current; if (!e) return; e.drawings.forEach(d => { d.locked = lockAll; }); e.invalidate(); }, [lockAll]);

  /* custom indicators (recomputed every second) */
  useEffect(() => {
    const run = () => {
      const e = eng.current; if (!e || !e.bars.length) return;
      const on = scripts.get().list.filter(s => s.on); if (!on.length) { if (e.plots.length) { e.plots = []; e.invalidate(); } return; }
      const d = e.series(); const plots = on.flatMap(s => runScript(s, d).plots);
      e.plots = plots; e.invalidate();
    };
    run(); const h = setInterval(run, 1000); return () => clearInterval(h);
  }, [list]);

  /* replay */
  useEffect(() => {
    const e = eng.current; if (!e) return;
    if (!replay) { e.replayIdx = null; e.invalidate(); return; }
    e.replayIdx = replay.idx; e.invalidate();
    if (!replay.on) return;
    const h = setInterval(() => setReplay(r => r && ({ ...r, idx: Math.min(r.idx + 1, (e.B?.bars.length || 0)) })), replay.speed);
    return () => clearInterval(h);
  }, [replay]);

  /* keyboard shortcuts */
  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement)?.tagName === 'INPUT' || (ev.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      if (ev.altKey) { const m: Record<string, string> = { t: 'trend', h: 'hline', v: 'vline', f: 'fib', r: 'rect', l: 'long', s: 'short' }; const t = m[ev.key.toLowerCase()]; if (t) { ev.preventDefault(); eng.current?.setTool(t); } }
      if (ev.key === '/' || (ev.ctrlKey && ev.key.toLowerCase() === 'k')) { ev.preventDefault(); setSearch('switch'); }
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, []);
  useEffect(() => { const c = () => setMenu(null); window.addEventListener('mousedown', c); return () => window.removeEventListener('mousedown', c); }, []);

  const setSym = (id: string) => settings.set(s => ({ sym: id, tabs: s.tabs.includes(id) ? s.tabs : [...s.tabs, id].slice(-10) }));
  const toggleOv = (k: keyof Overlays) => settings.set(s => ({ ov: { ...s.ov, [k]: !s.ov[k] } }));
  const statusPill = useMemo(() => {
    if (!connected) return { cls: 'off', txt: 'Offline' };
    const s = md ? Object.values(md.status) : []; const ok = s.filter(x => x.ok).length;
    if (!s.length) return { cls: 'warn', txt: 'Connecting' };
    return ok === s.length ? { cls: '', txt: `Live · ${ok}/${s.length}` } : ok ? { cls: 'warn', txt: `Partial · ${ok}/${s.length}` } : { cls: 'off', txt: 'Venue offline' };
  }, [connected, md, statusTick]);
  const row = sym ? sym.row * st.rowMult : 1;

  return (
    <div className="page">
      <MenuBar active="chart"
        center={<>
          <button className="dd box" onClick={() => setSearch('switch')} title="Symbol search ( / )"><Icon n="search" size={14} />{sym?.id || '…'}</button>
          <select className="dd box" value={st.spec} onChange={e => settings.set({ spec: e.target.value })} aria-label="Bar type">
            {BAR_SPECS.map(s => <option key={specKey(s)} value={specKey(s)}>{specLabel(s)}</option>)}
          </select>
          <select className="dd box" value={st.rowMult} onChange={e => settings.set({ rowMult: +e.target.value })} aria-label="Footprint row size" title="Footprint / profile row size">
            {ROW_MULTS.map(m => <option key={m} value={m}>Row {+(sym ? sym.row * m : m).toPrecision(6)}</option>)}
          </select>
        </>}
        right={<div className="feed" title={md ? Object.entries(md.status).map(([k, v]) => `${k}: ${v.ok ? 'connected' : v.note || 'offline'}`).join('\n') : ''}>
          <span className="muted" style={{ fontSize: 12.5 }}>{sym?.venues}</span>
          <span className={`pill ${statusPill.cls}`}><i />{statusPill.txt}</span>
        </div>} />

      <div className="chart-page">
        <div className="chart-work">
          <LeftToolbar tool={tool} onTool={t => eng.current?.setTool(t)} magnet={st.magnet} onMagnet={() => settings.set(s => ({ magnet: !s.magnet }))}
            locked={lockAll} onLock={() => setLockAll(v => !v)} hidden={hideAll} onHide={() => setHideAll(v => !v)}
            onUndo={() => eng.current?.undoDraw()} onRedo={() => eng.current?.redoDraw()}
            onClear={() => { if (confirm('Remove all drawings on ' + sym?.id + '?')) eng.current?.clearDrawings(); }}
            onShot={() => { const a = document.createElement('a'); a.download = `flowscope-${sym?.id}-${Date.now()}.png`; a.href = eng.current!.screenshot(); a.click(); }} />
          <div className="stage">
            <div className="chart-box">
              <canvas ref={cvRef} aria-label={`${sym?.id} chart`} />
              <div className="legend" ref={legRef} style={{ display: st.style === 'heatmap' ? 'none' : 'block' }} />
              <div className="gauges" style={{ display: st.style === 'heatmap' ? 'flex' : 'none' }}>
                <div className="g"><div className="bar"><i ref={gImb as any} style={{ background: '#ff2a2a', left: '50%' }} /></div><span ref={gImbT}>Imb: 0</span></div>
                <div className="g"><div className="bar"><i ref={gCvd as any} style={{ background: '#18e0f0', left: '50%' }} /></div><span ref={gCvdT}>Cvd: 0</span></div>
              </div>
              {selD && <DrawingBar d={selD} onPatch={p => eng.current?.updateSelected(p)} onClone={() => eng.current?.cloneSelected()} onDelete={() => eng.current?.deleteSelected()} />}
              {!connected && <div className="conn-banner">Disconnected from the FlowScope server — reconnecting…</div>}
              <button className="replay-btn" title="Bar replay" aria-label="Bar replay" onClick={() => { const n = eng.current?.B?.bars.length || 0; setReplay(r => r ? null : { idx: Math.max(20, n - 150), on: true, speed: 300 }); }}><Icon n="play" /></button>
              <button className="replay-btn" style={{ right: 116 }} title="Auto-scale price (double-click price axis)" aria-label="Auto scale" onClick={() => eng.current?.resetY()}><Icon n="autoscale" size={13} /></button>
              {replay && (
                <div className="replay-bar">
                  <span style={{ color: 'var(--accent-hi)', fontWeight: 600, marginRight: 4 }}>REPLAY</span>
                  <button className="tb" aria-label="Back 60 bars" onClick={() => setReplay(r => r && { ...r, idx: Math.max(5, r.idx - 60) })}><Icon n="back" /></button>
                  <button className="tb" aria-label="Play or pause" onClick={() => setReplay(r => r && { ...r, on: !r.on })}><Icon n={replay.on ? 'pause' : 'play'} /></button>
                  <button className="tb" aria-label="Step one bar" onClick={() => setReplay(r => r && { ...r, on: false, idx: r.idx + 1 })}><Icon n="step" /></button>
                  <select value={replay.speed} onChange={e => setReplay(r => r && { ...r, speed: +e.target.value })} aria-label="Replay speed"><option value={900}>1x</option><option value={300}>3x</option><option value={90}>10x</option><option value={20}>50x</option></select>
                  <span className="muted" style={{ minWidth: 150, marginLeft: 6 }}>{eng.current?.B?.bars[replay.idx - 1] ? new Date(eng.current.B.bars[replay.idx - 1].t).toLocaleString('en-GB') : ''}</span>
                  <button className="tb" aria-label="Exit replay" onClick={() => setReplay(null)}><Icon n="close" /></button>
                </div>
              )}
            </div>
            {st.docks.wl && <WatchDock cur={sym?.id || ''} onPick={setSym} />}
            {st.docks.dom && md && sym && <DomDock md={md} sym={sym} row={row} lastBar={() => eng.current?.B?.bars[eng.current.B.bars.length - 1]} />}
            {st.docks.ts && md && sym && <TapeDock md={md} sym={sym} bigQ={bigUsd} />}
          </div>
          {st.docks.tp && broker && sym ? <TradingPanel broker={broker} sym={sym} syms={syms} onSym={setSym} /> : <div />}
        </div>

        <StatusBar style={st.style} onStyle={s => settings.set({ style: s, ...(s === 'heatmap' && (spec.kind !== 'time' || spec.sec >= 60) ? { spec: 't:15' } : {}), ...(s !== 'heatmap' && st.style === 'heatmap' && spec.kind === 'time' && spec.sec < 60 ? { spec: 't:60' } : {}) })}
          ov={st.ov} onOv={toggleOv} scripts={list} onScript={id => saveScripts(list.map(s => s.id === id ? { ...s, on: !s.on } : s))}
          docks={st.docks} onDock={k => settings.set(s => ({ docks: { ...s.docks, [k]: !s.docks[k] } }))} />

        <div className="wtabs">
          {st.tabs.map(id => (
            <div key={id} className={`wtab ${id === sym?.id ? 'on' : ''}`} onClick={() => setSym(id)}>
              {id}
              {st.tabs.length > 1 && <span className="x" onClick={e => { e.stopPropagation(); settings.set(s => { const tabs = s.tabs.filter(x => x !== id); return { tabs, sym: s.sym === id ? tabs[0] : s.sym }; }); }} aria-label={`Close ${id}`}>×</span>}
            </div>
          ))}
          <div className="wtab" title="Add chart tab" onClick={() => setSearch('tab')}>+</div>
        </div>
      </div>

      {search && <SymbolSearch onClose={() => setSearch(null)} onPick={id => { setSym(id); setSearch(null); }} />}
      {menu && (
        <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} onMouseDown={e => e.stopPropagation()}>
          {selD && <><div onClick={() => { eng.current?.cloneSelected(); setMenu(null); }}>Clone drawing</div><div onClick={() => { eng.current?.deleteSelected(); setMenu(null); }}>Delete drawing</div><hr /></>}
          {broker && sym && <>
            <div onClick={() => { broker.place('lmt', 1, 1, +menu.p.toFixed(sym.dec)); setMenu(null); }}>Buy limit 1 @ {menu.p.toFixed(sym.dec)}</div>
            <div onClick={() => { broker.place('lmt', -1, 1, +menu.p.toFixed(sym.dec)); setMenu(null); }}>Sell limit 1 @ {menu.p.toFixed(sym.dec)}</div><hr />
          </>}
          <div onClick={() => { const e = eng.current!; e.setTool('hline'); setMenu(null); toast('Click the chart to place the level'); }}>Add horizontal line</div>
          <div onClick={() => { eng.current?.goLive(); setMenu(null); }}>Reset view (go live)</div>
          <div onClick={() => { eng.current?.resetY(); setMenu(null); }}>Auto-scale price</div>
          <div onClick={() => { settings.set(s => ({ watch: s.watch.includes(sym!.id) ? s.watch : [...s.watch, sym!.id] })); setMenu(null); toast(`${sym?.id} added to watchlist`); }}>Add {sym?.id} to watchlist</div>
        </div>
      )}
    </div>
  );
}
