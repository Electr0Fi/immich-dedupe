import type { ExecutionState } from '../useExecution';

const outcomeLabels = { succeeded: 'Verified completed', 'dry-run': 'Simulated', failed: 'Failed', 'needs-verification': 'Needs verification' };
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
      <p className="run-identifier">Run: {run.runId} · Started: {run.startedAt}</p>
      <dl className="stats outcome-summary">
        {Object.entries(outcomeLabels).map(([outcome, label]) => <div key={outcome}><dt>{label}</dt><dd>{results.filter((r) => r.outcome === outcome).length}</dd></div>)}
        <div><dt>Awaiting recorded result</dt><dd>{run.attempts.filter((a) => !a.result).length}</dd></div>
        <div><dt>Excluded</dt><dd>{run.report ? excluded.length : 'Not recorded'}</dd></div>
      </dl>
      <p>Verified completed means album preservation and resolution were confirmed. Simulated means no Immich mutations were made. Failed means checks stopped the attempt before mutation; needs verification means changes may have occurred.</p>
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
