import { useState } from 'react';
import { Header, type ConnectionStatus } from './Header';
import { Sidebar } from './Sidebar';
import { MainContent } from './MainContent';
import { type NavItemId } from './nav';

// TODO: wire up real Immich connection probe and server URL from settings
const MOCK_CONNECTION_STATUS: ConnectionStatus = 'not_connected';
const MOCK_SERVER_URL: string | null = null;

export function AppShell() {
  const [active, setActive] = useState<NavItemId>('welcome');

  return (
    <div className="app-shell">
      <Header connectionStatus={MOCK_CONNECTION_STATUS} serverUrl={MOCK_SERVER_URL} />
      <div className="app-shell__body">
        <Sidebar active={active} onNavigate={setActive} />
        <MainContent active={active} />
      </div>
    </div>
  );
}
