export type AlbumMembership = {
  albumId: string;
  albumName: string;
};

export type AssetRecord = {
  ruleMetadata?: import("./rules").RuleMetadata;
  albumsKnown?: boolean;
  id: string;
  duplicateId: string;
  fileName: string;
  originalPath: string | null;
  originalMimeType: string | null;
  fileCreatedAt: string | null;
  fileModifiedAt: string | null;
  takenAt: string | null;
  width: number | null;
  height: number | null;
  checksum: string | null;
  deviceId: string | null;
  deviceAssetId: string | null;
  libraryId: string | null;
  assetType: string | null;
  isEdited: boolean | null;
  isTrashed: boolean | null;
  isFavorite: boolean | null;
  isArchived: boolean | null;
  isOffline: boolean | null;
  livePhotoVideoId: string | null;
  isExternal: boolean;
  isInternal: boolean;
  fileSize: number | null;
  albums: AlbumMembership[];
};

export type DuplicateGroup = {
  groupId: string;
  assets: AssetRecord[];
};

export type NormalizedDuplicatesResponse = {
  groups: DuplicateGroup[];
  totalGroups: number;
  totalAssets: number;
};

export type RuleDecisionStatus = "auto-resolve" | "uncertain" | "skip";

export type RuleMatch = {
  ruleId: string;
  ruleName: string;
  matched: boolean;
  reason: string[];
};

export type DuplicateDecision = {
  groupId: string;
  status: RuleDecisionStatus;
  keepAssetId: string | null;
  trashAssetIds: string[];
  confidence: number;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  reasons: string[];
};

export type DuplicateAnalysisResponse = {
  results: DuplicateDecision[];
  totalGroups: number;
  autoResolveCount: number;
  uncertainCount: number;
  skipCount: number;
};

export type ExecutionPlanItem = {
  groupId: string;
  keepAssetId: string;
  trashAssetId: string;
  confidence: number;
  ruleName: string | null;
  reasons: string[];
  albumTransferCount: number;
};

export type ExecutionPlan = {
  createdAt: string;
  total: number;
  items: ExecutionPlanItem[];
};

export type ExecutionMode = "dry-run" | "execute";

export type ExecutionOutcome = "dry-run" | "succeeded" | "failed" | "needs-verification";
export type ExecutionFailureStage = "preflight" | "album-transfer" | "album-verification" | "resolution" | "verification";

export type ExecutionBatchResult = {
  runId?: string;
  excludedGroups?: ExecutionExclusion[];
  results: ExecutionResult[];
  stoppedEarly: boolean;
  stopReason: string | null;
};

export type ExecutionResult = {
  runId?: string;
  attemptId?: string;
  outcome: ExecutionOutcome;
  failureStage: ExecutionFailureStage | null;
  proposedAlbumIds: string[];
  groupId: string;
  mode: ExecutionMode;

  executed: boolean;

  keepAssetId: string | null;
  trashAssetId: string | null;

  transferredAlbumIds: string[];
  skippedAlbumIds: string[];

  resolvedDuplicate: boolean;
  trashedAsset: boolean;

  message: string;
};

export type ExecutionCheckpoint =
  | { kind: "preflight"; snapshot: AssetRecord[]; requiredAlbumIds: string[]; proposedAlbumIds: string[]; skippedAlbumIds: string[] }
  | { kind: "album-intent"; albumIds: string[] }
  | { kind: "album-response"; accepted: boolean; error: string | null }
  | { kind: "album-observed"; confirmedAlbumIds: string[] }
  | { kind: "resolution-intent" }
  | { kind: "resolution-response"; accepted: boolean; items: Array<{ id: string; success: boolean }>; error: string | null }
  | { kind: "verification"; loserTrashed: boolean; loserUnlinked: boolean; keeperUntrashed: boolean };

export type RecoveryAssessment = {
  checkedAt: string;
  classification: "verified-resolved" | "pair-intact" | "inconclusive";
  message: string;
  evidence: string[];
};
export type RecoveryAttempt = {
  attemptId: string;
  runId: string;
  groupId: string;
  mode: ExecutionMode;
  keepAssetId: string | null;
  trashAssetId: string | null;
  startedAt: string;
  checkpoints: Array<{ timestamp: string; event: ExecutionCheckpoint }>;
  result: ExecutionResult | null;
  assessments: RecoveryAssessment[];
  releasedAt: string | null;
};
export type ExecutionScope = { apiUrl: string; accountId: string };
export type ReviewedAsset = Pick<AssetRecord, "id" | "duplicateId" | "fileName" | "originalPath" | "checksum" | "assetType" | "width" | "height" | "fileSize" | "isEdited" | "isTrashed" | "isFavorite" | "isArchived" | "isOffline" | "livePhotoVideoId" | "isExternal" | "isInternal" | "albums">;
export type ReviewedCandidate = {
  ruleset?: import("./rules").RuleSet;
  ruleAssets?: AssetRecord[];
  groupId: string; keepAsset: ReviewedAsset; trashAsset: ReviewedAsset; decision: DuplicateDecision;
  requiredAlbumIds: string[]; proposedAlbumIds: string[]; skippedAlbumIds: string[];
};
export type ReviewedPlanExclusion = { groupId: string; reason: "processed" | "legacy" | "quarantined" | "ineligible" | "unverified"; message: string; attemptIds: string[] };
export type ReviewedPlan = {
  ruleset?: import("./rules").RuleSet;
  scan?: import("./scanning").ScanSnapshot;
  planId: string; scope: ExecutionScope; createdAt: string; expiresAt: string;
  scanLimit: number; executeLimit: number; fetchedGroups: number; totalGroups: number;
  candidates: ReviewedCandidate[]; excludedGroups: ReviewedPlanExclusion[];
  preparation?: { status: "completed" | "cancelled"; checkedGroups: number; targetGroups: number };
};
/** Provisional duplicate-list data; album memberships have not been fetched. */
export type QuickReviewCandidate = Omit<ReviewedCandidate, "keepAsset" | "trashAsset" | "requiredAlbumIds" | "proposedAlbumIds" | "skippedAlbumIds"> & {
  keepAsset: Omit<ReviewedAsset, "albums">; trashAsset: Omit<ReviewedAsset, "albums">;
};
export type QuickReviewExclusion = Omit<ReviewedPlanExclusion, "reason"> & { reason: ReviewedPlanExclusion["reason"] | "unverified" };
export type QuickReview = {
  ruleset?: import("./rules").RuleSet;
  scan?: import("./scanning").ScanSnapshot;
  reviewId: string; scope: ExecutionScope; createdAt: string; expiresAt: string;
  scanLimit: number; executeLimit: number; fetchedGroups: number; totalGroups: number;
  candidates: QuickReviewCandidate[]; excludedGroups: QuickReviewExclusion[];
  preparation: { status: "completed" | "cancelled"; checkedGroups: number; targetGroups: number };
};
export type QuickReviewResponse = { ok: true; quickReview: QuickReview | null };
export type PrepareQuickSelectionRequest = { selectedGroupIds: string[]; executeLimit: number };
export type ReviewPreparationStage = "checking-history" | "checking-identity" | "fetching-groups" | "checking-membership" | "checking-assets" | "checking-albums" | "evaluating-rules" | "finalizing";
export type ReviewPreparationProgress = {
  preparationId: string; stage: ReviewPreparationStage;
  checkedGroups: number; targetGroups: number | null; eligibleGroups: number; excludedGroups: number;
};
export type ReviewPreparationResult = { status: "completed" | "cancelled"; plan: ReviewedPlan | null; quickReview?: QuickReview | null };
export type ReviewPreparationEvent =
  | { type: "progress"; progress: ReviewPreparationProgress }
  | { type: "result"; result: ReviewPreparationResult }
  | { type: "error"; status: number; code: string; error: string };
export type CreateReviewedPlanRequest = { scanLimit?: number; executeLimit?: number; scan?: { mode: "groups" | "candidates"; candidateTarget?: number } };
export type ReviewedExecutionRequest = { selectedGroupIds: string[]; dryRun?: boolean };
export type ReviewedPlanResponse = { ok: true; plan: ReviewedPlan };
export type ChangedPlanGroup = { groupId: string; reasons: string[] };
export type ReviewedPlanChangedResponse = { ok: false; code: "plan_changed"; error: string; planId: string; changedGroups: ChangedPlanGroup[]; runId?: string };
export type ReviewedRunEvidence = {
  planId: string; createdAt: string; expiresAt: string; selectedGroupIds: string[];
  candidates: ReviewedCandidate[]; authorizingDryRunId: string | null;
};
export type ExecutionExclusion = { groupId: string; reason: "processed" | "legacy" | "quarantined"; attemptIds: string[] };
export type RunContext = { dryRun: boolean; scanLimit: number; executeLimit: number; source: "batch" | "single"; groupId: string | null };
export type RunReport = {
  fetchedGroups: number; eligibleCount: number; excludedGroups: ExecutionExclusion[];
  stoppedEarly: boolean; stopReason: string | null;
  requestError: { status: number; code: string; message: string } | null;
};
/** Compact read model; checkpoints remain available through recovery detail. */
export type RunView = {
  planId?: string; selectedCount?: number; authorizingDryRunId?: string | null;
  runId: string; startedAt: string; finishedAt: string | null;
  phase: "running" | "finished" | "interrupted";
  context: RunContext | null; report: RunReport | null;
  attempts: Array<{
    attemptId: string; groupId: string; mode: ExecutionMode; keepAssetId: string | null; trashAssetId: string | null;
    result: ExecutionResult | null; lastStage: string; confirmedAlbumIds: string[];
    confirmedEffects: { loserTrashed: boolean; loserUnlinked: boolean; keeperUntrashed: boolean };
    recovery: "quarantined" | "released" | "verified-resolved" | "closed";
    assessment: RecoveryAssessment | null;
  }>;
};
export type RunViewResponse = { ok: boolean; scope: ExecutionScope; run: RunView | null };
export type RecoveryList = {
  ok: boolean;
  health: "ready" | "unavailable";
  error: string | null;
  activeRunId: string | null;
  scope: ExecutionScope | null;
  items: RecoveryAttempt[];
  total: number;
  offset: number;
  limit: number;
};
export * from "./rules";
export * from "./scanning";
