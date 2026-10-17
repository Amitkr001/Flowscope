import type { Drawing } from '../lib/types';
import { Icon } from '../lib/icons';
import { PALETTE, TOOL_MAP } from '../chart/drawings';

export function DrawingBar({ d, onPatch, onClone, onDelete }: { d: Drawing; onPatch(p: Partial<Drawing>): void; onClone(): void; onDelete(): void }) {
  const def = TOOL_MAP.get(d.type);
  return (
    <div className="dbar" onMouseDown={e => e.stopPropagation()}>
      <span className="lbl" style={{ marginLeft: 0, color: '#ddd' }}>{def?.label}</span>
      {PALETTE.map(c => <span key={c} className={`sw-c ${d.color === c ? 'on' : ''}`} style={{ background: c }} onClick={() => onPatch({ color: c })} title={c} />)}
      <span className="lbl">Width</span>
      <select value={d.width} onChange={e => onPatch({ width: +e.target.value })} aria-label="Line width">{[1, 1.5, 2, 3, 4, 8, 12].map(w => <option key={w} value={w}>{w}</option>)}</select>
      <select value={d.dash} onChange={e => onPatch({ dash: +e.target.value as 0 | 1 | 2 })} aria-label="Line style"><option value={0}>Solid</option><option value={1}>Dashed</option><option value={2}>Dotted</option></select>
      {def?.fill !== undefined && <button className={`tb ${d.fill ? 'on' : ''}`} onClick={() => onPatch({ fill: !d.fill })} title="Fill" aria-label="Fill"><Icon n="rect" size={16} /></button>}
      {def?.text !== undefined && <input value={d.text || ''} onChange={e => onPatch({ text: e.target.value })} placeholder="Text" style={{ width: 140 }} aria-label="Text" />}
      <button className={`tb ${d.locked ? 'on' : ''}`} onClick={() => onPatch({ locked: !d.locked })} title="Lock" aria-label="Lock"><Icon n={d.locked ? 'lock' : 'unlock'} size={16} /></button>
      <button className="tb" onClick={onClone} title="Clone (Ctrl+D)" aria-label="Clone"><Icon n="copy" size={16} /></button>
      <button className="tb" onClick={onDelete} title="Delete (Del)" aria-label="Delete"><Icon n="trash" size={16} /></button>
    </div>
  );
}
