import type { ChartStyle, Overlays } from '../lib/types';
import { Icon } from '../lib/icons';
import type { Script } from '../indicators/runtime';

interface Props {
  style: ChartStyle; onStyle(s: ChartStyle): void;
  ov: Overlays; onOv(k: keyof Overlays): void;
  scripts: Script[]; onScript(id: string): void;
  docks: { dom: boolean; tp: boolean; ts: boolean; wl: boolean }; onDock(k: 'dom' | 'tp' | 'ts' | 'wl'): void;
}
const R = ({ on, label, onClick, title }: { on: boolean; label: string; onClick(): void; title?: string }) =>
  <span className={`radio ${on ? 'on' : ''}`} onClick={onClick} title={title} role="checkbox" aria-checked={on} tabIndex={0} onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); onClick(); } }}>{label}</span>;

export function StatusBar(p: Props) {
  return (
    <footer className="statusbar">
      <a className="lbl" href="#/indicators">Indicators <Icon n="bars" size={16} /></a>
      <R on={p.style === 'candles'} label="CANDLES" onClick={() => p.onStyle('candles')} />
      <R on={p.style === 'footprint'} label="FOOTPRINT" onClick={() => p.onStyle('footprint')} />
      <R on={p.style === 'heatmap'} label="HEATMAP" onClick={() => p.onStyle('heatmap')} />
      <span className="vsep" />
      <R on={p.ov.bubbles} label="BUBBLES" onClick={() => p.onOv('bubbles')} title="Big trades" />
      <R on={p.ov.volume} label="VOLUME" onClick={() => p.onOv('volume')} />
      <R on={p.ov.vwap} label="VWAP" onClick={() => p.onOv('vwap')} />
      <R on={p.ov.cvd} label="CVD" onClick={() => p.onOv('cvd')} />
      <R on={p.ov.delta} label="DELTA" onClick={() => p.onOv('delta')} />
      <R on={p.ov.imbl} label="Imp. L" onClick={() => p.onOv('imbl')} title="Stacked imbalance levels" />
      <R on={p.ov.stats} label="STATS" onClick={() => p.onOv('stats')} title="Bar statistics: volume, delta, delta %, big-trade delta" />
      <R on={p.ov.walls} label="WALLS" onClick={() => p.onOv('walls')} title="Largest resting orders in the live order book" />
      <span className="vsep" />
      <R on={p.ov.visp} label="VIS.P" onClick={() => p.onOv('visp')} title="Visible range profile" />
      <R on={p.ov.dlyp} label="DLY.P" onClick={() => p.onOv('dlyp')} title="Daily profile" />
      {p.scripts.length > 0 && <span className="vsep" />}
      {p.scripts.map(s => <R key={s.id} on={s.on} label={s.name} onClick={() => p.onScript(s.id)} title="Custom indicator - edit on the Indicators page" />)}
      <span style={{ flex: 1 }} />
      <span className={`sw ${p.docks.wl ? 'on' : ''}`} onClick={() => p.onDock('wl')}>Watch</span>
      <span className={`sw ${p.docks.dom ? 'on' : ''}`} onClick={() => p.onDock('dom')}>DOM</span>
      <span className={`sw ${p.docks.tp ? 'on' : ''}`} onClick={() => p.onDock('tp')}>T. Panel</span>
      <span className={`sw ${p.docks.ts ? 'on' : ''}`} onClick={() => p.onDock('ts')}>T&amp;S</span>
    </footer>
  );
}
