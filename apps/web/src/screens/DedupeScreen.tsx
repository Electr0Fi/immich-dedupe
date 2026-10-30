import { ExecutionResults } from '../components/ExecutionResults';
import type { ExecutionState } from '../useExecution';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDuplicateAnalysis,
  getExecutionPlan,
  getExecutionStatus,
  type DuplicateAnalysisResponse,
  type ExecutionPlanResponse,
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
  execution: ExecutionState;
  onReviewRecovery: (attemptId: string) => void;
};

export function DedupeScreen({ requireConfirmation, execution, onReviewRecovery }: Props) {
  const [scanLimit, setScanLimit] = useState(INITIAL_SCAN_LIMIT);
  const [executeLimit, setExecuteLimit] = useState(5);

  const [status, setStatus] = useState<ExecutionStatusResponse | null>(getDedupeCache()?.status ?? null);
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(getDedupeCache()?.plan ?? null);
  const [analysis, setAnalysis] = useState<DuplicateAnalysisResponse | null>(getDedupeCache()?.analysis ?? null);

  const [statusLoading, setStatusLoading] = useState(!getDedupeCache());
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

  async function handleRun(dryRun: boolean) {
    if (!dryRun && requireConfirmation && !window.confirm(
      `Execute up to ${executeLimit} duplicate resolutions from the first ${scanLimit} scanned groups?`
    )) return;
    await execution.execute({ scanLimit, executeLimit, dryRun });
    if (mounted.current) await refresh();
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

  const buttonsDisabled = execution.busy || execution.reading || statusLoading || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || !Number.isSafeInteger(executeLimit) || executeLimit < 1;
  const activityMessage = execution.busy
    ? execution.request?.dryRun
      ? 'Dry run in progress… No Immich assets will be changed.'
      : 'Execution in progress… Waiting for verified results.'
    : statusLoading
      ? 'Refreshing duplicate previews…'
      : execution.reading
        ? 'Loading latest saved run…'
        : null;

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
          <button disabled={buttonsDisabled} onClick={() => handleRun(true)}>
            {execution.busy && execution.request?.dryRun ? 'Running dry run…' : 'Dry run'}
          </button>
          <button disabled={buttonsDisabled} className="danger" onClick={() => handleRun(false)}>
            {execution.busy && execution.request?.dryRun === false ? 'Executing…' : 'Execute'}
          </button>
        </div>

        <div className="dedupe-activity status-refreshing" role="status" aria-live="polite" aria-atomic="true">
          {activityMessage && <><span className="spinner" aria-hidden="true" /><span>{activityMessage}</span></>}
        </div>

        {error && <p className="error" role="alert">Preview refresh failed: {error}. Execution results below are preserved.</p>}
      </section>

      <section className="card">
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
      </section>

      <ExecutionResults execution={execution} onReviewRecovery={onReviewRecovery} />

      <section className="card">
        <h2>Execution Plan Preview</h2>
        <p className="field-hint">Confidence is a fixed rule score. Execution repeats fresh safety checks and may exclude processed or quarantined groups shown in this preview.</p>
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


    </div>
  );
}
