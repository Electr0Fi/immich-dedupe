import { RecoveryPanel } from '../components/RecoveryPanel';
import { useEffect, useRef, useState } from 'react';
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

  const mounted = useRef(false);
  const requestVersion = useRef(0);

  async function refresh() {
    const version = ++requestVersion.current;
    setError(null);
    const result = await getExecutionLog();
    if (mounted.current && version === requestVersion.current) setLog(result.data);
  }

  async function handleClearLog() {
    const confirmed = window.confirm(
      'Clear display log entries only? Recovery evidence, processed groups, legacy exclusions and quarantines will be preserved.'
    );
    if (!confirmed) return;

    setLoading(true);
    setError(null);
    try {
      await clearExecutionLog();
      if (mounted.current) await refresh();
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  function exportLog(format: 'json' | 'csv') {
    window.location.href = getExecutionLogExportUrl(format);
  }

  useEffect(() => {
    mounted.current = true;
    const version = ++requestVersion.current;
    getExecutionLog()
      .then((result) => {
        if (mounted.current && version === requestVersion.current) setLog(result.data);
      })
      .catch((err: unknown) => {
        if (mounted.current && version === requestVersion.current) {
          setError(err instanceof Error ? err.message : 'Unknown error');
        }
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  return (
    <div>
      <header className="screen-header">
        <h1>Logs</h1>
        <p>Audit trail of all execution operations.</p>
      </header>

      <RecoveryPanel />

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
                <th>Outcome</th>
                <th>Failure stage</th>
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
                    <td>{entry.groupId}{entry.runId && <small className="attempt-identifier">Run: {entry.runId}</small>}{entry.attemptId && <small className="attempt-identifier">Attempt: {entry.attemptId}</small>}</td>
                    <td>{entry.mode}</td>
                    <td>{entry.outcome === 'needs-verification' ? 'Needs verification' : entry.outcome ?? 'Legacy record'}</td>
                    <td>{entry.failureStage ?? '—'}</td>
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
