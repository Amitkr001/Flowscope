import type { ReactNode } from 'react';
import { Icon } from '../lib/icons';
import { session } from '../lib/api';

const LINKS: [string, string][] = [['chart', 'Chart'], ['indicators', 'Indicators'], ['backtest', 'Backtest'], ['account', 'Account']];

export function MenuBar({ active, center, right }: { active: string; center?: ReactNode; right?: ReactNode }) {
  const user = session.use(s => s.user);
  return (
    <header className="menubar">
      <a className="brand" href="#/chart" aria-label="FlowScope home"><b /><b />FLOWSCOPE</a>
      <nav className="menu">
        {LINKS.map(([k, l]) => <a key={k} href={`#/${k}`} className={active === k ? 'on' : ''}>{l}</a>)}
      </nav>
      {center && <div className="center-dd">{center}</div>}
      <div className="mb-right">
        {right}
        <a className="btn" href="#/account" title={user ? user.email : 'Sign in to sync layouts'} style={{ height: 30 }}>
          <Icon n="user" size={16} />{user ? user.name : 'Sign in'}
        </a>
      </div>
    </header>
  );
}
