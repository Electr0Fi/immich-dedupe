import { test, expect } from '@playwright/test';
import type { ExecutionRunProgress, ExecutionRunResponse } from '@immich-dedupe/shared';
import { consumeExecutionRun } from '../src/executionRunStream';

const progress: ExecutionRunProgress = { runId: 'run', dryRun: true, phase: 'running', stage: 'checking-assets', groupId: 'group', groupIndex: 1, totalGroups: 1, completedGroups: 0 };
const result: ExecutionRunResponse = { ok: true, runId: 'run', dryRun: true, scanLimit: 100, executeLimit: 5, fetchedGroups: 1, eligibleCount: 1,
  stoppedEarly: false, stopReason: null, actuallyExecutedCount: 0, resolvedCount: 0, trashedCount: 0, results: [] };
function body(events: unknown[], split = false) {
  const encoded = new TextEncoder().encode(events.map((event) => JSON.stringify(event) + '\n').join(''));
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (const byte of encoded) controller.enqueue(new Uint8Array([byte]));
    else controller.enqueue(encoded);
    controller.close();
  } });
}
test('execution progress parses arbitrary byte and UTF-8 boundaries before terminal results', async () => {
  const seen: ExecutionRunProgress[] = [];
  const terminal = await consumeExecutionRun(body([{ type: 'progress', progress: { ...progress, groupId: 'groupe-é' } }, { type: 'result', result }], true), (p) => seen.push(p));
  expect(seen[0].groupId).toBe('groupe-é'); expect(terminal).toEqual({ type: 'result', result });
});
test('execution streams retain terminal errors and partial run evidence', async () => {
  const error = { type: 'error', status: 503, code: 'journal_unavailable', error: 'Evidence unavailable', runId: 'run', partialExecution: { ...result, ok: false, stoppedEarly: true } };
  expect(await consumeExecutionRun(body([{ type: 'progress', progress }, error]), () => undefined)).toEqual(error);
});
test('execution stream truncation never becomes a successful run', async () => {
  await expect(consumeExecutionRun(body([{ type: 'progress', progress }]), () => undefined)).rejects.toThrow('may still be active');
  await expect(consumeExecutionRun(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"type":"result"')); controller.close(); } }), () => undefined)).rejects.toThrow('incomplete');
});
test('execution progress rejects malformed counts, changed identity, malformed results and post-terminal events', async () => {
  for (const invalid of [{ ...progress, completedGroups: 2 }, { ...progress, groupIndex: -1 }, { ...progress, stage: 'unknown' }]) {
    await expect(consumeExecutionRun(body([{ type: 'progress', progress: invalid }]), () => undefined)).rejects.toThrow('Invalid');
  }
  await expect(consumeExecutionRun(body([{ type: 'progress', progress }, { type: 'progress', progress: { ...progress, runId: 'other' } }]), () => undefined)).rejects.toThrow('Invalid');
  await expect(consumeExecutionRun(body([{ type: 'progress', progress }, { type: 'result', result: { ...result, dryRun: false } }]), () => undefined)).rejects.toThrow('identity');
  await expect(consumeExecutionRun(body([{ type: 'result', result: { ok: true } }]), () => undefined)).rejects.toThrow('Invalid');
  await expect(consumeExecutionRun(body([{ type: 'result', result }, { type: 'progress', progress }]), () => undefined)).rejects.toThrow('Unexpected');
});
