import { createStore, loadRaw, saveRaw } from './store';

export const API_BASE = (import.meta as any).env?.VITE_API_URL || '';

export interface User { id: string; email: string; name: string }
export const session = createStore<{ token: string | null; user: User | null }>({
  token: loadRaw<string | null>('fs.token', null),
  user: loadRaw<User | null>('fs.user', null),
});

export async function api<T = any>(path: string, opt: { method?: string; body?: unknown } = {}): Promise<T> {
  const tok = session.get().token;
  const r = await fetch(API_BASE + path, {
    method: opt.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: `Bearer ${tok}` } : {}) },
    body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && tok && path !== '/api/auth/login') logout();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data as T;
}

export function setSession(token: string, user: User) {
  saveRaw('fs.token', token); saveRaw('fs.user', user);
  session.set({ token, user });
}
export function logout() {
  localStorage.removeItem('fs.token'); localStorage.removeItem('fs.user');
  session.set({ token: null, user: null });
}

/* ---- cloud documents: localStorage first, server when signed in ---- */
const timers = new Map<string, ReturnType<typeof setTimeout>>();
export function saveDoc(kind: string, data: unknown) {
  saveRaw(`fs.doc.${kind}`, data);
  if (!session.get().token) return;
  clearTimeout(timers.get(kind));
  timers.set(kind, setTimeout(() => { api(`/api/docs/${kind}`, { method: 'PUT', body: { data } }).catch(() => {}); }, 800));
}
export function localDoc<T>(kind: string, fallback: T): T { return loadRaw<T>(`fs.doc.${kind}`, fallback); }
export async function pullDoc<T>(kind: string): Promise<T | null> {
  if (!session.get().token) return null;
  try { const r = await api<{ data: T | null }>(`/api/docs/${kind}`); if (r.data != null) saveRaw(`fs.doc.${kind}`, r.data); return r.data; }
  catch { return null; }
}

/* ---- toast ---- */
export const toasts = createStore<{ msg: string; n: number }>({ msg: '', n: 0 });
export const toast = (msg: string) => toasts.set(s => ({ msg, n: s.n + 1 }));
