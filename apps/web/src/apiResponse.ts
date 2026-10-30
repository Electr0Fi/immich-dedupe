import type { ExecutionRunResponse } from './api';

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

export async function readResponse<T>(response: Response, endpoint: { method: string; path: string }): Promise<T> {
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const partial = data?.partialExecution;
    const missingEndpoint = response.status === 404 && typeof data?.error !== 'string' && typeof data?.code !== 'string';
    const message = missingEndpoint
      ? `The configured Dedupe API does not provide ${endpoint.method} ${endpoint.path}. Restart the API from the current project checkout, reload this page and prepare a new review. If this continues, check VITE_API_BASE_URL and any reverse-proxy routing.`
      : typeof data?.error === 'string' ? data.error : response.statusText;
    throw new ApiError(response.status, message + (Array.isArray(data?.changedGroups) ? data.changedGroups.map((g: { groupId: string; reasons: string[] }) => ` Group ${g.groupId}: ${Array.isArray(g.reasons) ? g.reasons.join('; ') : 'changed'}`).join('') : ''),
      partial && Array.isArray(partial.results) && typeof partial.runId === 'string' ? partial : undefined,
      missingEndpoint ? 'api_endpoint_unavailable' : typeof data?.code === 'string' ? data.code : undefined, typeof data?.runId === 'string' ? data.runId : undefined);
  }
  if (data === null) throw new Error('The API returned an invalid JSON response');
  return data;
}

