type N = number | null;
const A = (n: number) => new Array<N>(n).fill(null);

/** Technical-analysis helpers. All inputs are plain number arrays; outputs are (number|null)[] of the same length. */
export const TA = {
  sma(a: number[], n: number): N[] { const o = A(a.length); let s = 0; for (let i = 0; i < a.length; i++) { s += a[i]; if (i >= n) s -= a[i - n]; if (i >= n - 1) o[i] = s / n; } return o; },
  ema(a: number[], n: number): N[] { const k = 2 / (n + 1); let e: number | null = null; return a.map(v => (e = e == null ? v : v * k + e * (1 - k))); },
  wma(a: number[], n: number): N[] { const o = A(a.length), d = (n * (n + 1)) / 2; for (let i = n - 1; i < a.length; i++) { let s = 0; for (let j = 0; j < n; j++) s += a[i - j] * (n - j); o[i] = s / d; } return o; },
  stdev(a: number[], n: number): N[] { const m = TA.sma(a, n); return a.map((_, i) => { const mi = m[i]; if (mi == null) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += (a[j] - mi) ** 2; return Math.sqrt(s / n); }); },
  rsi(a: number[], n = 14): N[] { let g = 0, l = 0; return a.map((v, i) => { if (!i) return null; const d = v - a[i - 1]; g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n; return i < n ? null : 100 - 100 / (1 + g / (l || 1e-9)); }); },
  atr(h: number[], l: number[], c: number[], n = 14): N[] { const tr = h.map((x, i) => (i ? Math.max(x - l[i], Math.abs(x - c[i - 1]), Math.abs(l[i] - c[i - 1])) : x - l[i])); return TA.ema(tr, n); },
  macd(a: number[], f = 12, s = 26, sig = 9) { const ef = TA.ema(a, f), es = TA.ema(a, s); const m = a.map((_, i) => (ef[i] as number) - (es[i] as number)); const sg = TA.ema(m, sig); return { macd: m, signal: sg, hist: m.map((v, i) => v - (sg[i] as number)) }; },
  highest(a: number[], n: number): number[] { return a.map((_, i) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (a[j] > m) m = a[j]; return m; }); },
  lowest(a: number[], n: number): number[] { return a.map((_, i) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) if (a[j] < m) m = a[j]; return m; }); },
  cross(a: N[], b: N[], i: number) { return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! <= b[i - 1]! && a[i]! > b[i]!; },
  crossunder(a: N[], b: N[], i: number) { return a[i - 1] != null && b[i - 1] != null && a[i] != null && b[i] != null && a[i - 1]! >= b[i - 1]! && a[i]! < b[i]!; },
};
export type TAType = typeof TA;
