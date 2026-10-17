import { useSyncExternalStore } from 'react';

/** Minimal external store with selector hook (no dependencies). */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      subs.forEach(f => f());
    },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
    use<R>(sel: (s: T) => R): R {
      // eslint-disable-next-line react-hooks/rules-of-hooks
      return useSyncExternalStore(this.subscribe, () => sel(state), () => sel(state));
    },
  };
}

export function load<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? { ...fallback, ...JSON.parse(v) } : fallback; } catch { return fallback; }
}
export function loadRaw<T>(key: string, fallback: T): T {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
export function saveRaw(key: string, v: unknown) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* quota */ } }
