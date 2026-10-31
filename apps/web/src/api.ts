import { ApiError, readResponse } from './apiResponse';
export { ApiError } from './apiResponse';
import { consumeQuickDetails } from './quickDetailStream';
import { consumeExecutionRun } from './executionRunStream';
import { consumeReviewPreparation, validResult } from './reviewPreparationStream';
import { upgradeResolutionDraft } from '@immich-dedupe/shared';
import type { ResolutionConflict, ScanOptions, ScanSummary, PendingScanCandidate, RulesState, RuleSetDraft, SaveRulePresetRequest, ConfiguredDecision, ReviewPreparationProgress, ReviewPreparationResult, QuickReviewResponse, RunViewResponse, ReviewedPlanResponse, ExecutionRunResponse, ExecutionRunProgress, QuickDetailProgress } from '@immich-dedupe/shared';
export type { RunView, RunViewResponse, ReviewedPlan, ReviewedAsset, ReviewedCandidate, ExecutionRunResponse } from '@immich-dedupe/shared';

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

async function apiGet<T>(path: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`);
  } catch {
    throw new Error('Cannot reach the Dedupe API. Check that the API is running and accessible from this browser, then try again');
  }
  return readResponse<T>(response, { method: 'GET', path });
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  return readResponse<T>(await fetch(`${API_BASE_URL}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }), { method: 'POST', path });
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

export type ScanRequest = ScanOptions;
export type { ScanSummary } from '@immich-dedupe/shared';
export async function prepareReviewedPlan(scanLimit: number, executeLimit: number, onProgress: (progress: ReviewPreparationProgress) => void, scan?: ScanRequest): Promise<ReviewPreparationResult> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/execution/plans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ scanLimit, executeLimit, ...(scan ? { scan } : {}) }),
    });
  } catch { throw new Error('Cannot reach the Dedupe API. Check that the API is running and accessible from this browser, then try again'); }
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    const value = await readResponse<ReviewedPlanResponse>(response, { method: 'POST', path: '/execution/plans' });
    return { status: 'completed', plan: value.plan };
  }
  if (!response.body) throw new Error('Review preparation response was incomplete');
  const terminal = await consumeReviewPreparation(response.body, onProgress);
  if (terminal.type === 'error') throw new ApiError(terminal.status, terminal.error, undefined, terminal.code);
  return terminal.result;
}
export async function prepareQuickReview(scanLimit: number, executeLimit: number, onProgress: (progress: ReviewPreparationProgress) => void, scan?: ScanRequest): Promise<ReviewPreparationResult> {
  const path = '/execution/quick-reviews';
  let response: Response;
  try { response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ scanLimit, executeLimit, ...(scan ? { scan } : {}) }) }); }
  catch { throw new Error('Cannot reach the Dedupe API. Check that the API is running and accessible from this browser, then try again'); }
  if (!response.ok || !response.headers.get('Content-Type')?.includes('application/x-ndjson')) {
    const value = await readResponse<QuickReviewResponse>(response, { method: 'POST', path });
    const result = { status: 'completed' as const, plan: null, quickReview: value.quickReview };
    if (!validResult(result)) throw new Error('Invalid Quick Review response');
    return result;
  }
  if (!response.body) throw new Error('Quick Review response was incomplete');
  const terminal = await consumeReviewPreparation(response.body, onProgress);
  if (terminal.type === 'error') throw new ApiError(terminal.status, terminal.error, undefined, terminal.code);
  if (!('quickReview' in terminal.result)) throw new Error('Invalid Quick Review response');
  return terminal.result;
}
export async function prepareQuickSelection(reviewId: string, selectedGroupIds: string[], executeLimit: number, onProgress?: (progress: QuickDetailProgress) => void) {
  const path = `/execution/quick-reviews/${encodeURIComponent(reviewId)}/prepare-plan`;
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ selectedGroupIds, executeLimit }) });
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) return readResponse<ReviewedPlanResponse>(response, { method: 'POST', path });
  if (!response.body) throw new Error('Detail-loading response was incomplete; Quick Review was preserved. No execution was requested.');
  const terminal = await consumeQuickDetails(response.body, (progress) => {
    if (progress.reviewId !== reviewId || progress.totalGroups !== selectedGroupIds.length) throw new Error('Detail-loading progress does not match the requested selection');
    onProgress?.(progress);
  });
  if (terminal.type === 'error') return readResponse<ReviewedPlanResponse>(Response.json(terminal, { status: terminal.status }), { method: 'POST', path });
  const ids = terminal.result.plan.candidates.map((candidate) => candidate.groupId);
  if (ids.length !== selectedGroupIds.length || new Set(ids).size !== ids.length || ids.some((id) => !selectedGroupIds.includes(id))) throw new Error('Detailed review does not match the requested selection');
  return terminal.result;
}
export function cancelReviewedPreparation(preparationId: string) {
  return apiPost<{ ok: true; status: 'finished' | 'cancelling' }>(`/execution/preparations/${encodeURIComponent(preparationId)}/cancel`, {});
}
export function selectAllReviewedPlan(planId: string) {
  return apiPost<ReviewedPlanResponse>(`/execution/plans/${encodeURIComponent(planId)}/select-all`, {});
}
export async function runReviewedPlan(planId: string, selectedGroupIds: string[], dryRun: boolean, onProgress?: (progress: ExecutionRunProgress) => void) {
  const path = `/execution/plans/${encodeURIComponent(planId)}/run`;
  const response = await fetch(`${API_BASE_URL}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ selectedGroupIds, dryRun }) });
  // Older APIs still return their ordinary JSON result, without live updates.
  if (!response.ok || !response.headers.get('content-type')?.includes('application/x-ndjson')) return readResponse<ExecutionRunResponse>(response, { method: 'POST', path });
  if (!response.body) throw new Error('Execution response was incomplete. The run may still be active; check the latest saved run before retrying.');
  const terminal = await consumeExecutionRun(response.body, (progress) => {
    if (progress.dryRun !== dryRun || progress.totalGroups !== selectedGroupIds.length) throw new Error('Execution progress does not match the requested selection');
    onProgress?.(progress);
  });
  if (terminal.type === 'error') return readResponse<ExecutionRunResponse>(Response.json(terminal, { status: terminal.status }), { method: 'POST', path });
  if (terminal.result.dryRun !== dryRun) throw new Error('Execution result does not match the requested mode');
  return terminal.result;
}
export function getReviewedThumbnailUrl(planId: string, assetId: string) {
  return `${API_BASE_URL}/execution/plans/${encodeURIComponent(planId)}/assets/${encodeURIComponent(assetId)}/thumbnail`;
}

function checkedRulesState(value: RulesState & { ok: true }) {
  if (!Array.isArray(value?.savedPresets)) throw new Error('The Dedupe API response is missing saved preset data. Restart the API from the current project checkout, then refresh presets. If this continues, check VITE_API_BASE_URL and reverse-proxy routing. Your editor changes have been kept.');
  if (value.draft?.schemaVersion !== 2 || value.savedPresets.some((preset) => preset?.ruleset?.schemaVersion !== 2)) throw new Error('The Dedupe API does not support the current AND/OR resolution format. Restart the API from the current project checkout, then retry loading rules or refresh presets. Your editor changes have been kept.');
  return value;
}
export async function getRules() { return checkedRulesState(await apiGet<RulesState & { ok: true }>('/rules')); }
export async function saveRulePreset(request: SaveRulePresetRequest) { return checkedRulesState(await apiPost<RulesState & { ok: true }>('/rules/presets', { ...request, ruleset: upgradeResolutionDraft(request.ruleset) })); }
export async function deleteRulePreset(id: string, expectedRevision: number) {
  const path = `/rules/presets/${encodeURIComponent(id)}`;
  return checkedRulesState(await readResponse<RulesState & { ok: true }>(await fetch(`${API_BASE_URL}${path}`, {
    method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedRevision }),
  }), { method: 'DELETE', path }));
}
export async function saveRulesDraft(ruleset: RuleSetDraft) {
  const path = '/rules/draft';
  return checkedRulesState(await readResponse<RulesState & { ok: true }>(await fetch(`${API_BASE_URL}${path}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ruleset: upgradeResolutionDraft(ruleset) }),
  }), { method: 'PUT', path }));
}
export async function publishRules(ruleset: RuleSetDraft) { return checkedRulesState(await apiPost<RulesState & { ok: true }>('/rules/publish', { ruleset: upgradeResolutionDraft(ruleset) })); }
export function testRules(ruleset: RuleSetDraft, snapshotId: string) {
  return apiPost<{ ok: true; results: ConfiguredDecision[] }>('/rules/test', { ruleset: upgradeResolutionDraft(ruleset), snapshotId });
}
export type PendingCandidate = PendingScanCandidate;
export function getPendingCandidates() { return apiGet<{ ok: true; pending: PendingCandidate[]; summary: ScanSummary; conflicts?: ResolutionConflict[] }>('/execution/scan/pending'); }
export function preparePendingCandidates(selectedGroupIds: string[], executeLimit: number) {
  return apiPost<ReviewedPlanResponse>('/execution/scan/prepare-pending', { selectedGroupIds, executeLimit });
}
export function recheckExcludedGroups() { return apiPost<{ ok: true }>('/execution/scan/recheck-excluded', {}); }
export function resetScanProgress() { return apiPost<{ ok: true }>('/execution/scan/reset', {}); }
