import type { ExecutionRunEvent, ExecutionRunProgress } from '@immich-dedupe/shared';
import { executionRunStageLabels } from './executionRunProgress';

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function strings(value: unknown): boolean { return Array.isArray(value) && value.every((item) => typeof item === 'string'); }
export function validRunResponse(value: unknown): boolean {
  return record(value) && typeof value.ok === 'boolean' && typeof value.dryRun === 'boolean'
    && typeof value.stoppedEarly === 'boolean' && (value.stopReason === null || typeof value.stopReason === 'string')
    && ['scanLimit', 'executeLimit', 'fetchedGroups', 'eligibleCount', 'actuallyExecutedCount', 'resolvedCount', 'trashedCount'].every((field) => count(value[field]))
    && (value.scanLimit as number) > 0 && (value.executeLimit as number) > 0
    && Array.isArray(value.results) && value.results.every((result) => record(result) && typeof result.groupId === 'string'
      && ['dry-run', 'execute'].includes(String(result.mode)) && ['dry-run', 'succeeded', 'failed', 'needs-verification'].includes(String(result.outcome))
      && ['executed', 'resolvedDuplicate', 'trashedAsset'].every((field) => typeof result[field] === 'boolean')
      && ['proposedAlbumIds', 'transferredAlbumIds', 'skippedAlbumIds'].every((field) => strings(result[field]))
      && typeof result.message === 'string');
}
/** Never turn a dropped progress connection into success or replay a request. */
export async function consumeExecutionRun(body: ReadableStream<Uint8Array>, onProgress: (progress: ExecutionRunProgress) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  let terminal: Extract<ExecutionRunEvent, { type: 'result' | 'error' }> | undefined;
  let last: ExecutionRunProgress | undefined;
  function line(text: string) {
    if (!text.trim()) return;
    if (terminal) throw new Error('Unexpected data after execution finished');
    const event: unknown = JSON.parse(text);
    if (!record(event)) throw new Error('Invalid execution progress response');
    if (event.type === 'progress') {
      const p = event.progress;
      if (!record(p) || !(p.runId === null || typeof p.runId === 'string') || typeof p.dryRun !== 'boolean'
        || !['validating', 'running', 'finalizing'].includes(String(p.phase)) || !Object.hasOwn(executionRunStageLabels, String(p.stage))
        || !(p.groupId === null || typeof p.groupId === 'string') || !count(p.groupIndex) || !count(p.totalGroups) || !count(p.completedGroups)
        || p.groupIndex > p.totalGroups || p.completedGroups > p.totalGroups
        || (last && (last.dryRun !== p.dryRun || last.totalGroups !== p.totalGroups || last.completedGroups > p.completedGroups || (last.runId !== null && last.runId !== p.runId)))) throw new Error('Invalid execution progress response');
      last = p as ExecutionRunProgress;
      onProgress(last);
    } else if (event.type === 'result' && validRunResponse(event.result)) {
      if (last && record(event.result) && (event.result.dryRun !== last.dryRun || (last.runId && event.result.runId !== last.runId))) throw new Error('Invalid execution result identity');
      terminal = event as Extract<ExecutionRunEvent, { type: 'result' }>;
    } else if (event.type === 'error' && typeof event.error === 'string' && typeof event.code === 'string'
      && Number.isInteger(event.status) && (event.status as number) >= 400 && (event.status as number) <= 599
      && (event.partialExecution === undefined || validRunResponse(event.partialExecution))) {
      terminal = event as Extract<ExecutionRunEvent, { type: 'error' }>;
    } else throw new Error('Invalid execution progress response');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    if (buffer.trim() || !terminal) throw new Error('Execution response was incomplete. The run may still be active; check the latest saved run before retrying.');
    return terminal;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
