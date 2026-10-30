export type AlbumMembership = {
  albumId: string;
  albumName: string;
};

export type AssetRecord = {
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
export type ExecutionExclusion = { groupId: string; reason: "processed" | "legacy" | "quarantined"; attemptIds: string[] };
export type RunContext = { dryRun: boolean; scanLimit: number; executeLimit: number; source: "batch" | "single"; groupId: string | null };
export type RunReport = {
  fetchedGroups: number; eligibleCount: number; excludedGroups: ExecutionExclusion[];
  stoppedEarly: boolean; stopReason: string | null;
  requestError: { status: number; code: string; message: string } | null;
};
/** Compact read model; checkpoints remain available through recovery detail. */
export type RunView = {
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
