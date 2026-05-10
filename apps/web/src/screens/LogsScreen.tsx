import { useEffect, useState } from 'react';
import {
  clearExecutionLog,
  getExecutionLog,
  getExecutionLogExportUrl,
  type ExecutionLogEntry,
} from '../api';

export function LogsScreen() {
  const [log, setLog] = useState<ExecutionLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const result = await getExecutionLog();
    setLog(result.data);
  }

  async function handleClearLog() {
    const confirmed = window.confirm(
      'Clear the execution log? This removes audit entries and processed-history tracking from the app.'
    );
    if (!confirmed) return;

    setLoading(true);
    setError(null);
    try {
      await clearExecutionLog();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  function exportLog(format: 'json' | 'csv') {
    window.location.href = getExecutionLogExportUrl(format);
  }

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : 'Unknown error')
    );
  }, []);

  return (
    <div>
      <header className="screen-header">
        <h1>Logs</h1>
        <p>Audit trail of all execution operations.</p>
      </header>

      <section className="card">
        <h2>Execution Log</h2>

        <div className="buttonRow tableActions">
          <button type="button" onClick={() => exportLog('json')}>
            Export JSON
          </button>
          <button type="button" onClick={() => exportLog('csv')}>
            Export CSV
          </button>
          <button type="button" disabled={loading} className="danger" onClick={handleClearLog}>
            Clear Log
          </button>
        </div>

        {error && <p className="error">{error}</p>}

        {log.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Group</th>
                <th>Mode</th>
                <th>Executed</th>
                <th>Resolved</th>
                <th>Trashed</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {log
                .slice()
                .reverse()
                .slice(0, 20)
                .map((entry, index) => (
                  <tr key={`${entry.timestamp}-${entry.groupId}-${index}`}>
                    <td>{entry.timestamp}</td>
                    <td>{entry.groupId}</td>
                    <td>{entry.mode}</td>
                    <td>{String(entry.executed)}</td>
                    <td>{String(entry.resolvedDuplicate)}</td>
                    <td>{String(entry.trashedAsset)}</td>
                    <td>{entry.message}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p>No log entries yet.</p>
        )}
      </section>
    </div>
  );
}
