import { useEffect, useState } from 'react';
import { Header, type ConnectionStatus } from './Header';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { type NavItemId } from './nav';
import { DEFAULT_SAFETY, type SafetyConfig } from '../screens/SettingsScreen';
import { getServerStatus } from '../api';

export function AppShell() {
  const [active, setActive] = useState<NavItemId>('welcome');
  const [safety, setSafety] = useState<SafetyConfig>(DEFAULT_SAFETY);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('checking');
  const [serverUrl, setServerUrl] = useState<string | null>(null);

  useEffect(() => {
    getServerStatus()
      .then((data) => {
        setConnectionStatus(data.status);
        setServerUrl(data.immichUrl);
      })
      .catch(() => {
        setConnectionStatus('disconnected');
      });
  }, []);

  return (
    <div className="app-shell">
      <Header connectionStatus={connectionStatus} serverUrl={serverUrl} />
      <div className="app-shell__body">
        <Sidebar active={active} onNavigate={setActive} />
        <MainContent active={active} safety={safety} onSafetyChange={setSafety} />
      </div>
    </div>
  );
}
