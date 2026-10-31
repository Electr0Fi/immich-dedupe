import type { ExecutionScope } from "./types";

export type ScanMode = "groups" | "candidates";
/** scanLimit remains the inspection budget; executeLimit is always separate. */
export type ScanOptions = { mode: ScanMode; candidateTarget?: number };
export type ScanStopReason = "inspection-budget" | "target-reached" | "snapshot-exhausted" | "cancelled" | "read-failure";
export type ScanClassification = "eligible" | "excluded" | "deferred" | "error";
/** Advisory proposal only. Loading this record never restores review approval. */
export type PendingScanCandidate = {
  groupId: string;
  keepAssetId: string;
  trashAssetId: string;
  keepFileName: string;
  trashFileName: string;
  keepPath: string | null;
  trashPath: string | null;
  comparisonClass: string | null;
  reason: string;
  rulesetRevision: string;
  observedAt: string;
};
export type ScanSummary = {
  rulesetRevision: string;
  totalGroups: number;
  visitedGroups: number;
  remainingGroups: number;
  excludedGroups: number;
  deferredGroups: number;
  blockedGroups: number;
  pendingCandidates: number;
  updatedAt: string;
};
export type ScanSnapshot = {
  scope: ExecutionScope;
  summary: ScanSummary;
  pending: PendingScanCandidate[];
  preparation?: {
    mode: ScanMode;
    checkedThisRequest: number;
    foundThisRequest: number;
    stopReason: ScanStopReason;
  };
};
export type ScanPreparationSummary = ScanSummary & {
  mode: ScanMode;
  checkedThisRequest: number;
  foundThisRequest: number;
  stopReason: ScanStopReason;
};
