import type { QuickDetailEvent, QuickDetailProgress, QuickDetailStage } from '@immich-dedupe/shared';
import { validResult } from './reviewPreparationStream';

export const quickDetailLabels: Record<QuickDetailStage, string> = {
  'checking-history': 'Checking recovery history', 'checking-identity': 'Checking Immich account identity',
  'validating-selection': 'Validating the selected Quick Review groups',
  'checking-membership': 'Checking fresh duplicate group membership', 'checking-assets': 'Loading fresh image details and checking safety rules',
  'checking-albums': 'Loading album memberships and calculating proposed transfers',
  'evaluating-rules': 'Re-evaluating rules and checking the keeper and loser selections', finalizing: 'Building the detailed review',
};
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export async function consumeQuickDetails(body: ReadableStream<Uint8Array>, onProgress: (progress: QuickDetailProgress) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', last: QuickDetailProgress | undefined;
  let terminal: Extract<QuickDetailEvent, { type: 'result' | 'error' }> | undefined;
  function line(text: string) {
    if (!text.trim()) return;
    if (terminal) throw new Error('Unexpected data after detail loading finished');
    const event: unknown = JSON.parse(text);
    if (!record(event)) throw new Error('Invalid detail-loading progress response');
    if (event.type === 'progress') {
      const p = event.progress;
      if (!record(p) || typeof p.reviewId !== 'string' || !Object.hasOwn(quickDetailLabels, String(p.stage))
        || !(p.groupId === null || typeof p.groupId === 'string') || !count(p.groupIndex) || !count(p.totalGroups) || !count(p.checkedGroups)
        || p.groupIndex > p.totalGroups || p.checkedGroups > p.totalGroups
        || (last && (last.reviewId !== p.reviewId || last.totalGroups !== p.totalGroups || last.checkedGroups > p.checkedGroups))) throw new Error('Invalid detail-loading progress response');
      last = p as QuickDetailProgress; onProgress(last);
    } else if (event.type === 'result' && record(event.result) && event.result.ok === true && validResult({ status: 'completed', plan: event.result.plan })) {
      terminal = event as Extract<QuickDetailEvent, { type: 'result' }>;
    } else if (event.type === 'error' && typeof event.error === 'string' && typeof event.code === 'string'
      && Number.isInteger(event.status) && (event.status as number) >= 400 && (event.status as number) <= 599) {
      terminal = event as Extract<QuickDetailEvent, { type: 'error' }>;
    } else throw new Error('Invalid detail-loading progress response');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    if (buffer.trim() || !terminal) throw new Error('Detail-loading response was incomplete. Quick Review and selection were preserved; loading may still be active. No execution was requested.');
    return terminal;
  } catch (error) {
    await reader.cancel().catch(() => undefined); throw error;
  } finally { reader.releaseLock(); }
}
