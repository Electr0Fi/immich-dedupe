import { QuickReviewBatch } from '../components/QuickReviewBatch';
import { ReviewPreparationActivity } from '../components/ReviewPreparationActivity';
import { ReviewedBatch } from '../components/ReviewedBatch';
import { ExecutionResults } from '../components/ExecutionResults';
import type { ExecutionState } from '../useExecution';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getDuplicateAnalysis,
  getExecutionPlan,
  getExecutionStatus,
  type DuplicateAnalysisResponse,
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
  const { scanLimit, executeLimit } = execution.limits;
  const quickMode = execution.quickReviewEnabled;

  const [status, setStatus] = useState<ExecutionStatusResponse | null>(getDedupeCache()?.status ?? null);
  const [analysis, setAnalysis] = useState<DuplicateAnalysisResponse | null>(getDedupeCache()?.analysis ?? null);

  const [statusLoading, setStatusLoading] = useState(!getDedupeCache());
  const [error, setError] = useState<string | null>(null);
  const previewLoading = statusLoading && !quickMode;

  const requestVersion = useRef(0);
  const mounted = useRef(false);
  const applySnapshot = useCallback((snapshot: DedupeSnapshot, generation: number) => {
    setDedupeCache(snapshot, generation);
    setStatus(snapshot.status);
    setAnalysis(snapshot.analysis);
  }, []);

  async function refresh() {
    if (quickMode) return;
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

  function handleQuickModeChange(enabled: boolean) {
    // A previous full-preview request may finish later; it must not leave Controls busy.
    setStatusLoading(!enabled && !getDedupeCache());
    execution.changeQuickReview(enabled);
  }

  async function handlePrepare() {
    const outcome = await execution.prepare();
    if (mounted.current && outcome === 'completed' && !quickMode) await refresh();
  }
  async function handleRun(dryRun: boolean) {
    const additions = execution.review?.candidates.filter((c) => execution.selected.includes(c.groupId)).reduce((n, c) => n + c.proposedAlbumIds.length, 0) ?? 0;
    if (!dryRun && requireConfirmation && !window.confirm(
      `Execute exactly ${execution.selected.length} reviewed groups with ${additions} proposed album additions? Fresh checks may stop the batch; no replacement groups will be selected.`
    )) return;
    await execution.execute({ dryRun });
    if (mounted.current && !quickMode) await refresh();
  }

  useEffect(() => {
    mounted.current = true;
    const version = ++requestVersion.current;
    const generation = getDedupeCacheGeneration();
    if (!quickMode && !getDedupeCache()) {
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
  }, [applySnapshot, quickMode]);

  const manualReviewItems =
    analysis?.results.filter((d) => d.status === 'uncertain' || d.status === 'skip') ?? [];

  const preparedSnapshot = execution.quickSnapshot ?? execution.review;
  const buttonsDisabled = execution.busy || execution.preparing || execution.selectingAll || execution.loadingDetails || execution.reading || previewLoading || !Number.isSafeInteger(scanLimit) || scanLimit < 1 || !Number.isSafeInteger(executeLimit) || executeLimit < 1;
  const activityMessage = execution.loadingDetails ? 'Loading full details and album actions for selected Quick Review groups…' : execution.selectingAll ? 'Selecting all eligible reviewed groups… Updating Execute Limit.' : execution.busy
    ? execution.request?.dryRun
      ? 'Dry run in progress… No Immich assets will be changed.'
      : 'Execution in progress… Waiting for verified results.'
    : previewLoading
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
              disabled={execution.busy || execution.preparing || execution.selectingAll || execution.loadingDetails} onChange={(e) => execution.changeLimits({ scanLimit: Number(e.target.value), executeLimit })}
            />
          </label>

          <label>
            Execute Limit
            <input
              type="number"
              min={1}
              value={executeLimit}
              disabled={execution.busy || execution.preparing || execution.selectingAll || execution.loadingDetails} onChange={(e) => execution.changeLimits({ scanLimit, executeLimit: Number(e.target.value) })}
            />
          </label>
        </div>

        <div className="buttonRow">
          <button disabled={buttonsDisabled || quickMode} onClick={refresh}>
            Refresh previews
          </button>
          <button disabled={execution.preparing ? execution.cancelling : buttonsDisabled} onClick={execution.preparing ? execution.cancelPreparation : handlePrepare}>
            {execution.preparing ? execution.cancelling ? 'Cancelling…' : 'Cancel review' : 'Prepare review'}
          </button>
          <button disabled={buttonsDisabled || !execution.validReview || execution.selected.length === 0} onClick={() => handleRun(true)}>
            {execution.busy && execution.request?.dryRun ? 'Running dry run…' : 'Dry-run selected'}
          </button>
          <button disabled={buttonsDisabled || !execution.canExecute} className="danger" onClick={() => handleRun(false)}>
            {execution.busy && execution.request?.dryRun === false ? 'Executing…' : 'Execute selected'}
          </button>
        </div>

        <label className="toggle-row">
          <input type="checkbox" aria-label="Quick Review" checked={quickMode} disabled={execution.busy || execution.preparing || execution.selectingAll || execution.loadingDetails}
            onChange={(event) => handleQuickModeChange(event.target.checked)} />
          <span><span className="toggle-label">Quick Review</span><span className="toggle-hint">Use duplicate-list data only for a faster scan. Missing information remains unverified. Load selected details before dry-run or execution.</span></span>
        </label>
        {quickMode && <p className="field-hint">Detailed preview refreshes are disabled in Quick Review. Switch it off to use Refresh previews. Any reads already started may finish.</p>}
        {execution.preparing && <ReviewPreparationActivity execution={execution} />}
        {execution.preparationMessage && <p role="status">{execution.preparationMessage}</p>}
        <div className="dedupe-activity status-refreshing" role="status" aria-live="polite" aria-atomic="true">
          {activityMessage && <><span className="spinner" aria-hidden="true" /><span>{activityMessage}</span></>}
        </div>

        {!quickMode && error && <p className="error" role="alert">Preview refresh failed: {error}. Use Refresh previews to try again. Execution results below are preserved.</p>}
      </section>

      <section className="card">
        <h2>Status</h2>
        {quickMode ? (
          preparedSnapshot ? <p>{preparedSnapshot.fetchedGroups} groups checked · {preparedSnapshot.candidates.length} candidates · {preparedSnapshot.excludedGroups.length} excluded or unverified. Counts come from the prepared result.</p>
            : <p>Prepare a Quick Review to see counts without detailed preview enrichment.</p>
        ) : statusLoading ? (
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

      {execution.quickSnapshot ? <QuickReviewBatch execution={execution} /> : <ReviewedBatch execution={execution} />}

      <ExecutionResults execution={execution} onReviewRecovery={onReviewRecovery} />

      <section className="card">
        <h2>Manual Review</h2>
        {quickMode ? <p>{execution.quickSnapshot ? "Excluded and unverified groups are shown in the prepared Quick Review above." : execution.review ? "The detailed review above contains only your selected groups. Prepare another Quick Review to scan again." : "Prepare a Quick Review to see excluded and unverified groups."}</p> : statusLoading ? (
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
