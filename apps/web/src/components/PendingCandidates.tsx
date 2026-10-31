import { useState } from 'react';
import type { ExecutionState } from '../useExecution';
import { ReviewGroup } from './ReviewedBatch';

export function PendingCandidates({ execution }: { execution: ExecutionState }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
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
    {execution.pendingCandidates.map((candidate) => <ReviewGroup key={candidate.groupId} groupId={candidate.groupId} title={candidate.keepFileName}
      expanded={expanded.includes(candidate.groupId)} onToggle={() => setExpanded(expanded.includes(candidate.groupId) ? expanded.filter((id) => id !== candidate.groupId) : [...expanded, candidate.groupId])}
      selection={<label className="review-selection"><input type="checkbox" aria-label={`Review pending group ${candidate.groupId}`} disabled={disabled || (!ids.includes(candidate.groupId) && ids.length >= execution.limits.executeLimit)} checked={ids.includes(candidate.groupId)}
        onChange={(event) => setSelected(event.target.checked ? [...ids, candidate.groupId] : ids.filter((id) => id !== candidate.groupId))} />Include group {candidate.groupId}</label>}>
      <p>Provisional <span className="provisional-keeper-label">keeper</span>: {candidate.keepFileName} · {candidate.keepPath ?? 'Unknown path'}
        <span className="provisional-asset-facts">File size: {candidate.keepMetadata?.fileSize == null ? 'Unknown' : `${new Intl.NumberFormat().format(candidate.keepMetadata.fileSize)} bytes`} · Dimensions: {candidate.keepMetadata?.width ?? 'Unknown'} × {candidate.keepMetadata?.height ?? 'Unknown'}</span>
      </p>
      <p>Provisional <span className="provisional-loser-label">loser</span>: {candidate.trashFileName} · {candidate.trashPath ?? 'Unknown path'}
        <span className="provisional-asset-facts">File size: {candidate.trashMetadata?.fileSize == null ? 'Unknown' : `${new Intl.NumberFormat().format(candidate.trashMetadata.fileSize)} bytes`} · Dimensions: {candidate.trashMetadata?.width ?? 'Unknown'} × {candidate.trashMetadata?.height ?? 'Unknown'}</span>
      </p>
      <p className="provisional-comparison">Comparison: {candidate.comparisonClass === 'checksum' ? 'Checksum match' : candidate.comparisonClass === 'metadata' ? 'Metadata match — this does not prove identical content' : 'Comparison requires fresh verification'}</p>
      <p>Rule: {candidate.ruleName ?? 'Unknown'}</p>
      <ul>{(candidate.reasons ?? [candidate.reason]).map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>
      <p>Load a fresh review to check current album memberships and proposed transfers.</p>
      <p className="run-identifier">Observed: {new Date(candidate.observedAt).toLocaleString()} · Rules: {candidate.rulesetRevision}</p>
    </ReviewGroup>)}
  </section>;
}
