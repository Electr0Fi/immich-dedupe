import { useState } from 'react';
import type { ExecutionState } from '../useExecution';
import { ReviewGroup } from './ReviewedBatch';

export function QuickReviewBatch({ execution }: { execution: ExecutionState }) {
  const snapshot = execution.quickSnapshot;
  const [expansion, setExpansion] = useState<{ reviewId: string; ids: string[] } | null>(null);
  if (!snapshot) return null;
  const ids = expansion?.reviewId === snapshot.reviewId ? expansion.ids : [];
  const toggle = (groupId: string) => setExpansion({ reviewId: snapshot.reviewId, ids: ids.includes(groupId) ? ids.filter((id) => id !== groupId) : [...ids, groupId] });
  const disabled = execution.preparing || execution.loadingDetails || execution.busy || !execution.validQuickReview;
  return <section className="card" aria-labelledby="quick-review-title">
    <h2 id="quick-review-title">Quick Review — provisional results</h2>
    <p>Rules were evaluated from the duplicate response only. Image details, thumbnails and albums were not fetched separately. Load selected details before dry-run or execution.</p>
    <p>{execution.selected.length} groups selected · {snapshot.candidates.length} provisional candidates · {snapshot.excludedGroups.length} excluded or unverified groups</p>
    <p>Checked {snapshot.fetchedGroups} of {snapshot.totalGroups} groups. Quick Review expires at {new Date(snapshot.expiresAt).toLocaleTimeString()}.</p>
    {snapshot.ruleset && <p className="run-identifier">Rules revision: {snapshot.ruleset.revision}</p>}
    {execution.reviewError && <p className="error" role="alert">{execution.reviewError}</p>}
    {(execution.expired || execution.invalid) && <p className="error" role="alert">This Quick Review expired or is unavailable. Prepare a new review.</p>}
    {execution.selectionMessage && <p role="status">{execution.selectionMessage}</p>}
    <div className="buttonRow">
      <button disabled={disabled} onClick={() => execution.selectGroups(snapshot.candidates.slice(0, execution.limits.executeLimit).map((candidate) => candidate.groupId))}>Select first {execution.limits.executeLimit}</button>
      <button disabled={disabled || snapshot.candidates.length === 0} onClick={execution.selectAll}>Select All</button>
      <button disabled={disabled} onClick={() => execution.selectGroups([])}>Clear selection</button>
      <button disabled={snapshot.fetchedGroups === 0} onClick={() => setExpansion({ reviewId: snapshot.reviewId, ids: [...snapshot.candidates, ...snapshot.excludedGroups].map((group) => group.groupId) })}>Expand All</button>
      <button disabled={snapshot.fetchedGroups === 0} onClick={() => setExpansion({ reviewId: snapshot.reviewId, ids: [] })}>Collapse All</button>
      <button disabled={disabled || execution.selected.length === 0} onClick={execution.loadSelectedDetails}>{execution.loadingDetails ? 'Loading selected details…' : 'Load selected details'}</button>
    </div>
    <h3>Provisional candidates ({snapshot.candidates.length})</h3>
    {snapshot.candidates.length === 0 && <p>No groups could be verified as candidates from the available duplicate-list data.</p>}
    {snapshot.candidates.map((candidate) => <ReviewGroup key={`${snapshot.reviewId}-${candidate.groupId}`} groupId={candidate.groupId}
      title={candidate.keepAsset.fileName} expanded={ids.includes(candidate.groupId)} onToggle={() => toggle(candidate.groupId)}
      selection={<label className="review-selection"><input type="checkbox" aria-label={`Include group ${candidate.groupId}`} checked={execution.selected.includes(candidate.groupId)}
        disabled={disabled || (!execution.selected.includes(candidate.groupId) && execution.selected.length >= execution.limits.executeLimit)}
        onChange={(event) => execution.selectGroups(event.target.checked ? [...execution.selected, candidate.groupId] : execution.selected.filter((id) => id !== candidate.groupId))} />Include group {candidate.groupId}</label>}>
      <p>Provisional keeper: {candidate.keepAsset.fileName} · {candidate.keepAsset.originalPath ?? 'Unknown path'}</p>
      <p>Provisional loser: {candidate.trashAsset.fileName} · {candidate.trashAsset.originalPath ?? 'Unknown path'}</p>
      {'evidenceClass' in candidate.decision && <p>Comparison: {candidate.decision.evidenceClass === 'checksum' ? 'Checksum match' : 'Metadata match — this does not prove identical content'}</p>}
      <p>Rule: {candidate.decision.matchedRuleName}</p>
      <ul>{candidate.decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
      <p>Album memberships and proposed transfers have not been checked.</p>
    </ReviewGroup>)}
    <h3>Excluded and unverified groups ({snapshot.excludedGroups.length})</h3>
    {snapshot.excludedGroups.map((group) => <ReviewGroup key={`${snapshot.reviewId}-${group.groupId}`} groupId={group.groupId}
      title={`Group ${group.groupId}: ${group.reason}`} expanded={ids.includes(group.groupId)} onToggle={() => toggle(group.groupId)}><p>{group.message}</p></ReviewGroup>)}
  </section>;
}
