import { test, expect } from '@playwright/test';
import { consumeQuickDetails } from '../src/quickDetailStream';

const progress = { reviewId: 'quick', stage: 'checking-albums', groupId: 'é', groupIndex: 1, totalGroups: 1, checkedGroups: 0 };
const error = { type: 'error', status: 409, code: 'plan_changed', error: 'Selection changed', changedGroups: [{ groupId: 'é', reasons: ['Membership changed'] }] };
const result = { ok: true, plan: { planId: 'full', scope: { apiUrl: 'https://immich.invalid/api', accountId: 'fake' }, expiresAt: new Date(Date.now() + 900000).toISOString(), executeLimit: 1, fetchedGroups: 0, totalGroups: 1, candidates: [], excludedGroups: [] } };
function body(events: unknown[], split = false) {
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event) + '\n').join(''));
  return new ReadableStream<Uint8Array>({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); else controller.enqueue(bytes);
    controller.close();
  } });
}
test('selected-details stream preserves UTF-8 progress and changed-group diagnostics', async () => {
  const seen: unknown[] = [];
  expect(await consumeQuickDetails(body([{ type: 'progress', progress }, error], true), (value) => seen.push(value))).toEqual(error);
  expect(seen).toEqual([progress]);
});
test('selected-details stream requires a complete, valid terminal review', async () => {
  expect(await consumeQuickDetails(body([{ type: 'result', result }]), () => undefined)).toEqual({ type: 'result', result });
  await expect(consumeQuickDetails(body([{ type: 'progress', progress }]), () => undefined)).rejects.toThrow('incomplete');
  await expect(consumeQuickDetails(body([{ type: 'result', result: { ok: true, plan: null } }]), () => undefined)).rejects.toThrow('Invalid');
  await expect(consumeQuickDetails(body([{ type: 'result', result }, error]), () => undefined)).rejects.toThrow('Unexpected');
});
test('selected-details progress rejects invalid counters and changing request identity', async () => {
  for (const invalid of [{ ...progress, checkedGroups: 2 }, { ...progress, groupIndex: -1 }, { ...progress, stage: 'invented' }]) {
    await expect(consumeQuickDetails(body([{ type: 'progress', progress: invalid }]), () => undefined)).rejects.toThrow('Invalid');
  }
  await expect(consumeQuickDetails(body([{ type: 'progress', progress }, { type: 'progress', progress: { ...progress, reviewId: 'another' } }]), () => undefined)).rejects.toThrow('Invalid');
});
