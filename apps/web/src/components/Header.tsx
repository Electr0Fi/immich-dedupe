export type ConnectionStatus = 'connected' | 'disconnected' | 'error' | 'checking';

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  connected: 'Connected',
  disconnected: 'Disconnected',
  error: 'Error',
  checking: 'Checking...',
};

type Props = {
  connectionStatus: ConnectionStatus;
  serverUrl: string | null;
};

export function Header({ connectionStatus, serverUrl }: Props) {
  return (
    <header className="app-header">
      <span className="app-header__name">Immich Dedupe</span>
      <div className="app-header__right">
        {serverUrl && <span className="app-header__url">{serverUrl}</span>}
        <span className={`connection-badge connection-badge--${connectionStatus}`}>
          {STATUS_LABEL[connectionStatus]}
        </span>
      </div>
    </header>
  );
}
