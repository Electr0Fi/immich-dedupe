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
  results: ExecutionResult[];
  stoppedEarly: boolean;
  stopReason: string | null;
};

export type ExecutionResult = {
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
