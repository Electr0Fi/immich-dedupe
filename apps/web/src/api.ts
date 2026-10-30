import { consumeReviewPreparation } from './reviewPreparationStream';
import type { ReviewPreparationProgress, ReviewPreparationResult, RunViewResponse, ReviewedPlanResponse } from '@immich-dedupe/shared';
export type { RunView, RunViewResponse, ReviewedPlan, ReviewedAsset, ReviewedCandidate } from '@immich-dedupe/shared';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

export class ApiError extends Error {
  status: number;
  partialExecution?: ExecutionRunResponse;
  code?: string;
  runId?: string;
  constructor(status: number, message: string, partialExecution?: ExecutionRunResponse, code?: string, runId?: string) {
    super(`HTTP ${status}: ${message}`);
    this.name = 'ApiError';
    this.status = status;
    this.partialExecution = partialExecution;
    this.code = code;
    this.runId = runId;
  }
}

async function readResponse<T>(response: Response): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const partial = data?.partialExecution;
    throw new ApiError(response.status, (typeof data?.error === 'string' ? data.error : response.statusText) + (Array.isArray(data?.changedGroups) ? data.changedGroups.map((g: { groupId: string; reasons: string[] }) => ` Group ${g.groupId}: ${Array.isArray(g.reasons) ? g.reasons.join('; ') : 'changed'}`).join('') : ''),
      partial && Array.isArray(partial.results) && typeof partial.runId === 'string' ? partial : undefined,
      typeof data?.code === 'string' ? data.code : undefined, typeof data?.runId === 'string' ? data.runId : undefined);
  }
  if (data === null) throw new Error('The API returned an invalid JSON response');
  return data;
}

async function apiGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    throw new Error('Cannot reach the Dedupe API. Check that the API is running and accessible from this browser, then try again');
  }
  return readResponse<T>(response);
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return readResponse<T>(await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }));
}

export type ExecutionStatusResponse = {
  ok: boolean;
  scanLimit: number;
  duplicateCount: number;
  scannedDuplicateCount: number;
  executableCount: number;
  logCount: number;
  lastExecutionEntry: ExecutionLogEntry | null;
};

export type ExecutionOutcome = 'dry-run' | 'succeeded' | 'failed' | 'needs-verification';
export type ExecutionFailureStage = 'preflight' | 'album-transfer' | 'album-verification' | 'resolution' | 'verification';

export type ExecutionLogEntry = {
  runId?: string;
  attemptId?: string;
  outcome?: ExecutionOutcome;
  failureStage?: ExecutionFailureStage | null;
  proposedAlbumIds?: string[];
  transferredAlbumIds?: string[];
  skippedAlbumIds?: string[];
  timestamp: string;
  groupId: string;
  mode: "dry-run" | "execute";
  keepAssetId: string | null;
  trashAssetId: string | null;
  executed: boolean;
  resolvedDuplicate: boolean;
  trashedAsset: boolean;
  message: string;
};

export type DuplicateDecisionStatus = "auto-resolve" | "uncertain" | "skip";

export type DuplicateDecision = {
  groupId: string;
  status: DuplicateDecisionStatus;
  keepAssetId: string | null;
  trashAssetIds: string[];
  confidence: number;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  reasons: string[];
};

export type DuplicateAnalysisResponse = {
  ok: boolean;
  results: DuplicateDecision[];
  totalGroups: number;
  autoResolveCount: number;
  uncertainCount: number;
  skipCount: number;
};

export type ExecutionRunResponse = {
  runId?: string;
  planId?: string;
  selectedCount?: number;
  excludedGroups?: Array<{ groupId: string; reason: 'processed' | 'legacy' | 'quarantined'; attemptIds: string[] }>;
  stoppedEarly: boolean;
  stopReason: string | null;
  ok: boolean;
  dryRun: boolean;
  scanLimit: number;
  executeLimit: number;
  fetchedGroups: number;
  eligibleCount: number;
  actuallyExecutedCount: number;
  resolvedCount: number;
  trashedCount: number;
  results: ExecutionResult[];
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

export type ExecutionPlanResponse = {
  ok: boolean;
  scanLimit: number;
  fetchedGroups: number;
  executableCount: number;
  items: ExecutionPlanItem[];
};

export type ExecutionResult = {
  runId?: string;
  attemptId?: string;
  outcome: ExecutionOutcome;
  failureStage: ExecutionFailureStage | null;
  proposedAlbumIds: string[];
  groupId: string;
  mode: "dry-run" | "execute";
  executed: boolean;
  keepAssetId: string | null;
  trashAssetId: string | null;
  transferredAlbumIds: string[];
  skippedAlbumIds: string[];
  resolvedDuplicate: boolean;
  trashedAsset: boolean;
  message: string;
};

export type ExecutionLogResponse = {
  ok: boolean;
  path: string;
  count: number;
  data: ExecutionLogEntry[];
};

export type ClearExecutionLogResponse = {
  ok: boolean;
  path: string;
  clearedCount: number;
};

export function getExecutionStatus(scanLimit: number) {
  return apiGet<ExecutionStatusResponse>(
    `/execution/status?scanLimit=${scanLimit}`
  );
}

export function getLatestRun() { return apiGet<RunViewResponse>('/execution/runs/latest'); }
export function getRun(runId: string) { return apiGet<RunViewResponse>(`/execution/runs/${encodeURIComponent(runId)}`); }

export function getExecutionPlan(scanLimit: number) {
  return apiGet<ExecutionPlanResponse>(
    `/execution/plan?scanLimit=${scanLimit}`
  );
}

export function getDuplicateAnalysis(scanLimit: number) {
  return apiGet<DuplicateAnalysisResponse>(
    `/analysis/duplicates?limit=${scanLimit}`
  );
}

export function runExecution(params: {
  scanLimit: number;
  executeLimit: number;
  dryRun: boolean;
}) {
  return apiPost<ExecutionRunResponse>("/execution/run", params);
}

export function getExecutionLog() {
  return apiGet<ExecutionLogResponse>("/execution/log");
}

export function clearExecutionLog() {
  return apiPost<ClearExecutionLogResponse>("/execution/log/clear", {});
}

export function getExecutionLogExportUrl(format: "json" | "csv") {
  return `${API_BASE_URL}/execution/log/export.${format}`;
}

export type ConnectionConfigResponse = {
  ok: boolean;
  immichUrl: string;
  apiKey: string;
};

export type TestConnectionResponse = {
  ok: boolean;
  version?: string;
  error?: string;
};

export function getConnectionConfig() {
  return apiGet<ConnectionConfigResponse>("/settings/connection");
}

export function testConnection(params: { immichUrl: string; apiKey: string }) {
  return apiPost<TestConnectionResponse>("/settings/test-connection", params);
}

export function saveConnectionConfig(params: { immichUrl: string; apiKey: string }) {
  return apiPost<{ ok: boolean; error?: string }>("/settings/connection", params);
}

export type ServerConnectionStatus = 'connected' | 'disconnected' | 'error' | 'checking';

export type ServerStatusResponse = {
  ok: boolean;
  status: Exclude<ServerConnectionStatus, 'checking'>;
  immichUrl: string;
};

export function getServerStatus() {
  return apiGet<ServerStatusResponse>("/settings/status");
}

export type RecoveryAttempt = {
  attemptId: string;
  runId: string;
  groupId: string;
  mode: 'dry-run' | 'execute';
  keepAssetId: string | null;
  trashAssetId: string | null;
  startedAt: string;
  checkpoints: Array<{ timestamp: string; event: { kind: string; confirmedAlbumIds?: string[] } }>;
  result: ExecutionResult | null;
  assessments: Array<{ checkedAt: string; classification: 'verified-resolved' | 'pair-intact' | 'inconclusive'; message: string; evidence: string[] }>;
  releasedAt: string | null;
};
export type RecoveryList = {
  ok: boolean;
  health: 'ready' | 'unavailable';
  error: string | null;
  activeRunId: string | null;
  scope: { apiUrl: string; accountId: string } | null;
  items: RecoveryAttempt[];
  total: number;
  offset: number;
  limit: number;
};
export function getRecovery(offset = 0, limit = 25) {
  return apiGet<RecoveryList>(`/execution/recovery?offset=${offset}&limit=${limit}`);
}
export function getRecoveryAttempt(attemptId: string) {
  return apiGet<{ ok: boolean; attempt: RecoveryAttempt }>(`/execution/recovery/${encodeURIComponent(attemptId)}`);
}
export function recheckAttempt(attemptId: string) {
  return apiPost<{ ok: boolean; attempt: RecoveryAttempt }>(`/execution/recovery/${encodeURIComponent(attemptId)}/recheck`, {});
}
export function releaseAttempt(attemptId: string) {
  return apiPost<{ ok: boolean; attempt: RecoveryAttempt }>(`/execution/recovery/${encodeURIComponent(attemptId)}/release`, { confirm: true });
}

export async function prepareReviewedPlan(scanLimit: number, executeLimit: number, onProgress: (progress: ReviewPreparationProgress) => void): Promise<ReviewPreparationResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/execution/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ scanLimit, executeLimit }),
    });
  } catch { throw new Error('Cannot reach the Dedupe API. Check that the API is running and accessible from this browser, then try again'); }
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    const value = await readResponse<ReviewedPlanResponse>(response);
    return { status: 'completed', plan: value.plan };
  }
  if (!response.body) throw new Error('Review preparation response was incomplete');
  const terminal = await consumeReviewPreparation(response.body, onProgress);
  if (terminal.type === 'error') throw new ApiError(terminal.status, terminal.error, undefined, terminal.code);
  return terminal.result;
}
export function cancelReviewedPreparation(preparationId: string) {
  return apiPost<{ ok: true; status: 'finished' | 'cancelling' }>(`/execution/preparations/${encodeURIComponent(preparationId)}/cancel`, {});
}
export function runReviewedPlan(planId: string, selectedGroupIds: string[], dryRun: boolean) {
  return apiPost<ExecutionRunResponse>(`/execution/plans/${encodeURIComponent(planId)}/run`, { selectedGroupIds, dryRun });
}
export function getReviewedThumbnailUrl(planId: string, assetId: string) {
  return `${API_BASE_URL}/execution/plans/${encodeURIComponent(planId)}/assets/${encodeURIComponent(assetId)}/thumbnail`;
}
