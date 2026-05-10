const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? "http://localhost:3001";

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`);

  if (!response.ok) {
    throw new Error(`GET ${path} failed: ${response.status}`);
  }

  return response.json();
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`POST ${path} failed: ${response.status}`);
  }

  return response.json();
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

export type ExecutionLogEntry = {
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
