import { useEffect, useState } from 'react';
import {
  getDuplicateAnalysis,
  getExecutionPlan,
  getExecutionStatus,
  runExecution,
  type DuplicateAnalysisResponse,
  type ExecutionPlanResponse,
  type ExecutionRunResponse,
  type ExecutionStatusResponse,
} from '../api';

// Module-level cache — survives mount/unmount so navigating away and back skips re-fetch.
let cachedStatus: ExecutionStatusResponse | null = null;
let cachedPlan: ExecutionPlanResponse | null = null;
let cachedAnalysis: DuplicateAnalysisResponse | null = null;

export function clearDedupeCache() {
  cachedStatus = null;
  cachedPlan = null;
  cachedAnalysis = null;
}

type Props = {
  requireConfirmation: boolean;
};

export function DedupeScreen({ requireConfirmation }: Props) {
  const [scanLimit, setScanLimit] = useState(100);
  const [executeLimit, setExecuteLimit] = useState(5);

  const [status, setStatus] = useState<ExecutionStatusResponse | null>(cachedStatus);
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(cachedPlan);
  const [analysis, setAnalysis] = useState<DuplicateAnalysisResponse | null>(cachedAnalysis);
  const [lastRun, setLastRun] = useState<ExecutionRunResponse | null>(null);

  const [statusLoading, setStatusLoading] = useState(!cachedStatus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setStatusLoading(true);
    setError(null);
    try {
      const [statusResult, planResult, analysisResult] = await Promise.all([
        getExecutionStatus(scanLimit),
        getExecutionPlan(scanLimit),
        getDuplicateAnalysis(scanLimit),
      ]);
      cachedStatus = statusResult;
      cachedPlan = planResult;
      cachedAnalysis = analysisResult;
      setStatus(statusResult);
      setPlan(planResult);
      setAnalysis(analysisResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setStatusLoading(false);
    }
  }

  async function handleDryRun() {
    setLoading(true);
    setError(null);
    try {
      const result = await runExecution({ scanLimit, executeLimit, dryRun: true });
      setLastRun(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  async function handleExecute() {
    if (requireConfirmation) {
      const confirmed = window.confirm(
        `Execute up to ${executeLimit} duplicate resolutions from the first ${scanLimit} scanned groups?`
      );
      if (!confirmed) return;
    }

    setLoading(true);
    setError(null);
    try {
      const result = await runExecution({ scanLimit, executeLimit, dryRun: false });
      setLastRun(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!cachedStatus) {
      refresh();
    }
  }, []);

  const manualReviewItems =
    analysis?.results.filter((d) => d.status === 'uncertain' || d.status === 'skip') ?? [];

  const buttonsDisabled = loading || statusLoading;

  return (
    <div>
      <header className="screen-header">
        <h1>Dedupe</h1>
        <p>Review, dry-run, and execute safe duplicate resolutions.</p>
      </header>

      <section className="card">
        <h2>Controls</h2>

        <div className="controls">
          <label>
            Scan Limit
            <input
              type="number"
              min={1}
              value={scanLimit}
              onChange={(e) => setScanLimit(Number(e.target.value))}
            />
          </label>

          <label>
            Execute Limit
            <input
              type="number"
              min={1}
              value={executeLimit}
              onChange={(e) => setExecuteLimit(Number(e.target.value))}
            />
          </label>
        </div>

        <div className="buttonRow">
          <button disabled={buttonsDisabled} onClick={() => refresh()}>
            Refresh
          </button>
          <button disabled={buttonsDisabled} onClick={handleDryRun}>
            Dry run
          </button>
          <button disabled={buttonsDisabled} className="danger" onClick={handleExecute}>
            Execute
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="grid">
        <div className="card">
          <h2>Status</h2>
          {statusLoading ? (
            <div className="status-refreshing">
              <span className="spinner" />
              Refreshing
            </div>
          ) : status ? (
            <dl className="stats">
              <div>
                <dt>Total Duplicates</dt>
                <dd>{status.duplicateCount}</dd>
              </div>
              <div>
                <dt>Scanned</dt>
                <dd>{status.scannedDuplicateCount}</dd>
              </div>
              <div>
                <dt>Executable</dt>
                <dd>{status.executableCount}</dd>
              </div>
              <div>
                <dt>Log Entries</dt>
                <dd>{status.logCount}</dd>
              </div>
            </dl>
          ) : (
            <p>No status loaded.</p>
          )}
        </div>

        <div className="card">
          <h2>Last Run</h2>
          {lastRun ? (
            <dl className="stats">
              <div>
                <dt>Dry run</dt>
                <dd>{String(lastRun.dryRun)}</dd>
              </div>
              <div>
                <dt>Eligible</dt>
                <dd>{lastRun.eligibleCount}</dd>
              </div>
              <div>
                <dt>Executed</dt>
                <dd>{lastRun.actuallyExecutedCount}</dd>
              </div>
              <div>
                <dt>Trashed</dt>
                <dd>{lastRun.trashedCount}</dd>
              </div>
            </dl>
          ) : (
            <p>No run yet.</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Execution Plan Preview</h2>
        {statusLoading ? (
          <div className="status-refreshing">
            <span className="spinner" />
            Refreshing
          </div>
        ) : plan && plan.items.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Keep</th>
                <th>Trash</th>
                <th>Confidence</th>
                <th>Rule</th>
                <th>Reasons</th>
                <th>Albums</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((item) => (
                <tr key={item.groupId}>
                  <td>{item.groupId}</td>
                  <td>{item.keepAssetId}</td>
                  <td>{item.trashAssetId}</td>
                  <td>{item.confidence}</td>
                  <td>{item.ruleName ?? 'Unknown'}</td>
                  <td>{item.reasons.join('; ')}</td>
                  <td>{item.albumTransferCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No executable plan items found.</p>
        )}
      </section>

      <section className="card">
        <h2>Manual Review</h2>
        {statusLoading ? (
          <div className="status-refreshing">
            <span className="spinner" />
            Refreshing
          </div>
        ) : manualReviewItems.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Rule</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {manualReviewItems.map((decision) => (
                <tr key={decision.groupId}>
                  <td>{decision.groupId}</td>
                  <td>{decision.status}</td>
                  <td>{decision.confidence}</td>
                  <td>{decision.matchedRuleName ?? 'None'}</td>
                  <td>{decision.reasons.join('; ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No uncertain or skipped duplicates in this scan window.</p>
        )}
      </section>

      <section className="card">
        <h2>Last Run Results</h2>
        {lastRun && lastRun.results.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Mode</th>
                <th>Executed</th>
                <th>Keep</th>
                <th>Trash</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {lastRun.results.map((result) => (
                <tr key={`${result.groupId}-${result.mode}`}>
                  <td>{result.groupId}</td>
                  <td>{result.mode}</td>
                  <td>{String(result.executed)}</td>
                  <td>{result.keepAssetId}</td>
                  <td>{result.trashAssetId}</td>
                  <td>{result.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No run results yet.</p>
        )}
      </section>
    </div>
  );
}
