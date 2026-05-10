import { useEffect, useState } from 'react';
import { getConnectionConfig, saveConnectionConfig, testConnection } from '../api';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

type ConnectionState = {
  immichUrl: string;
  apiKey: string;
  showApiKey: boolean;
  testStatus: TestStatus;
  testMessage: string;
  serverVersion: string | null;
};

export type SafetyConfig = {
  dryRunByDefault: boolean;
  requireConfirmation: boolean;
  preferTrash: boolean;
  blockPermanentDelete: boolean;
  warnFavorites: boolean;
  warnMultipleAlbums: boolean;
};

export type PerformanceConfig = {
  batchSize: number;
  concurrentRequests: number;
  requestDelayMs: number;
  cacheEnabled: boolean;
};

const DEFAULT_CONNECTION: ConnectionState = {
  immichUrl: '',
  apiKey: '',
  showApiKey: false,
  testStatus: 'idle',
  testMessage: '',
  serverVersion: null,
};

export const DEFAULT_SAFETY: SafetyConfig = {
  dryRunByDefault: true,
  requireConfirmation: true,
  preferTrash: true,
  blockPermanentDelete: true,
  warnFavorites: true,
  warnMultipleAlbums: true,
};

export const DEFAULT_PERFORMANCE: PerformanceConfig = {
  batchSize: 50,
  concurrentRequests: 3,
  requestDelayMs: 200,
  cacheEnabled: true,
};

const SAFETY_TOGGLES: Array<{ key: keyof SafetyConfig; label: string; hint: string }> = [
  {
    key: 'dryRunByDefault',
    label: 'Dry-run by default',
    hint: 'Simulate all operations without making changes unless explicitly overridden.',
  },
  {
    key: 'requireConfirmation',
    label: 'Require confirmation before execution',
    hint: 'Show a confirmation prompt before any live run.',
  },
  {
    key: 'preferTrash',
    label: 'Prefer trash over permanent delete',
    hint: 'Send assets to the Immich trash instead of deleting them permanently.',
  },
  {
    key: 'blockPermanentDelete',
    label: 'Block permanent delete',
    hint: 'Prevent hard deletes unless this setting is explicitly disabled.',
  },
  {
    key: 'warnFavorites',
    label: 'Warn when a favorited asset is selected',
    hint: 'Show a warning if a favorited asset is about to be trashed.',
  },
  {
    key: 'warnMultipleAlbums',
    label: 'Warn when asset is in multiple albums',
    hint: 'Show a warning if an asset appears in more than one album.',
  },
];

export function SettingsScreen() {
  const [conn, setConn] = useState<ConnectionState>(DEFAULT_CONNECTION);
  const [safety, setSafety] = useState<SafetyConfig>(DEFAULT_SAFETY);
  const [perf, setPerf] = useState<PerformanceConfig>(DEFAULT_PERFORMANCE);

  useEffect(() => {
    getConnectionConfig()
      .then((data) => {
        setConn((prev) => ({
          ...prev,
          immichUrl: data.immichUrl || prev.immichUrl,
          apiKey: data.apiKey || prev.apiKey,
        }));
      })
      .catch(() => {
        // If the API is unreachable, leave fields empty for manual entry
      });
  }, []);

  async function handleTestConnection() {
    const { immichUrl, apiKey } = conn;

    if (!immichUrl.trim()) {
      setConn((prev) => ({ ...prev, testStatus: 'error', testMessage: 'Server URL is required.' }));
      return;
    }
    if (!apiKey.trim()) {
      setConn((prev) => ({ ...prev, testStatus: 'error', testMessage: 'API key is required.' }));
      return;
    }

    setConn((prev) => ({ ...prev, testStatus: 'testing', testMessage: '', serverVersion: null }));

    try {
      const result = await testConnection({ immichUrl, apiKey });

      if (result.ok && result.version) {
        await saveConnectionConfig({ immichUrl, apiKey });
        setConn((prev) => ({
          ...prev,
          testStatus: 'success',
          testMessage: '',
          serverVersion: result.version ?? null,
        }));
      } else {
        setConn((prev) => ({
          ...prev,
          testStatus: 'error',
          testMessage: result.error ?? 'Connection failed: unable to reach server.',
          serverVersion: null,
        }));
      }
    } catch (err) {
      setConn((prev) => ({
        ...prev,
        testStatus: 'error',
        testMessage: err instanceof Error ? err.message : 'Connection failed: unable to reach server.',
        serverVersion: null,
      }));
    }
  }

  function handleExportDiagnostics() {
    const diagnostics = {
      exportedAt: new Date().toISOString(),
      connection: {
        immichUrl: conn.immichUrl,
        // API key intentionally omitted
        apiKeyConfigured: conn.apiKey.length > 0,
      },
      safety,
      performance: perf,
    };
    const blob = new Blob([JSON.stringify(diagnostics, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `immich-dedupe-diagnostics-${Date.now()}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleResetCache() {
    const confirmed = window.confirm('Reset local cache? This will clear any locally cached scan data.');
    if (confirmed) {
      window.alert('Cache reset. (No persistent cache exists in this build.)');
    }
  }

  function handleClearCredentials() {
    const confirmed = window.confirm(
      'Clear saved credentials? This will remove the server URL and API key.'
    );
    if (confirmed) {
      setConn(DEFAULT_CONNECTION);
    }
  }

  const connectionResult =
    conn.testStatus === 'idle' ? null : conn.testStatus === 'testing' ? (
      <span className="connection-result connection-result--testing">Connecting…</span>
    ) : conn.testStatus === 'success' ? (
      <span className="connection-result connection-result--success">
        Success: Settings saved!
        {conn.serverVersion && <><br />Server {conn.serverVersion}</>}
      </span>
    ) : (
      <span className="connection-result connection-result--error">{conn.testMessage}</span>
    );

  return (
    <div>
      <header className="screen-header">
        <h1>Settings</h1>
        <p>Configure your Immich connection and app preferences.</p>
      </header>

      {/* ── Immich Connection ───────────────────────── */}
      <section className="card">
        <h2>Immich Connection</h2>

        <div className="settings-fields">
          <div className="settings-field">
            <label htmlFor="immich-url">Server URL</label>
            <input
              id="immich-url"
              type="url"
              placeholder="https://[ip-address]:[port]/api"
              value={conn.immichUrl}
              onChange={(e) => setConn((prev) => ({ ...prev, immichUrl: e.target.value }))}
            />
          </div>

          <div className="settings-field">
            <label htmlFor="api-key">API Key</label>
            <div className="input-with-action">
              <input
                id="api-key"
                type={conn.showApiKey ? 'text' : 'password'}
                placeholder="Paste your Immich API key"
                value={conn.apiKey}
                autoComplete="off"
                onChange={(e) => setConn((prev) => ({ ...prev, apiKey: e.target.value }))}
              />
              <button
                type="button"
                onClick={() => setConn((prev) => ({ ...prev, showApiKey: !prev.showApiKey }))}
              >
                {conn.showApiKey ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="settings-field">
            <button
              type="button"
              disabled={conn.testStatus === 'testing'}
              onClick={handleTestConnection}
            >
              {conn.testStatus === 'testing' ? 'Testing…' : 'Test Connection'}
            </button>
            {connectionResult}
          </div>
        </div>
      </section>

      {/* ── Safety ──────────────────────────────────── */}
      <section className="card">
        <h2>Safety</h2>
        <p className="section-hint">
          Conservative defaults protect your library. Change only if you understand the risk.
        </p>

        <div className="toggle-list">
          {SAFETY_TOGGLES.map(({ key, label, hint }) => (
            <label key={key} className="toggle-row">
              <input
                type="checkbox"
                checked={safety[key]}
                onChange={(e) => setSafety((prev) => ({ ...prev, [key]: e.target.checked }))}
              />
              <span>
                <span className="toggle-label">{label}</span>
                <span className="toggle-hint">{hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* ── Performance ─────────────────────────────── */}
      <section className="card">
        <h2>Performance</h2>

        <div className="settings-fields">
          <div className="settings-grid">
            <div className="settings-field">
              <label htmlFor="batch-size">Batch Size</label>
              <input
                id="batch-size"
                type="number"
                min={1}
                max={500}
                value={perf.batchSize}
                onChange={(e) =>
                  setPerf((prev) => ({ ...prev, batchSize: Number(e.target.value) }))
                }
              />
              <span className="field-hint">Assets processed per batch.</span>
            </div>

            <div className="settings-field">
              <label htmlFor="concurrent-requests">Concurrent Requests</label>
              <input
                id="concurrent-requests"
                type="number"
                min={1}
                max={10}
                value={perf.concurrentRequests}
                onChange={(e) =>
                  setPerf((prev) => ({ ...prev, concurrentRequests: Number(e.target.value) }))
                }
              />
              <span className="field-hint">Parallel API requests allowed.</span>
            </div>

            <div className="settings-field">
              <label htmlFor="request-delay">Request Delay (ms)</label>
              <input
                id="request-delay"
                type="number"
                min={0}
                max={5000}
                step={50}
                value={perf.requestDelayMs}
                onChange={(e) =>
                  setPerf((prev) => ({ ...prev, requestDelayMs: Number(e.target.value) }))
                }
              />
              <span className="field-hint">Delay between calls to avoid rate limits.</span>
            </div>
          </div>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={perf.cacheEnabled}
              onChange={(e) => setPerf((prev) => ({ ...prev, cacheEnabled: e.target.checked }))}
            />
            <span>
              <span className="toggle-label">Enable local cache</span>
              <span className="toggle-hint">
                Cache duplicate scan results to speed up repeated runs.
              </span>
            </span>
          </label>

          {perf.cacheEnabled && (
            <div className="settings-field">
              <label>Cache Location</label>
              <div className="readonly-value">~/.immich-dedupe/cache</div>
              <span className="field-hint">Configurable in a future release.</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Advanced ────────────────────────────────── */}
      <section className="card">
        <h2>Advanced</h2>
        <p className="section-hint">Diagnostic and maintenance actions. Use with care.</p>

        <div className="advanced-actions">
          <button type="button" onClick={handleResetCache}>
            Reset Local Cache
          </button>
          <button type="button" onClick={handleExportDiagnostics}>
            Export Diagnostics
          </button>
          <button type="button" className="danger" onClick={handleClearCredentials}>
            Clear Credentials
          </button>
        </div>
      </section>
    </div>
  );
}
