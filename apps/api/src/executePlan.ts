import type { DuplicateDecision } from "@immich-dedupe/shared";

export function isExecutableDecision(decision: DuplicateDecision): boolean {
  return decision.status === "auto-resolve" && decision.confidence === 100 &&
    Boolean(decision.keepAssetId) && decision.trashAssetIds.length === 1;
}
