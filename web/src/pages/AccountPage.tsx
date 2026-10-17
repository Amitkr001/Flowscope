import { useState, type FormEvent } from 'react';
import { MenuBar } from '../components/MenuBar';
import { api, logout, session, setSession, toast, type User } from '../lib/api';
import { settings, syncFromCloud, drawingsStore } from '../lib/settings';
import { syncScripts, scripts } from '../indicators/runtime';
import { net } from '../data/client';

export function AccountPage() {
  const user = session.use(s => s.user);
  return (
    <div className="page">
      <MenuBar active="account" />
      <div className="acct">
        {user ? <Profile user={user} /> : <Auth />}
        <Prefs />
      </div>
    </div>
  );
}

function Auth() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState(''), [pw, setPw] = useState(''), [name, setName] = useState(''), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try {
      const r = await api<{ token: string; user: User }>(`/api/auth/${mode}`, { method: 'POST', body: { email, password: pw, name } });
      setSession(r.token, r.user);
      await Promise.all([syncFromCloud(), syncScripts()]);
      // first sign-in on this device: push local work to the cloud
      settings.set({}); if (!(await api('/api/docs/scripts')).data) scripts.set({ list: scripts.get().list });
      toast(`Signed in as ${r.user.name}`);
    } catch (e2) { setErr((e2 as Error).message); } finally { setBusy(false); }
  };
  return (
    <form className="acct-card" onSubmit={submit}>
      <h2>{mode === 'login' ? 'Sign in' : 'Create account'}</h2>
      <p className="muted">Sign in to sync layouts, drawings, indicators and settings across devices. Everything also works without an account (saved in this browser).</p>
      {mode === 'register' && <label>Name<input value={name} onChange={e => setName(e.target.value)} autoComplete="name" /></label>}
      <label>Email<input type="email" required value={email} onChange={e => setEmail(e.target.value)} autoComplete="email" /></label>
      <label>Password<input type="password" required minLength={8} value={pw} onChange={e => setPw(e.target.value)} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
      {err && <div className="err-msg" role="alert">{err}</div>}
      <button className="btn pri" disabled={busy} style={{ justifyContent: 'center', height: 38 }}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
      <button type="button" className="btn" style={{ justifyContent: 'center' }} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>{mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}</button>
    </form>
  );
}

function Profile({ user }: { user: User }) {
  const nDraw = Object.values(drawingsStore.use(s => s.bySym)).reduce((a, l) => a + l.length, 0);
  const nScripts = scripts.use(s => s.list.length);
  return (
    <div className="acct-card">
      <h2>{user.name}</h2>
      <p className="muted">{user.email}</p>
      <div className="fld">Drawings synced <b>{nDraw}</b></div>
      <div className="fld">Custom indicators <b>{nScripts}</b></div>
      <button className="btn" style={{ justifyContent: 'center' }} onClick={async () => { await Promise.all([syncFromCloud(), syncScripts()]); toast('Pulled latest from cloud'); }}>Pull from cloud</button>
      <button className="btn" style={{ justifyContent: 'center' }} onClick={() => { const blob = new Blob([JSON.stringify({ settings: settings.get(), drawings: drawingsStore.get().bySym, scripts: scripts.get().list }, null, 2)], { type: 'application/json' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'flowscope-backup.json'; a.click(); }}>Export backup (JSON)</button>
      <button className="btn" style={{ justifyContent: 'center' }} onClick={() => { logout(); toast('Signed out'); }}>Sign out</button>
    </div>
  );
}

function Prefs() {
  const st = settings.use(s => s), syms = net.use(s => s.symbols);
  return (
    <div className="acct-card" style={{ width: 'min(560px,100%)' }}>
      <h2>Trading settings</h2>
      <div className="set-grid">
        <label>Account size (USD) — for position tools<input type="number" value={st.acct.size} onChange={e => settings.set({ acct: { ...st.acct, size: +e.target.value } })} /></label>
        <label>Risk per trade (%)<input type="number" step={0.1} value={st.acct.risk} onChange={e => settings.set({ acct: { ...st.acct, risk: +e.target.value } })} /></label>
      </div>
      <h2 style={{ fontSize: 15, marginTop: 6 }}>Big-trade thresholds (USD notional)</h2>
      <p className="muted" style={{ fontSize: 12 }}>A print is a “big trade” bubble when price × size ≥ threshold.</p>
      <div className="set-grid">
        {syms.filter(s => s.volume === 'real').map(s => (
          <label key={s.id}>{s.id}<input type="number" step={1000} value={st.bigUsd[s.id] ?? s.bigUsd} onChange={e => settings.set({ bigUsd: { ...st.bigUsd, [s.id]: +e.target.value } })} /></label>
        ))}
      </div>
      <h2 style={{ fontSize: 15, marginTop: 6 }}>Watchlist</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {syms.map(s => { const on = st.watch.includes(s.id); return <span key={s.id} className={`tag ${on ? 'real' : ''}`} style={{ cursor: 'pointer', padding: '4px 8px', fontSize: 12 }} onClick={() => settings.set({ watch: on ? st.watch.filter(x => x !== s.id) : [...st.watch, s.id] })}>{on ? '✓ ' : ''}{s.id}</span>; })}
      </div>
    </div>
  );
}
