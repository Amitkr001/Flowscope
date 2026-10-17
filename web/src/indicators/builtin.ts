import type { Overlays } from '../lib/types';
import type { Script } from './runtime';

export interface Builtin { id: string; name: string; cat: string; desc: string; tag: string; ov?: keyof Overlays; style?: 'footprint' | 'heatmap'; tpl?: string }

export const CATS = ['All', 'Order Flow', 'Profiles & Levels', 'Trend', 'Volatility', 'Momentum'];

export const BUILTIN: Builtin[] = [
  { id: 'bubbles', name: 'Big Trades', cat: 'Order Flow', desc: 'Bubbles sized by aggressive print size. Green = buyer, purple = seller. Threshold per symbol in Account → Settings.', tag: 'BUBBLES', ov: 'bubbles' },
  { id: 'footprint', name: 'Footprint', cat: 'Order Flow', desc: 'Bid × Ask volume per price, POC box and diagonal imbalances (cyan / magenta).', tag: 'OF-B/A', style: 'footprint' },
  { id: 'heatmap', name: 'Liquidity Heatmap', cat: 'Order Flow', desc: 'Resting limit orders over time. Purple = asks, green = bids; brighter = heavier.', tag: 'HEATMAP', style: 'heatmap' },
  { id: 'cvd', name: 'Cumulative Delta', cat: 'Order Flow', desc: 'Running sum of buy − sell aggression.', tag: 'CVD', ov: 'cvd' },
  { id: 'delta', name: 'Delta Bars', cat: 'Order Flow', desc: 'Buy − sell volume for each bar.', tag: 'DELTA', ov: 'delta' },
  { id: 'imbl', name: 'Stacked Imbalance Levels', cat: 'Order Flow', desc: 'Levels where 3+ diagonal imbalances stacked in one bar.', tag: 'Imp. L', ov: 'imbl' },
  { id: 'absorb', name: 'Absorption', cat: 'Order Flow', desc: 'High volume, small body — passive side absorbing aggression.', tag: 'ABS', tpl: 'absorb' },
  { id: 'volume', name: 'Volume', cat: 'Order Flow', desc: 'Bar volume coloured by candle direction.', tag: 'VOLUME', ov: 'volume' },
  { id: 'vwap', name: 'VWAP', cat: 'Profiles & Levels', desc: 'Session VWAP (resets 00:00 UTC) with deviation bands.', tag: 'VWAP', ov: 'vwap' },
  { id: 'visp', name: 'Visible Range Profile', cat: 'Profiles & Levels', desc: 'Volume profile of visible bars with POC and 70 % value area.', tag: 'VIS.P', ov: 'visp' },
  { id: 'dlyp', name: 'Daily Profile', cat: 'Profiles & Levels', desc: 'Session volume profile anchored at the day open.', tag: 'DLY.P', ov: 'dlyp' },
  { id: 'ema', name: 'EMA 9 / 21', cat: 'Trend', desc: 'Fast / slow exponential moving averages.', tag: 'EMA', tpl: 'ema' },
  { id: 'bb', name: 'Bollinger Bands', cat: 'Volatility', desc: '20-period, 2 standard deviations.', tag: 'BB', tpl: 'bb' },
  { id: 'atr', name: 'ATR 14', cat: 'Volatility', desc: 'Average true range in a lower pane.', tag: 'ATR', tpl: 'atr' },
  { id: 'rsi', name: 'RSI 14', cat: 'Momentum', desc: 'Relative strength index.', tag: 'RSI', tpl: 'rsi' },
  { id: 'macd', name: 'MACD', cat: 'Momentum', desc: 'MACD histogram (12, 26, 9).', tag: 'MACD', tpl: 'macd' },
];

export const TEMPLATES: Record<string, Omit<Script, 'id' | 'name' | 'on'>> = {
  ema: { inputs: [{ k: 'fast', label: 'Fast', v: 9 }, { k: 'slow', label: 'Slow', v: 21 }], code: `// Two exponential moving averages
const f = ta.ema(d.close, input.fast);
const s = ta.ema(d.close, input.slow);
return [
  { name: 'EMA fast', values: f, color: '#4da3ff', pane: 'main' },
  { name: 'EMA slow', values: s, color: '#ffb020', pane: 'main' },
];` },
  bb: { inputs: [{ k: 'len', label: 'Length', v: 20 }, { k: 'mult', label: 'Std dev', v: 2 }], code: `// Bollinger Bands
const m = ta.sma(d.close, input.len), sd = ta.stdev(d.close, input.len);
return [
  { name: 'Basis', values: m, color: '#9a9a9a', pane: 'main' },
  { name: 'Upper', values: m.map((v, i) => v == null ? null : v + input.mult * sd[i]), color: '#8a45b4', pane: 'main' },
  { name: 'Lower', values: m.map((v, i) => v == null ? null : v - input.mult * sd[i]), color: '#42da45', pane: 'main' },
];` },
  rsi: { inputs: [{ k: 'len', label: 'Length', v: 14 }], code: `// RSI in the lower pane
return [{ name: 'RSI', values: ta.rsi(d.close, input.len), color: '#c38bff', pane: 'sub' }];` },
  atr: { inputs: [{ k: 'len', label: 'Length', v: 14 }], code: `// Average true range
return [{ name: 'ATR', values: ta.atr(d.high, d.low, d.close, input.len), color: '#ffb020', pane: 'sub' }];` },
  macd: { inputs: [{ k: 'fast', label: 'Fast', v: 12 }, { k: 'slow', label: 'Slow', v: 26 }, { k: 'sig', label: 'Signal', v: 9 }], code: `// MACD histogram
const m = ta.macd(d.close, input.fast, input.slow, input.sig);
return [{ name: 'MACD', values: m.hist, color: '#42da45', pane: 'sub', type: 'hist' }];` },
  absorb: { inputs: [{ k: 'vol', label: 'Vol x avg', v: 1.8 }, { k: 'body', label: 'Max body %', v: 25 }], code: `// Absorption: big volume but small candle body
const avgV = ta.sma(d.volume, 30);
const dots = d.close.map((c, i) => {
  const body = Math.abs(c - d.open[i]), range = (d.high[i] - d.low[i]) || 1;
  if (!avgV[i] || d.volume[i] < avgV[i] * input.vol || body / range * 100 > input.body) return null;
  return d.delta[i] < 0 ? d.low[i] : d.high[i];
});
return [{ name: 'Absorption', values: dots, color: '#ffd23f', pane: 'main', type: 'dots' }];` },
};

export const NEW_SCRIPT = `// d   = series: time open high low close volume buy sell delta cvd vwap bigBuy bigSell
// ta  = helpers: sma ema wma stdev rsi atr macd highest lowest cross crossunder
// input = your inputs (add them below the preview)
// Return plots: { name, values, color, pane: 'main' | 'sub', type: 'line' | 'hist' | 'dots' }

const avg = ta.sma(d.close, input.len);

return [
  { name: 'SMA', values: avg, color: '#4da3ff', pane: 'main' },
];`;
