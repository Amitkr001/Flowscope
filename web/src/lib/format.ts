export const fmtQ = (q: number) => {
  const a = Math.abs(q);
  return a >= 1e9 ? (q / 1e9).toFixed(1) + 'B' : a >= 1e6 ? (q / 1e6).toFixed(1) + 'M' : a >= 1e4 ? (q / 1e3).toFixed(0) + 'K'
    : a >= 1e3 ? (q / 1e3).toFixed(1) + 'K' : a >= 100 ? Math.round(q) + '' : a >= 10 ? q.toFixed(0) : a >= 1 ? q.toFixed(1) : a >= 0.01 ? q.toFixed(2) : a === 0 ? '0' : q.toPrecision(1);
};
export const fmtP = (p: number, dec: number) => (p == null || !isFinite(p) ? '—' : p.toFixed(dec));
export const fmtT = (t: number) => new Date(t).toTimeString().slice(0, 8);
export const fmtUsd = (v: number) => (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const niceStep = (r: number) => { if (!(r > 0)) return 1; const p = 10 ** Math.floor(Math.log10(r)), m = r / p; return (m < 1.5 ? 1 : m < 3 ? 2 : m < 7 ? 5 : 10) * p; };
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

export function hidpi(cv: HTMLCanvasElement) {
  const r = cv.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width * d)), h = Math.max(1, Math.round(r.height * d));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  const ctx = cv.getContext('2d')!;
  ctx.setTransform(d, 0, 0, d, 0, 0);
  return { ctx, w: r.width, h: r.height };
}

export const FONT = '"Segoe UI", Arial, sans-serif';
export const MONO = 'Consolas, "Cascadia Mono", monospace';
