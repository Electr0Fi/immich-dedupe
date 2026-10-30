import { ExecutionResults } from '../components/ExecutionResults';
import { useCallback, useEffect, useRef, useState } from 'react';
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

import {
  getDedupeCache, getDedupeCacheGeneration, setDedupeCache, type DedupeSnapshot,
} from '../dedupeCache';

const INITIAL_SCAN_LIMIT = 100;
async function fetchSnapshot(scanLimit: number): Promise<DedupeSnapshot> {
  const [status, plan, analysis] = await Promise.all([
    getExecutionStatus(scanLimit), getExecutionPlan(scanLimit), getDuplicateAnalysis(scanLimit),
  ]);
  return { status, plan, analysis };
}

type Props = {
  requireConfirmation: boolean;
};

export function DedupeScreen({ requireConfirmation }: Props) {
  const [scanLimit, setScanLimit] = useState(INITIAL_SCAN_LIMIT);
  const [executeLimit, setExecuteLimit] = useState(5);

  const [status, setStatus] = useState<ExecutionStatusResponse | null>(getDedupeCache()?.status ?? null);
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(getDedupeCache()?.plan ?? null);
  const [analysis, setAnalysis] = useState<DuplicateAnalysisResponse | null>(getDedupeCache()?.analysis ?? null);
  const [lastRun, setLastRun] = useState<ExecutionRunResponse | null>(null);

  const [statusLoading, setStatusLoading] = useState(!getDedupeCache());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const applySnapshot = useCallback((snapshot: DedupeSnapshot, generation: number) => {
    setDedupeCache(snapshot, generation);
    setStatus(snapshot.status);
    setPlan(snapshot.plan);
    setAnalysis(snapshot.analysis);
  }, []);

  async function refresh() {
    const version = ++requestVersion.current;
    const generation = getDedupeCacheGeneration();
    setStatusLoading(true);
    setError(null);
    try {
      const snapshot = await fetchSnapshot(scanLimit);
      if (mounted.current && version === requestVersion.current) applySnapshot(snapshot, generation);
    } catch (err) {
      if (mounted.current && version === requestVersion.current) {
        setError(err instanceof Error ? err.message : 'Unknown error');
      }
    } finally {
      if (mounted.current && version === requestVersion.current) setStatusLoading(false);
    }
  }

  async function handleDryRun() {
    setLoading(true);
    setError(null);
    try {
      const result = await runExecution({ scanLimit, executeLimit, dryRun: true });
      if (mounted.current) {
        setLastRun(result);
        await refresh();
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (mounted.current) setLoading(false);
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
      if (mounted.current) {
        setLastRun(result);
        await refresh();
      }
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      if (mounted.current) setLoading(false);
    }
  }

  useEffect(() => {
    mounted.current = true;
    const version = ++requestVersion.current;
    const generation = getDedupeCacheGeneration();
    if (!getDedupeCache()) {
      fetchSnapshot(INITIAL_SCAN_LIMIT)
        .then((snapshot) => {
          if (mounted.current && version === requestVersion.current) applySnapshot(snapshot, generation);
        })
        .catch((err: unknown) => {
          if (mounted.current && version === requestVersion.current) {
            setError(err instanceof Error ? err.message : 'Unknown error');
          }
        })
        .finally(() => {
          if (mounted.current && version === requestVersion.current) setStatusLoading(false);
        });
    }
    return () => {
      mounted.current = false;
    };
  }, [applySnapshot]);

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

      <ExecutionResults run={lastRun} />
    </div>
  );
}
