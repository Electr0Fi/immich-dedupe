import { type Dispatch, type SetStateAction, useEffect, useState } from 'react';
import { getConnectionConfig, saveConnectionConfig, testConnection } from '../api';
import { clearDedupeCache } from '../dedupeCache';
import type { SafetyConfig } from '../settings';

type TestStatus = 'idle' | 'testing' | 'success' | 'error';

type ConnectionState = {
  immichUrl: string;
  apiKey: string;
  showApiKey: boolean;
  testStatus: TestStatus;
  testMessage: string;
  serverVersion: string | null;
};

const DEFAULT_CONNECTION: ConnectionState = {
  immichUrl: '',
  apiKey: '',
  showApiKey: false,
  testStatus: 'idle',
  testMessage: '',
  serverVersion: null,
};

type Props = {
  safety: SafetyConfig;
  onSafetyChange: Dispatch<SetStateAction<SafetyConfig>>;
};

export function SettingsScreen({ safety, onSafetyChange: setSafety }: Props) {
  const [conn, setConn] = useState<ConnectionState>(DEFAULT_CONNECTION);

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
        const saved = await saveConnectionConfig({ immichUrl, apiKey });
        if (!saved.ok) throw new Error(saved.error ?? 'Connection test passed, but settings could not be saved.');
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
      browserPreferences: { requireConfirmation: safety.requireConfirmation },
      connectionTest: { status: conn.testStatus, testedServerVersion: conn.serverVersion },
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
    const confirmed = window.confirm('Reset preview cache? This clears browser scan previews only. Backend size caches, execution records, and recovery evidence are preserved.');
    if (confirmed) {
      clearDedupeCache();
    }
  }

  function handleClearCredentials() {
    const confirmed = window.confirm(
      'Clear this form? Saved credentials and the active API connection will remain unchanged.'
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
        Connection test passed and settings saved. Restart the API to apply the connection; reload the page to refresh the header status. This test checks server.about only; it does not verify review, thumbnail, cleanup or user.read permissions.
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
        <p>Test and save writes the backend configuration. Restart the API after saving. The key needs user.read for execution and recovery identity checks.</p>

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
              {conn.testStatus === 'testing' ? 'Testing…' : 'Test and save'}
            </button>
            {connectionResult}
          </div>
        </div>

        <section aria-labelledby="api-permissions-title">
          <h3 id="api-permissions-title">Required API key permissions</h3>
          <p>In Immich, open Account Settings → API Keys and edit or create the key used here. Grant these permissions for the full workflow with the Immich 2.7.x API used by this app.</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>Permission</th><th>Used for</th></tr></thead>
              <tbody>
                <tr><td><code>server.about</code></td><td>Connection test, server version and header connection status.</td></tr>
                <tr><td><code>user.read</code></td><td>Account identity for reviews, dry-runs, execution, saved runs and recovery.</td></tr>
                <tr><td><code>duplicate.read</code></td><td>Duplicate previews and fresh group membership checks.</td></tr>
                <tr><td><code>asset.read</code></td><td>Asset metadata, file sizes, safety checks and outcome verification.</td></tr>
                <tr><td><code>asset.view</code></td><td>Keeper and loser thumbnail images in prepared reviews.</td></tr>
                <tr><td><code>album.read</code></td><td>Album memberships and album-preservation verification.</td></tr>
                <tr><td><code>albumAsset.create</code></td><td>Live execution: add the keeper to missing loser albums.</td></tr>
                <tr><td><code>duplicate.delete</code></td><td>Live execution: resolve duplicate groups and trash the selected losers.</td></tr>
              </tbody>
            </table>
          </div>
          <p>For previews, review preparation, dry-runs and recovery reads, the first six permissions are sufficient. Live cleanup also needs the last two. These scopes do not override the account’s asset ownership or album access; preserving a shared album requires permission to add assets to it.</p>
          <p><strong>Thumbnail unavailable?</strong> Check <code>asset.view</code>; <code>asset.read</code> covers metadata only. This app requests thumbnails, so <code>asset.download</code> is not needed. After changing permissions, prepare a new review to retry failed images. If they still fail, check that Immich can display the images and has generated their thumbnails; an expired review or an unavailable server can also prevent loading.</p>
          <p>Changes to permissions on the same key are applied by Immich. If you replace the key here, use Test and save, then restart this app’s API. A successful connection test does not verify the other permissions. Use these specific scopes instead of granting all permissions.</p>
        </section>
      </section>

      <section className="card">
        <h2>Execution safety</h2>
        <label className="toggle-row">
          <input type="checkbox" checked={safety.requireConfirmation}
            onChange={(e) => setSafety((prev) => ({ ...prev, requireConfirmation: e.target.checked }))} />
          <span><span className="toggle-label">Confirm before live execution</span>
            <span className="toggle-hint">Browser preference for this session only; resets on reload. Dry-run and Execute are separate actions.</span></span>
        </label>
        <h3>Always enforced by the backend</h3>
        <ul>
          <li>Requests default to dry-run; live execution must be explicitly requested.</li>
          <li>Only eligible image pairs can be resolved. Favorites and other protected or unknown states are excluded.</li>
          <li>Album preservation and trash/duplicate state must be confirmed. Cleanup uses Immich duplicate resolution; no permanent-delete action is offered.</li>
          <li>Failed or uncertain attempts stop the batch. Uncertain attempts remain quarantined until manually assessed.</li>
        </ul>
        <p>These protections are fixed rules. Configurable rules and extra album warning preferences are not implemented.</p>
      </section>

      <section className="card">
        <h2>Performance and cache</h2>
        <p>Configurable concurrency, request delays, batch-size defaults, and cache toggles are not implemented. Set scan and attempt limits in Dedupe for each request.</p>
        <p>Scan previews are cached in browser memory. Asset sizes are cached in API process memory. There is no configurable disk cache directory.</p>
      </section>

      {/* ── Advanced ────────────────────────────────── */}
      <section className="card">
        <h2>Advanced</h2>
        <p className="section-hint">Diagnostic and maintenance actions. Use with care.</p>

        <div className="advanced-actions">
          <button type="button" onClick={handleResetCache}>
            Reset preview cache
          </button>
          <button type="button" onClick={handleExportDiagnostics}>
            Export Diagnostics
          </button>
          <button type="button" className="danger" onClick={handleClearCredentials}>
            Clear form
          </button>
        </div>
      </section>
    </div>
  );
}
