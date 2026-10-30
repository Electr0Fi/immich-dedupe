import type { ExecutionRunResponse } from '../api';

export function ExecutionResults({ run }: { run: ExecutionRunResponse | null }) {
  return (
    <section className="card">
      <h2>Last Run Results</h2>
      {run?.runId && <p className="run-identifier">Run: {run.runId}</p>}
      {run?.excludedGroups && run.excludedGroups.length > 0 && (
        <details>
          <summary>{run.excludedGroups.length} groups excluded from execution</summary>
          <ul>{run.excludedGroups.map((group) => <li key={group.groupId}>{group.groupId}: {group.reason}</li>)}</ul>
        </details>
      )}
      {run?.stoppedEarly && (
        <p className="error" role="alert">Batch stopped: {run.stopReason}</p>
      )}
      {run && run.results.length > 0 ? (
        <div className="execution-results-table">
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Mode</th>
                <th>Outcome</th>
                <th>Failure stage</th>
                <th>Proposed albums</th>
                <th>Confirmed transfers</th>
                <th>Keep</th>
                <th>Trash</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {run.results.map((result) => (
                <tr key={`${result.groupId}-${result.mode}`}>
                  <td>{result.groupId}{result.attemptId && <small className="attempt-identifier">Attempt: {result.attemptId}</small>}</td>
                  <td>{result.mode}</td>
                  <td>{result.outcome === 'needs-verification' ? 'Needs verification' : result.outcome}</td>
                  <td>{result.failureStage ?? '—'}</td>
                  <td>{result.proposedAlbumIds.length}</td>
                  <td>{result.transferredAlbumIds.length}</td>
                  <td>{result.keepAssetId}</td>
                  <td>{result.trashAssetId}</td>
                  <td>{result.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>No run results yet.</p>
      )}
    </section>
  );
}
