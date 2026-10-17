import { useEffect, useMemo, useRef, useState } from 'react';
import { MenuBar } from '../components/MenuBar';
import { Icon } from '../lib/icons';
import { BUILTIN, CATS, NEW_SCRIPT, TEMPLATES, type Builtin } from '../indicators/builtin';
import { runScript, saveScripts, scripts, type Script } from '../indicators/runtime';
import { settings } from '../lib/settings';
import { data } from '../data/client';
import { BarBuilder, buildSeries, type Series } from '../data/bars';
import type { Bar, Plot } from '../lib/types';
import { hidpi, uid } from '../lib/format';
import { toast } from '../lib/api';

/** 1-minute bars of the current chart symbol for previews. */
function usePreviewBars(): { bars: Bar[]; d: Series | null; sym: string } {
  const sym = settings.use(s => s.sym);
  const [st, setSt] = useState<{ bars: Bar[]; d: Series | null }>({ bars: [], d: null });
  useEffect(() => {
    const md = data.get(sym); let k: any[] = [];
    const build = () => { const b = new BarBuilder({ kind: 'time', sec: 60 }, 1, 1e12); b.addAll(md.ticks); b.seedKlines(k, false); const bars = b.bars.slice(-240); setSt({ bars, d: buildSeries(bars) }); };
    data.klines(sym, 60, 400).then(x => { k = x; build(); });
    const off = md.on(e => { if (e === 'snap') build(); });
    if (md.ready) build();
    const h = setInterval(build, 5000);
    return () => { off(); clearInterval(h); data.release(sym); };
  }, [sym]);
  return { ...st, sym };
}

function drawPreview(cv: HTMLCanvasElement, bars: Bar[], d: Series | null, kind: string, plots?: Plot[]) {
  const { ctx, w, h } = hidpi(cv);
  ctx.fillStyle = kind === 'footprint' ? '#151521' : '#1a1a1a'; ctx.fillRect(0, 0, w, h);
  if (!bars.length || !d) { ctx.fillStyle = '#555'; ctx.font = '12px Segoe UI, Arial'; ctx.textAlign = 'center'; ctx.fillText('Waiting for data…', w / 2, h / 2); ctx.textAlign = 'left'; return; }
  const n = bars.length, from = Math.max(0, n - 90), N = n - from;
  const hasSub = (plots && plots.some(p => p.pane === 'sub')) || ['cvd', 'delta', 'volume'].includes(kind);
  const subH = hasSub ? h * 0.32 : 0, mh = h - subH - 4;
  let lo = Infinity, hi = -Infinity; for (let i = from; i < n; i++) { lo = Math.min(lo, bars[i].l); hi = Math.max(hi, bars[i].h); }
  const pad = (hi - lo) * 0.08 || 1; lo -= pad; hi += pad;
  const cw = w / N, X = (i: number) => (i - from + 0.5) * cw, Y = (p: number) => 4 + ((hi - p) / (hi - lo)) * (mh - 8);
  if (kind === 'footprint') {
    const fw = w / 8; for (let j = 0; j < 7; j++) { const c = bars[n - 7 + j]; if (!c) continue; const x = j * fw + 10; ctx.fillStyle = c.c >= c.o ? '#01d403' : '#8a2ae0'; ctx.fillRect(x, 8, 2, mh - 16);
      for (let r = 0; r < 7; r++) { const y = 10 + r * 14, buy = Math.sin(j * 7 + r) > 0, strong = Math.abs(Math.sin(j * 3 + r * 2)) > 0.8; ctx.fillStyle = buy ? (strong ? '#4db84f' : '#8ab88b') : (strong ? '#8a45b4' : '#a795b6'); ctx.fillRect(x + 5, y, 10 + Math.abs(Math.sin(j + r)) * fw * 0.35, 11); if (r === 3) { ctx.strokeStyle = '#e6e62a'; ctx.strokeRect(x + 5.5, y + 0.5, fw * 0.75, 10); } } }
    return;
  }
  if (kind === 'heatmap') { for (let i = from; i < n; i++) for (let k = 0; k < 40; k++) { const s = Math.abs(Math.sin(k * 3.7 + i * 0.02) * Math.cos(k * 1.3)); if (s > 0.55) { ctx.fillStyle = `rgba(${k > 20 ? '138,69,180' : '40,160,60'},${s * 0.8})`; ctx.fillRect(X(i) - cw / 2, (k / 40) * mh, cw + 1, mh / 40 + 1); } } }
  for (let i = from; i < n; i++) { const c = bars[i]; ctx.fillStyle = c.c >= c.o ? '#01d403' : '#7a33bf'; ctx.fillRect(X(i), Y(c.h), 1, Math.max(1, Y(c.l) - Y(c.h))); const bw = Math.max(1, cw * 0.6); ctx.fillRect(X(i) - bw / 2, Y(Math.max(c.o, c.c)), bw, Math.max(1, Y(Math.min(c.o, c.c)) - Y(Math.max(c.o, c.c)))); }
  const line = (v: (number | null)[], col: string, sub = false) => { let a = Infinity, b = -Infinity; if (sub) { for (let i = from; i < n; i++) if (v[i] != null) { a = Math.min(a, v[i]!); b = Math.max(b, v[i]!); } if (a === b) { a--; b++; } } ctx.strokeStyle = col; ctx.lineWidth = 1.4; ctx.beginPath(); let s = false; for (let i = from; i < n; i++) { const y0 = v[i]; if (y0 == null) { s = false; continue; } const y = sub ? mh + 6 + ((b - y0) / (b - a)) * (subH - 10) : Y(y0); s ? ctx.lineTo(X(i), y) : ctx.moveTo(X(i), y); s = true; } ctx.stroke(); ctx.lineWidth = 1; };
  const hist = (v: (number | null)[], col: string) => { let m = 0; for (let i = from; i < n; i++) if (v[i] != null) m = Math.max(m, Math.abs(v[i]!)); const mid = mh + subH / 2; for (let i = from; i < n; i++) { const y = v[i]; if (y == null) continue; const hh = (y / (m || 1)) * (subH / 2 - 4); ctx.fillStyle = y >= 0 ? col : '#8a45b4'; ctx.fillRect(X(i) - cw * 0.3, Math.min(mid, mid - hh), Math.max(1, cw * 0.6), Math.abs(hh)); } };
  if (subH) { ctx.fillStyle = '#333'; ctx.fillRect(0, mh + 2, w, 1); }
  if (kind === 'bubbles') for (let i = from; i < n; i++) { const c = bars[i]; if (c.v > (d.volume.slice(from).reduce((a, b) => a + b, 0) / N) * 1.8) { ctx.strokeStyle = c.b > c.s ? '#14c814' : '#6a2fa8'; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(X(i), Y(c.c), 6, 0, 7); ctx.stroke(); } }
  if (kind === 'vwap') line(d.vwap, '#fff');
  if (kind === 'cvd') line(d.cvd, '#18e0f0', true);
  if (kind === 'delta') hist(d.delta, '#42da45');
  if (kind === 'volume') hist(d.volume, '#01d403');
  if (kind === 'visp' || kind === 'dlyp') { const pr = new Map<number, number>(); let mx = 0; const step = (hi - lo) / 30; for (let i = from; i < n; i++) { const k = Math.round(bars[i].c / step); const v = (pr.get(k) || 0) + bars[i].v; pr.set(k, v); mx = Math.max(mx, v); } for (const [k, v] of pr) { ctx.fillStyle = v === mx ? '#e6e62acc' : '#8a45b466'; ctx.fillRect(w - (v / mx) * w * 0.3, Y(k * step) - 2, (v / mx) * w * 0.3, 4); } }
  if (kind === 'imbl') [0.3, 0.55, 0.7].forEach((f, j) => { ctx.strokeStyle = j % 2 ? '#ff3df5aa' : '#00e5ffaa'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(w * (0.2 + j * 0.2), mh * f); ctx.lineTo(w, mh * f); ctx.stroke(); ctx.lineWidth = 1; });
  for (const p of plots || []) {
    if (p.pane === 'sub') p.type === 'hist' ? hist(p.values, p.color) : line(p.values, p.color, true);
    else if (p.type === 'dots') { ctx.fillStyle = p.color; for (let i = from; i < n; i++) { const v = p.values[i]; if (v == null) continue; ctx.beginPath(); ctx.moveTo(X(i), Y(v) - 5); ctx.lineTo(X(i) + 4, Y(v)); ctx.lineTo(X(i), Y(v) + 5); ctx.lineTo(X(i) - 4, Y(v)); ctx.fill(); } }
    else line(p.values, p.color);
  }
}

function Preview({ bars, d, kind, plots, h = 120 }: { bars: Bar[]; d: Series | null; kind: string; plots?: Plot[]; h?: number | string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) drawPreview(ref.current, bars, d, kind, plots); });
  useEffect(() => { const c = ref.current!; const ro = new ResizeObserver(() => drawPreview(c, bars, d, kind, plots)); ro.observe(c); return () => ro.disconnect(); }, [bars, d, kind, plots]);
  return <canvas ref={ref} style={{ height: h }} />;
}

export function IndicatorsPage() {
  const list = scripts.use(s => s.list), ov = settings.use(s => s.ov), style = settings.use(s => s.style);
  const { bars, d, sym } = usePreviewBars();
  const [cat, setCat] = useState('All'), [q, setQ] = useState(''), [edit, setEdit] = useState<string | null>(null);

  const items = useMemo(() => {
    const b: (Builtin & { my?: Script })[] = cat === 'My' ? [] : BUILTIN.filter(x => cat === 'All' || x.cat === cat);
    const mine: (Builtin & { my?: Script })[] = cat === 'All' || cat === 'My' ? list.map(s => ({ id: s.id, name: s.name, cat: 'My indicators', desc: (s.code.split('\n')[0] || '').replace(/^\/\/\s?/, ''), tag: 'SCRIPT', my: s })) : [];
    return [...b, ...mine].filter(x => !q || (x.name + x.desc + x.tag).toLowerCase().includes(q.toLowerCase()));
  }, [cat, q, list]);

  const fromTemplate = (b: Builtin) => {
    const t = TEMPLATES[b.tpl!]; const s: Script = { id: uid(), name: b.name, on: false, inputs: JSON.parse(JSON.stringify(t.inputs)), code: t.code };
    saveScripts([...list, s]); setEdit(s.id); toast('Copied to My indicators — edit freely');
  };
  const newScript = () => { const s: Script = { id: uid(), name: 'My indicator', on: false, inputs: [{ k: 'len', label: 'Length', v: 20 }], code: NEW_SCRIPT }; saveScripts([...list, s]); setEdit(s.id); };

  const editing = list.find(s => s.id === edit);
  return (
    <div className="page">
      <MenuBar active="indicators" right={<a className="btn" href="#/chart"><Icon n="candles" size={16} />Open chart</a>} />
      <div className="ind-wrap">
        <aside className="ind-side">
          <label className="search"><Icon n="search" size={16} /><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search indicators" aria-label="Search indicators" /></label>
          {CATS.map(c => <div key={c} className={`cat ${cat === c && !edit ? 'on' : ''}`} onClick={() => { setCat(c); setEdit(null); }}>{c}<small>{c === 'All' ? BUILTIN.length : BUILTIN.filter(b => b.cat === c).length}</small></div>)}
          <div className={`cat ${cat === 'My' && !edit ? 'on' : ''}`} onClick={() => { setCat('My'); setEdit(null); }}>My indicators<small>{list.length}</small></div>
          <div className="side-h">My scripts</div>
          {list.map(s => <div key={s.id} className={`cat ${edit === s.id ? 'on' : ''}`} onClick={() => setEdit(s.id)}><span>{s.name}</span><small style={{ color: s.on ? 'var(--bull)' : undefined }}>{s.on ? '● on chart' : 'off'}</small></div>)}
          <button className="btn pri" style={{ marginTop: 10, justifyContent: 'center' }} onClick={newScript}><Icon n="plus" size={16} />New indicator</button>
          <p className="muted" style={{ fontSize: 11.5, padding: '10px 4px' }}>Previews use 1-minute bars of <b>{sym}</b>.</p>
        </aside>
        <main className="ind-main">
          {editing ? <Editor key={editing.id} s={editing} bars={bars} d={d} onBack={() => setEdit(null)} /> : (
            <>
              <div className="ind-head"><h1>{cat === 'My' ? 'My indicators' : cat === 'All' ? 'All indicators' : cat}</h1><p>Add an indicator and it appears on the Chart page. Open any study as a script to copy and customise it.</p></div>
              <div className="cards">
                {items.map(b => {
                  const on = b.my ? b.my.on : b.ov ? ov[b.ov] : b.style ? style === b.style : false;
                  return (
                    <article className="card" key={b.id}>
                      <Preview bars={bars} d={d} kind={b.my ? 'custom' : b.tpl ? 'custom' : b.id} plots={b.my && d ? runScript(b.my, d).plots : b.tpl && d ? runScript({ id: 'tpl:' + b.tpl, name: b.name, on: true, ...TEMPLATES[b.tpl] }, d).plots : undefined} />
                      <div className="b">
                        <div className="t"><b>{b.name}</b><span className={`tagx ${b.cat === 'Order Flow' ? 'of' : b.my ? 'my' : ''}`}>{b.tag}</span></div>
                        <p>{b.desc}</p>
                        <div className="a">
                          {b.my ? <>
                            <button className={`btn ${on ? 'onchart' : ''}`} onClick={() => saveScripts(list.map(s => s.id === b.my!.id ? { ...s, on: !s.on } : s))}>{on ? '✓ On chart' : 'Add to chart'}</button>
                            <button className="btn" onClick={() => setEdit(b.my!.id)}><Icon n="code" size={15} />Edit</button>
                          </> : b.ov ? <button className={`btn ${on ? 'onchart' : ''}`} onClick={() => settings.set(s => ({ ov: { ...s.ov, [b.ov!]: !s.ov[b.ov!] } }))}>{on ? '✓ On chart' : 'Add to chart'}</button>
                            : b.style ? <button className={`btn ${on ? 'onchart' : ''}`} onClick={() => { settings.set({ style: b.style! }); location.hash = '#/chart'; }}>{on ? '✓ Active style' : `Use ${b.style} style`}</button>
                            : <button className="btn" onClick={() => fromTemplate(b)}><Icon n="code" size={15} />Open as script</button>}
                        </div>
                      </div>
                    </article>
                  );
                })}
                {!items.length && <p className="muted" style={{ padding: 20 }}>Nothing matches.</p>}
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function Editor({ s, bars, d, onBack }: { s: Script; bars: Bar[]; d: Series | null; onBack(): void }) {
  const list = scripts.use(x => x.list);
  const [name, setName] = useState(s.name), [code, setCode] = useState(s.code), [inputs, setInputs] = useState(s.inputs);
  const [res, setRes] = useState<{ plots: Plot[]; err: string | null; ms: number }>({ plots: [], err: null, ms: 0 });
  const gut = useRef<HTMLDivElement>(null);
  useEffect(() => { const h = setTimeout(() => { if (d) setRes(runScript({ ...s, id: s.id + ':draft', code, inputs }, d)); }, 350); return () => clearTimeout(h); }, [code, inputs, d]);
  const save = (on = true) => { saveScripts(list.map(x => x.id === s.id ? { ...x, name: name.trim() || 'Untitled', code, inputs, on } : x)); toast(on ? `Saved — "${name}" is on the chart` : 'Saved'); };
  const lines = code.split('\n').length;
  return (
    <section className="editor">
      <div className="ebar">
        <button className="tb" onClick={onBack} aria-label="Back to library" data-tip="Back"><Icon n="back" /></button>
        <input className="name" value={name} onChange={e => setName(e.target.value)} aria-label="Indicator name" />
        <span className="tagx my">JavaScript</span>
        <span style={{ flex: 1 }} />
        <button className="btn" onClick={() => { const c = { ...s, id: uid(), name: name + ' copy', code, inputs, on: false }; saveScripts([...list, c]); toast('Duplicated'); }}><Icon n="copy" size={15} />Duplicate</button>
        <button className="btn" onClick={() => { if (confirm(`Delete "${name}"?`)) { saveScripts(list.filter(x => x.id !== s.id)); onBack(); } }}><Icon n="trash" size={15} />Delete</button>
        <button className="btn" onClick={() => save(false)}><Icon n="save" size={15} />Save</button>
        <button className="btn pri" onClick={() => save(true)}><Icon n="save" size={15} />Save &amp; add to chart</button>
      </div>
      <div className="egrid">
        <div className="code">
          <div className="gutter" ref={gut}>{Array.from({ length: lines }, (_, i) => i + 1).join('\n')}</div>
          <textarea className="src" spellCheck={false} value={code} aria-label="Indicator source code"
            onChange={e => setCode(e.target.value)} onScroll={e => { if (gut.current) gut.current.scrollTop = (e.target as HTMLTextAreaElement).scrollTop; }}
            onKeyDown={e => { if (e.key === 'Tab') { e.preventDefault(); const t = e.currentTarget, a = t.selectionStart; t.setRangeText('  ', a, t.selectionEnd, 'end'); setCode(t.value); } if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(true); } }} />
        </div>
        <div className="rightcol">
          <Preview bars={bars} d={d} kind="custom" plots={res.plots} h="100%" />
          <div className="pbox">
            <h4>Inputs <button className="btn" style={{ height: 24, fontSize: 11.5, textTransform: 'none', letterSpacing: 0 }} onClick={() => { const k = prompt('Input key (letters/numbers), e.g. len'); if (k && /^[a-z_]\w*$/i.test(k)) setInputs([...inputs, { k, label: k, v: 10 }]); }}>+ Input</button></h4>
            <div className="inputs">
              {inputs.map((x, j) => <div className="fld" key={x.k}><span>{x.label} <span className="muted" style={{ fontSize: 11 }}>input.{x.k}</span></span><input type="number" step="any" value={x.v} style={{ width: 64 }} aria-label={x.label} onChange={e => setInputs(inputs.map((y, i) => i === j ? { ...y, v: +e.target.value } : y))} /></div>)}
              {!inputs.length && <span className="muted">No inputs. Add one, then read it as input.key in code.</span>}
            </div>
          </div>
          <div className="pbox">
            <h4>Console <span className="ref"><b>d</b>.open high low close volume buy sell delta cvd vwap bigBuy bigSell · <b>ta</b>.sma ema rsi atr macd stdev highest lowest cross</span></h4>
            <div className={`console ${res.err ? 'err' : ''}`}>{res.err ? '✗ ' + res.err : `✓ OK in ${res.ms.toFixed(1)} ms · ${res.plots.length} plot(s): ${res.plots.map(p => `${p.name} [${p.pane}${p.type ? ' / ' + p.type : ''}]`).join(', ')} · ${bars.length} bars`}</div>
          </div>
        </div>
      </div>
    </section>
  );
}
