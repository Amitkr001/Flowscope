import type { ChartEngine, ViewState } from '../chart/engine';
import type { ChartStyle, FpMode } from '../lib/types';

const D = {
  minus: 'M5 12h14', plus: 'M12 5v14M5 12h14', left: 'M15 6l-6 6 6 6', right: 'M9 6l6 6-6 6',
  reset: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4h4', fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  live: 'M6 6l6 6-6 6M13 6l6 6-6 6', play: 'M8 5l11 7-11 7z',
};
const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

interface Props {
  eng: ChartEngine | null; vs: ViewState; style: ChartStyle;
  fpMode: FpMode; onFpMode(m: FpMode): void;
  replaying: boolean; onReplay(): void;
}

/** TradingView-style floating navigation bar + "scroll to real-time" + auto-scale toggle. */
export function ChartControls({ eng, vs, style, fpMode, onFpMode, replaying, onReplay }: Props) {
  if (!eng) return null;
  const B = (p: { t: string; d: string; f(): void; on?: boolean }) =>
    <button className={p.on ? 'on' : ''} title={p.t} aria-label={p.t} onClick={() => { p.f(); eng.cv.focus(); }}><Svg d={p.d} /></button>;
  return (
    <>
      <div className="cc-bar" role="toolbar" aria-label="Chart navigation">
        <B t="Zoom out (−)" d={D.minus} f={() => eng.zoomOut()} />
        <B t="Zoom in (+)" d={D.plus} f={() => eng.zoomIn()} />
        <span className="cc-sep" />
        <B t="Scroll left (←)" d={D.left} f={() => eng.scrollBars(10)} />
        <B t="Scroll right (→)" d={D.right} f={() => eng.scrollBars(-10)} />
        <span className="cc-sep" />
        <B t="Reset chart (Home)" d={D.reset} f={() => eng.reset()} />
        <B t="Fit all bars" d={D.fit} f={() => eng.fit()} />
        <B t="Bar replay" d={D.play} f={onReplay} on={replaying} />
        {style === 'footprint' && (
          <div className="cc-seg" role="group" aria-label="Footprint mode">
            {([['ba', 'Bid×Ask'], ['delta', 'Delta'], ['vol', 'Volume']] as [FpMode, string][]).map(([m, l]) =>
              <button key={m} className={fpMode === m ? 'on' : ''} onClick={() => onFpMode(m)}>{l}</button>)}
          </div>
        )}
      </div>
      {!vs.live && <button className="cc-live" title="Scroll to real-time (End)" aria-label="Scroll to real-time" onClick={() => eng.goLive()}><Svg d={D.live} /></button>}
      <button className={`cc-auto ${vs.auto ? 'on' : ''}`} title={vs.auto ? 'Auto-scale is on' : 'Auto-scale price (double-click price axis)'} aria-pressed={vs.auto} onClick={() => eng.setAutoScale(!vs.auto)}>A</button>
    </>
  );
}
