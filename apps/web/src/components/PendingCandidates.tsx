import { useState } from 'react';
import type { ExecutionState } from '../useExecution';

export function PendingCandidates({ execution }: { execution: ExecutionState }) {
  const [selected, setSelected] = useState<string[]>([]);
  const ids = selected.filter((id) => execution.pendingCandidates.some((candidate) => candidate.groupId === id));
  const disabled = execution.busy || execution.preparing || execution.selectingAll || execution.loadingDetails || execution.scanLoading;
  return <section className="card" aria-labelledby="pending-title">
    <h2 id="pending-title">Pending candidates</h2>
    <p>Unresolved candidates remain here across scans and API restarts. These are proposals, not approved execution plans. Load a fresh review and complete a dry-run before execution.</p>
    {execution.scanSummary && <p>{execution.scanSummary.visitedGroups} groups checked · {execution.scanSummary.remainingGroups} waiting to be checked · {execution.scanSummary.excludedGroups} excluded · {execution.scanSummary.deferredGroups} deferred · {execution.scanSummary.pendingCandidates} pending candidates.</p>}
    {execution.scanError && <p className="error" role="alert">{execution.scanError}</p>}
    <div className="buttonRow"><button disabled={disabled} onClick={execution.refreshPending}>Refresh pending list</button>
      <button disabled={disabled || execution.pendingCandidates.length === 0} onClick={() => setSelected(execution.pendingCandidates.slice(0, execution.limits.executeLimit).map((candidate) => candidate.groupId))}>Select first {execution.limits.executeLimit} pending</button>
      <button disabled={disabled || ids.length === 0 || ids.length > execution.limits.executeLimit} onClick={() => execution.loadPendingCandidates(ids)}>Prepare selected pending candidates</button>
      <button disabled={disabled} onClick={() => execution.updateScan('recheck')}>Recheck excluded groups</button>
      <button disabled={disabled} onClick={() => execution.updateScan('reset')}>Reset scan progress</button>
    </div>
    <p className="field-hint">Rechecking makes excluded and deferred groups available for another scan. Reset clears advisory scan progress and pending proposals; execution history and recovery quarantines remain protected.</p>
    {execution.pendingCandidates.length === 0 && <p>No pending candidates loaded.</p>}
    {execution.pendingCandidates.map((candidate) => <article className="pending-candidate" key={candidate.groupId}>
      <label className="review-selection"><input type="checkbox" aria-label={`Review pending group ${candidate.groupId}`} disabled={disabled || (!ids.includes(candidate.groupId) && ids.length >= execution.limits.executeLimit)} checked={ids.includes(candidate.groupId)}
        onChange={(event) => setSelected(event.target.checked ? [...ids, candidate.groupId] : ids.filter((id) => id !== candidate.groupId))} />Group {candidate.groupId}: {candidate.keepFileName}</label>
      <details><summary>Candidate evidence and paths</summary><p>{candidate.comparisonClass === 'checksum' ? 'Checksum match' : candidate.comparisonClass === 'metadata' ? 'Metadata match — not verified content equality' : 'Comparison requires fresh verification'}</p><p>Proposed keeper: {candidate.keepPath ?? candidate.keepFileName}</p><p>Proposed loser: {candidate.trashPath ?? candidate.trashFileName}</p><p>{candidate.reason}</p><p className="run-identifier">Observed: {new Date(candidate.observedAt).toLocaleString()} · Rules: {candidate.rulesetRevision}</p></details>
    </article>)}
  </section>;
}
