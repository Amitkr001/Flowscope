import { useEffect, useState } from 'react';
import { toasts } from '../lib/api';

export function Toast() {
  const t = toasts.use(s => s);
  const [show, setShow] = useState(false);
  useEffect(() => { if (!t.n) return; setShow(true); const h = setTimeout(() => setShow(false), 2400); return () => clearTimeout(h); }, [t.n]);
  return <div className={`toast ${show ? 'show' : ''}`} role="status" aria-live="polite">{t.msg}</div>;
}
