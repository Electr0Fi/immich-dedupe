import type { ReviewPreparationEvent, ReviewPreparationProgress, ReviewPreparationResult } from '@immich-dedupe/shared';

const stages = new Set(['checking-history', 'checking-identity', 'fetching-groups', 'checking-membership', 'checking-assets', 'checking-albums', 'evaluating-rules', 'finalizing']);
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
export function validResult(value: unknown): value is ReviewPreparationResult {
  if (!record(value) || !['completed', 'cancelled'].includes(String(value.status))) return false;
  const quick = 'quickReview' in value;
  if (quick && value.plan !== null) return false;
  const plan = quick ? value.quickReview : value.plan;
  if (plan === null) return value.status === 'cancelled';
  if (quick) {
    if (!record(plan) || !Array.isArray(plan.candidates) || !Array.isArray(plan.excludedGroups) || !record(plan.preparation)
      || plan.preparation.status !== value.status || !count(plan.preparation.checkedGroups) || !count(plan.preparation.targetGroups)
      || plan.preparation.checkedGroups !== plan.fetchedGroups || plan.preparation.targetGroups < plan.preparation.checkedGroups
      || plan.candidates.length + plan.excludedGroups.length !== plan.fetchedGroups) return false;
    if (!plan.candidates.every((candidate: unknown) => record(candidate) && typeof candidate.groupId === 'string'
      && record(candidate.keepAsset) && typeof candidate.keepAsset.id === 'string' && typeof candidate.keepAsset.fileName === 'string'
      && record(candidate.trashAsset) && typeof candidate.trashAsset.id === 'string' && typeof candidate.trashAsset.fileName === 'string'
      && record(candidate.decision) && Array.isArray(candidate.decision.reasons) && candidate.decision.reasons.every((reason: unknown) => typeof reason === 'string'))) return false;
    if (!plan.excludedGroups.every((group: unknown) => record(group) && typeof group.groupId === 'string' && typeof group.reason === 'string' && typeof group.message === 'string')) return false;
  }
  return record(plan) && typeof (quick ? plan.reviewId : plan.planId) === 'string' && record(plan.scope) && typeof plan.scope.apiUrl === 'string' && typeof plan.scope.accountId === 'string'
    && typeof plan.expiresAt === 'string' && Number.isFinite(Date.parse(plan.expiresAt)) && count(plan.fetchedGroups) && count(plan.totalGroups)
    && count(plan.executeLimit) && plan.executeLimit > 0 && Array.isArray(plan.candidates) && Array.isArray(plan.excludedGroups);
}
export async function consumeReviewPreparation(body: ReadableStream<Uint8Array>, onProgress: (progress: ReviewPreparationProgress) => void) {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  let terminal: Extract<ReviewPreparationEvent, { type: 'result' | 'error' }> | undefined;
  function line(text: string) {
    if (!text.trim()) return;
    if (terminal) throw new Error('Unexpected data after review preparation finished');
    const event: unknown = JSON.parse(text);
    if (!record(event)) throw new Error('Invalid review progress response');
    if (event.type === 'progress') {
      const p = event.progress;
      if (!record(p) || typeof p.preparationId !== 'string' || !stages.has(String(p.stage)) || !count(p.checkedGroups)
        || !(p.targetGroups === null || count(p.targetGroups)) || !count(p.eligibleGroups) || !count(p.excludedGroups)
        || p.checkedGroups !== p.eligibleGroups + p.excludedGroups || (typeof p.targetGroups === 'number' && p.checkedGroups > p.targetGroups)) throw new Error('Invalid review progress response');
      onProgress(p as ReviewPreparationProgress);
    } else if (event.type === 'result' && validResult(event.result)) {
      terminal = event as Extract<ReviewPreparationEvent, { type: 'result' }>;
    } else if (event.type === 'error' && typeof event.error === 'string' && typeof event.code === 'string' && Number.isInteger(event.status) && (event.status as number) >= 400 && (event.status as number) <= 599) {
      terminal = event as Extract<ReviewPreparationEvent, { type: 'error' }>;
    } else throw new Error('Invalid review progress response');
  }
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
      if (done) break;
    }
    if (buffer.trim()) throw new Error('Review preparation response was incomplete. Cancellation is not confirmed; the API may still be preparing the review.');
    if (!terminal) throw new Error('Review preparation response was incomplete. Cancellation is not confirmed; the API may still be preparing the review.');
    return terminal;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
}
