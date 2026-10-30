import { useId, useState } from 'react';
import type { ExecutionState } from '../useExecution';

const outcomeLabels = { succeeded: 'Verified completed', 'dry-run': 'Simulated', failed: 'Failed', 'needs-verification': 'Needs verification' };
const outcomeDefinitions: Record<string, string> = {
  succeeded: 'Album preservation and resolution were confirmed.',
  'dry-run': 'No Immich mutations were made. The proposed changes were simulated.',
  failed: 'Checks stopped the attempt before any Immich mutation.',
  'needs-verification': 'Changes may have occurred, but the outcome could not be fully confirmed. Review recovery before retrying.',
};

function OutcomeStat({ label, value, definition }: { label: string; value: string | number; definition: string }) {
  const [open, setOpen] = useState(false);
  const tooltipId = useId();
  return <div className="outcome-stat" onMouseLeave={(event) => {
    if (!event.currentTarget.contains(event.currentTarget.ownerDocument.activeElement)) setOpen(false);
  }}>
    <dt><span>{label}</span>
      <button type="button" className="outcome-info" aria-label={`About ${label}`}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={() => setOpen(true)} onFocus={() => setOpen(true)} onClick={() => setOpen(true)}
        onBlur={() => setOpen(false)} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
        <span aria-hidden="true">i</span>
      </button>
      {open && <span id={tooltipId} role="tooltip" className="outcome-tooltip">{definition}</span>}
    </dt>
    <dd>{value}</dd>
  </div>;
}
const stageLabels: Record<string, string> = {
  preflight: 'Fresh safety checks', 'album-transfer': 'Adding keeper to albums', 'album-verification': 'Confirming album preservation',
  resolution: 'Resolving the duplicate', verification: 'Verifying the result', prepared: 'Attempt recorded',
};
export function ExecutionResults({ execution, onReviewRecovery }: { execution: ExecutionState; onReviewRecovery: (attemptId: string) => void }) {
  const { run, request, reading, readError } = execution;
  const results = run?.attempts.flatMap((a) => a.result ? [a.result] : []) ?? [];
  const excluded = run?.report?.excludedGroups ?? [];
  return <section className="card" aria-labelledby="run-results-title">
    <h2 id="run-results-title">{execution.partial ? 'Partial results returned by the API' : request ? 'Previous recorded run' : 'Latest run results'}</h2>
    <button disabled={execution.busy || reading} onClick={() => execution.refreshLatest()}>Refresh latest</button>
    <p className="field-hint">Latest journal run for the current Immich account, including runs from other tabs. Refresh to check again.</p>
    {request && <div className={request.phase === 'pending' ? '' : 'error'} role={request.phase === 'pending' ? 'status' : 'alert'}>
      <p>{request.message}</p>
      {request.runId && <p className="run-identifier">Request run: {request.runId}</p>}
      {request.phase === 'unknown' && <p>Outcome unknown. The server may still be working. Refresh latest and review recovery before another live attempt; no automatic retry is performed.</p>}
      {request.phase === 'failed' && <p>The new request did not complete normally. Any returned partial results are shown below. A recording failure requires investigation before retrying.</p>}
    </div>}
    {reading && <p role="status">Loading latest run…</p>}
    {execution.partial && <p>These partial results came from the response and may not all be saved in the journal. They remain visible during this session; reload can only restore saved evidence.</p>}
    {readError && <p className="error" role="alert">{readError}</p>}
    {!run ? <p>No recorded run loaded.</p> : <>
      <p><strong>{run.context ? (run.context.dryRun ? 'Dry-run' : 'Live execution') : 'Mode not recorded'} · {run.phase}</strong></p>
      {run.phase === 'running' && <p role="status">This run is still active. These are the currently recorded facts; refresh to check completion.</p>}
      {run.phase === 'interrupted' && <p className="error">The run has no recorded completion. Its outcome may be incomplete; review recovery before retrying.</p>}
      {run.planId && <p className="run-identifier">Reviewed plan: {run.planId} · Selected: {run.selectedCount}</p>}
      <p className="run-identifier">Run: {run.runId} · Started: {run.startedAt}</p>
      <dl className="stats outcome-summary">
        {Object.entries(outcomeLabels).map(([outcome, label]) => <OutcomeStat key={outcome} label={label}
          value={results.filter((r) => r.outcome === outcome).length} definition={outcomeDefinitions[outcome]} />)}
        <OutcomeStat label="Awaiting recorded result" value={run.attempts.filter((a) => !a.result).length}
          definition="No terminal result has been saved for these attempts. The run may still be active or may have been interrupted." />
        <OutcomeStat label="Excluded" value={run.report ? excluded.length : 'Not recorded'}
          definition="Groups omitted because they were already processed, covered by legacy evidence, or quarantined. Older records may not include this count." />
      </dl>
      <p>Scanned: {run.report?.fetchedGroups ?? 'Not recorded'} · Eligible: {run.report?.eligibleCount ?? 'Not recorded'} · Scan limit: {run.context?.scanLimit ?? 'Not recorded'} · Attempt limit: {run.context?.executeLimit ?? 'Not recorded'}</p>
      {!run.context && <p>Older journal record: request settings, exclusion totals, and stop details were not recorded.</p>}
      {run.report?.stoppedEarly && <p className="error" role="alert">Batch stopped: {run.report.stopReason}</p>}
      {run.report?.requestError && <p className="error">Request error: HTTP {run.report.requestError.status} · {run.report.requestError.message}</p>}
      {excluded.length > 0 && <details><summary>Excluded groups: {excluded.filter((g) => g.reason === 'processed').length} processed, {excluded.filter((g) => g.reason === 'legacy').length} legacy evidence, {excluded.filter((g) => g.reason === 'quarantined').length} quarantined</summary>
        <ul>{excluded.map((g, i) => <li key={`${g.groupId}-${i}`}>Group {g.groupId}: {g.reason}{g.attemptIds.map((id) => <button key={id} onClick={() => onReviewRecovery(id)}>Review recovery</button>)}</li>)}</ul>
      </details>}
      {run.attempts.length === 0 && <p>No groups were attempted in this run.</p>}
      {run.attempts.map((attempt) => <article className="run-attempt" key={attempt.attemptId}>
        <h3>{attempt.result ? outcomeLabels[attempt.result.outcome] : 'Awaiting recorded result'} · Group {attempt.groupId}</h3>
        <p>{attempt.result?.message ?? 'No terminal outcome was recorded.'}</p>
        {attempt.result?.failureStage && <p>Stopped during: {stageLabels[attempt.result.failureStage]}</p>}
        {attempt.recovery !== 'closed' && <p>Recovery: {attempt.recovery}. {attempt.assessment?.message}</p>}
        {(attempt.recovery !== 'closed' || attempt.result?.outcome === 'needs-verification') && <button onClick={() => onReviewRecovery(attempt.attemptId)}>Review recovery</button>}
        <details><summary>Technical details for group {attempt.groupId}</summary>
          <dl className="result-details">
            <dt>Attempt ID</dt><dd>{attempt.attemptId}</dd>
            <dt>Keeper ID</dt><dd>{attempt.keepAssetId ?? 'Not recorded'}</dd>
            <dt>Loser ID</dt><dd>{attempt.trashAssetId ?? 'Not recorded'}</dd>
            <dt>Last recorded stage</dt><dd>{stageLabels[attempt.lastStage] ?? attempt.lastStage}</dd>
            <dt>Proposed album IDs</dt><dd>{attempt.result?.proposedAlbumIds.join(', ') || 'None recorded'}</dd>
            <dt>Confirmed album additions</dt><dd>{attempt.confirmedAlbumIds.join(', ') || 'None confirmed'}</dd>
            <dt>Confirmed state observations</dt><dd>{attempt.confirmedEffects.loserUnlinked ? 'Duplicate association cleared' : 'Duplicate clearance not confirmed'}; {attempt.confirmedEffects.loserTrashed ? 'Trash confirmed' : 'Trash not confirmed'}; {attempt.confirmedEffects.keeperUntrashed ? 'Keeper untrashed confirmed' : 'Keeper state not confirmed'}</dd>
          </dl>
        </details>
      </article>)}
    </>}
  </section>;
}
