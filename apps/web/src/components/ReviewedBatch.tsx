import { useState } from 'react';
import { getReviewedThumbnailUrl, type ReviewedAsset } from '../api';
import type { ExecutionState } from '../useExecution';

function AssetComparison({ asset, planId, keeper }: { asset: ReviewedAsset; planId: string; keeper: boolean }) {
  const [failed, setFailed] = useState(false);
  return <section className="review-asset" aria-label={`${keeper ? 'Keep' : 'Move to trash'}: ${asset.fileName}`}>
    <h4>{keeper ? 'Keep' : 'Move to trash'}</h4>
    {failed ? <div className="thumbnail-placeholder" role="img" aria-label={`Thumbnail unavailable for ${asset.fileName}`}>Thumbnail unavailable. Check asset.view permission and image availability in Immich, then prepare a new review. See Settings for required API key permissions.</div>
      : <img className="review-thumbnail" loading="lazy" src={getReviewedThumbnailUrl(planId, asset.id)} alt={`${keeper ? 'Keeper' : 'Loser'} preview: ${asset.fileName}`} onError={() => setFailed(true)} />}
    <p><strong>{asset.fileName}</strong></p>
    <dl className="asset-facts">
      <div><dt>Source</dt><dd>{asset.isExternal ? 'External library' : 'Internal library'}</dd></div>
      <div><dt>File size</dt><dd>{asset.fileSize == null ? 'Unknown' : `${new Intl.NumberFormat().format(asset.fileSize)} bytes`}</dd></div>
      <div><dt>Dimensions</dt><dd>{asset.width} × {asset.height}</dd></div>
      <div><dt>Albums</dt><dd>{asset.albums.map((a) => a.albumName).join(', ') || 'None visible'}</dd></div>
    </dl>
    <details><summary>Asset ID and path</summary><p className="run-identifier">{asset.id}</p><p className="run-identifier">{asset.originalPath}</p></details>
  </section>;
}
export function ReviewedBatch({ execution }: { execution: ExecutionState }) {
  const { review, selected } = execution;
  const disabled = execution.busy || execution.preparing || !execution.validReview;
  const selectedCandidates = review?.candidates.filter((c) => selected.includes(c.groupId)) ?? [];
  return <section className="card" aria-labelledby="review-title">
    <h2 id="review-title">Review exactly what will run</h2>
    <p>Review the fixed keeper, loser and proposed album changes. Only included groups will be attempted, in review order. No replacement groups are selected automatically.</p>
    {execution.reviewError && <p className="error" role="alert">{execution.reviewError}</p>}
    {!review ? <p>Choose limits and prepare a review. A review lasts 15 minutes and is retained across screen navigation. Reloading the page or restarting the API requires a new review.</p> : <>
      <p>{selected.length} groups selected · {selectedCandidates.reduce((n, c) => n + c.proposedAlbumIds.length, 0)} proposed album additions · {review.excludedGroups.length} excluded groups</p>
      <p>Scanned {review.fetchedGroups} of {review.totalGroups} groups. Review expires at {new Date(review.expiresAt).toLocaleTimeString()}.</p>
      <p className="run-identifier">Plan: {review.planId}</p>
      {execution.expired && !execution.busy && <p className="error" role="alert">This review expired. Prepare a new review and dry-run the selection.</p>}
      {execution.invalid && !execution.expired && !execution.busy && <p className="error" role="alert">This review is no longer available for execution. Prepare a new review before retrying.</p>}
      {execution.canExecute ? <p role="status">Dry-run passed for this exact selection. Ready for explicit live execution.</p> : execution.validReview && <p>Complete a successful dry-run of the exact selection before live execution. Changing selection clears that approval.</p>}
      <div className="buttonRow">
        <button disabled={disabled} onClick={() => execution.selectGroups(review.candidates.slice(0, review.executeLimit).map((c) => c.groupId))}>Select first {review.executeLimit}</button>
        <button disabled={disabled} onClick={() => execution.selectGroups([])}>Clear selection</button>
      </div>
      {review.candidates.length === 0 && <p>No eligible groups among the checked groups.</p>}
      {review.candidates.map((candidate) => <article key={`${review.planId}-${candidate.groupId}`} className="review-candidate">
        <label className="review-selection"><input type="checkbox" aria-label={`Include group ${candidate.groupId}`}
          checked={selected.includes(candidate.groupId)} disabled={disabled || (!selected.includes(candidate.groupId) && selected.length >= review.executeLimit)}
          onChange={(event) => execution.selectGroups(event.target.checked ? [...selected, candidate.groupId] : selected.filter((id) => id !== candidate.groupId))} />
          Include group {candidate.groupId}
        </label>
        <div className="review-pair">
          <AssetComparison asset={candidate.keepAsset} planId={review.planId} keeper />
          <AssetComparison asset={candidate.trashAsset} planId={review.planId} keeper={false} />
        </div>
        <p><strong>Rule:</strong> {candidate.decision.matchedRuleName}</p>
        <ul>{candidate.decision.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        <p><strong>Proposed additions to keeper:</strong> {candidate.trashAsset.albums.filter((a) => candidate.proposedAlbumIds.includes(a.albumId)).map((a) => a.albumName).join(', ') || 'None'}</p>
        <p><strong>Already preserved on keeper:</strong> {candidate.trashAsset.albums.filter((a) => candidate.skippedAlbumIds.includes(a.albumId)).map((a) => a.albumName).join(', ') || 'None'}</p>
        <p className="field-hint">Album actions are proposals until execution confirms them. Safety checks run again before any changes.</p>
      </article>)}
      {review.excludedGroups.length > 0 && <details><summary>Excluded and read-only groups ({review.excludedGroups.length})</summary><ul>{review.excludedGroups.map((g) => <li key={g.groupId}>Group {g.groupId}: {g.reason} — {g.message}</li>)}</ul></details>}
    </>}
  </section>;
}
