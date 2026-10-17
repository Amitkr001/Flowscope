import { useEffect } from 'react';
import { useRoute } from './lib/router';
import { ChartPage } from './pages/ChartPage';
import { IndicatorsPage } from './pages/IndicatorsPage';
import { BacktestPage } from './pages/BacktestPage';
import { AccountPage } from './pages/AccountPage';
import { Toast } from './components/Toast';
import { session } from './lib/api';
import { syncFromCloud } from './lib/settings';
import { syncScripts } from './indicators/runtime';

export function App() {
  const r = useRoute();
  useEffect(() => { if (session.get().token) { syncFromCloud(); syncScripts(); } }, []);
  useEffect(() => { document.title = `FlowScope — ${r[0].toUpperCase() + r.slice(1)}`; }, [r]);
  return (
    <>
      {r === 'indicators' ? <IndicatorsPage /> : r === 'backtest' ? <BacktestPage /> : r === 'account' ? <AccountPage /> : <ChartPage />}
      <Toast />
    </>
  );
}
