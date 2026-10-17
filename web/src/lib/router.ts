import { useSyncExternalStore } from 'react';

const sub = (f: () => void) => { window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); };
export function useRoute(): string {
  const h = useSyncExternalStore(sub, () => location.hash, () => '');
  return (h.replace(/^#\/?/, '').split('?')[0] || 'chart');
}
export const go = (r: string) => { location.hash = '#/' + r; };
