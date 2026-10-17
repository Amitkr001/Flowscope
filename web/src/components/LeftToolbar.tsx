import { useEffect, useState } from 'react';
import { Icon } from '../lib/icons';
import { TOOLS, TOOL_GROUPS } from '../chart/drawings';

const GROUP_ICON: Record<string, string> = { Lines: 'trend', Fibonacci: 'fib', 'Gann & Pitchfork': 'pitchfork', Shapes: 'rect', Positions: 'long', Measure: 'ruler', 'Text & Marks': 'text', 'Order Flow': 'fixedvp' };

interface Props {
  tool: string; onTool(t: string): void;
  magnet: boolean; onMagnet(): void;
  locked: boolean; onLock(): void; hidden: boolean; onHide(): void;
  onUndo(): void; onRedo(): void; onClear(): void; onShot(): void;
}

export function LeftToolbar(p: Props) {
  const [fly, setFly] = useState<{ g: string; x: number; y: number } | null>(null);
  const [lastOf, setLastOf] = useState<Record<string, string>>({});
  useEffect(() => { const c = () => setFly(null); window.addEventListener('mousedown', c); return () => window.removeEventListener('mousedown', c); }, []);
  const groupOf = (t: string) => TOOLS.find(x => x.id === t)?.group;
  const pick = (id: string) => { const g = groupOf(id)!; setLastOf(s => ({ ...s, [g]: id })); p.onTool(id); setFly(null); };
  return (
    <nav className="vbar" aria-label="Drawing tools">
      <button className={`tb ${p.tool === 'cursor' ? 'on' : ''}`} data-tip="Select / pan (Esc)" aria-label="Select" onClick={() => p.onTool('cursor')}><Icon n="cursor" /></button>
      <div className="tsep" />
      {TOOL_GROUPS.map(g => {
        const active = groupOf(p.tool) === g, cur = active ? p.tool : lastOf[g];
        const ic = cur ? TOOLS.find(t => t.id === cur)!.icon : GROUP_ICON[g];
        return (
          <div className="grp" key={g}>
            <button className={`tb ${active ? 'on' : ''}`} data-tip={g} aria-label={g}
              onMouseDown={e => e.stopPropagation()}
              onClick={e => { const r = (e.currentTarget as HTMLElement).getBoundingClientRect(); setFly(f => f?.g === g ? null : { g, x: r.right + 6, y: r.top }); }}>
              <Icon n={ic} />
            </button>
            <span className="more" />
          </div>
        );
      })}
      <div className="tsep" />
      <button className={`tb ${p.magnet ? 'on' : ''}`} data-tip="Magnet: snap to OHLC (hold Ctrl to bypass)" aria-label="Magnet" onClick={p.onMagnet}><Icon n="magnet" /></button>
      <button className={`tb ${p.locked ? 'on' : ''}`} data-tip="Lock all drawings" aria-label="Lock all" onClick={p.onLock}><Icon n={p.locked ? 'lock' : 'unlock'} /></button>
      <button className={`tb ${p.hidden ? 'on' : ''}`} data-tip="Hide all drawings" aria-label="Hide all" onClick={p.onHide}><Icon n={p.hidden ? 'eyeoff' : 'eye'} /></button>
      <button className="tb" data-tip="Undo (Ctrl+Z)" aria-label="Undo" onClick={p.onUndo}><Icon n="undo" /></button>
      <button className="tb" data-tip="Redo (Ctrl+Y)" aria-label="Redo" onClick={p.onRedo}><Icon n="redo" /></button>
      <button className="tb" data-tip="Remove all drawings" aria-label="Remove all drawings" onClick={p.onClear}><Icon n="eraser" /></button>
      <div style={{ flex: 1 }} />
      <button className="tb" data-tip="Screenshot" aria-label="Screenshot" onClick={p.onShot}><Icon n="camera" /></button>
      {fly && (
        <div className="flyout" style={{ left: fly.x, top: Math.min(fly.y, window.innerHeight - 340) }} onMouseDown={e => e.stopPropagation()}>
          <h6>{fly.g}</h6>
          {TOOLS.filter(t => t.group === fly.g).map(t => (
            <div key={t.id} className={`it ${p.tool === t.id ? 'on' : ''}`} onClick={() => pick(t.id)}>
              <Icon n={t.icon} />{t.label}{t.key && <kbd>{t.key}</kbd>}
            </div>
          ))}
        </div>
      )}
    </nav>
  );
}
