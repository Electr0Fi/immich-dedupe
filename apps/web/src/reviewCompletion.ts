import type { ExecutionResult, ReviewedPlan } from '@immich-dedupe/shared';

/** Only verified live results for the exact requested keeper/loser may disappear. */
export function successfulReviewGroupIds(review: ReviewedPlan, selected: string[], results: ExecutionResult[]): string[] {
  return [...new Set(results.filter((result) => {
    const candidate = review.candidates.find((entry) => entry.groupId === result.groupId);
    return selected.includes(result.groupId) && candidate && result.mode === 'execute' && result.outcome === 'succeeded'
      && result.executed === true && result.resolvedDuplicate === true && result.trashedAsset === true
      && result.keepAssetId === candidate.keepAsset.id && result.trashAssetId === candidate.trashAsset.id;
  }).map((result) => result.groupId))];
}
