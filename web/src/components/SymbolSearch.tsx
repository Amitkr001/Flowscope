import { useEffect, useMemo, useRef, useState } from 'react';
import { net } from '../data/client';
import { Icon } from '../lib/icons';

const CLS: [string, string][] = [['all', 'All'], ['crypto', 'Crypto'], ['metal', 'Metals'], ['index', 'Indices'], ['commodity', 'Commodities'], ['fx', 'Forex'], ['demo', 'Demo']];

export function SymbolSearch({ onPick, onClose }: { onPick: (id: string) => void; onClose: () => void }) {
  const syms = net.use(s => s.symbols);
  const [q, setQ] = useState(''), [cls, setCls] = useState('all'), [i, setI] = useState(0);
  const inp = useRef<HTMLInputElement>(null);
  useEffect(() => { inp.current?.focus(); }, []);
  const list = useMemo(() => syms.filter(s => (cls === 'all' || s.cls === cls) && (!q || (s.id + s.desc + s.venues).toLowerCase().includes(q.toLowerCase()))), [syms, q, cls]);
  return (
    <div className="modal-bg" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" role="dialog" aria-label="Symbol search">
        <div className="mh">
          <Icon n="search" />
          <input ref={inp} value={q} placeholder="Search symbol, market or venue" onChange={e => { setQ(e.target.value); setI(0); }}
            onKeyDown={e => { if (e.key === 'Escape') onClose(); if (e.key === 'ArrowDown') setI(v => Math.min(list.length - 1, v + 1)); if (e.key === 'ArrowUp') setI(v => Math.max(0, v - 1)); if (e.key === 'Enter' && list[i]) onPick(list[i].id); }} />
          <button className="tb" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>
        <div className="cls-tabs">{CLS.map(([k, l]) => <span key={k} className={cls === k ? 'on' : ''} onClick={() => setCls(k)}>{l}</span>)}</div>
        <div className="mb">
          {list.map((s, k) => (
            <div key={s.id} className={`sym-row ${k === i ? 'on' : ''}`} onClick={() => onPick(s.id)} onMouseEnter={() => setI(k)}>
              <b>{s.id}</b>
              <span className="muted">{s.desc}</span>
              <span className={`tag ${s.volume}`}>{s.volume === 'real' ? 'real volume' : 'price only'}</span>
              <span className="muted" style={{ fontSize: 11.5 }}>{s.venues}</span>
            </div>
          ))}
          {!list.length && <p className="muted" style={{ padding: 16 }}>No symbols match.</p>}
        </div>
      </div>
    </div>
  );
}
