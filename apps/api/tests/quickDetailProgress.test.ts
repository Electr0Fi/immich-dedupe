import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import type { QuickDetailEvent, QuickDetailProgress } from '@immich-dedupe/shared';
import { createApp } from '../src/app';
import { createExecutionService, ExecutionServiceError } from '../src/executionService';
import { executionHarness, heuristicTestRules, temporaryJournal, temporaryLog } from './fixtures';

async function serve(t: TestContext, h = executionHarness('one')) {
  const journal = temporaryJournal(t), log = temporaryLog(t);
  const rules = await heuristicTestRules();
  const app = createApp({ immich: h.client, journal, log, rules,
    config: { IMMICH_URL: 'http://immich.invalid/api', IMMICH_API_KEY: 'fake' },
    fetch: async () => { throw new Error('Unexpected external fetch'); }, saveConnection: () => { throw new Error('Unexpected settings write'); } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown, stream = false) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) });
  const prepare = async () => (await (await post('/execution/quick-reviews', { scanLimit: 100, executeLimit: 5 })).json()).quickReview;
  return { ...h, journal, post, prepare };
}

test('selected detail progress reports real stages and sequential checked counts; observer failures cannot alter the plan', async (t) => {
  const h = executionHarness(), other = executionHarness('other');
  const original = h.client.getAssetInfo;
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(other.raw)];
  h.client.getAssetInfo = (args) => args.id.startsWith('other') ? other.client.getAssetInfo(args) : original(args);
  const service = createExecutionService({ client: h.client, journal: temporaryJournal(t), log: temporaryLog(t), apiUrl: 'http://immich.invalid/api', delay: h.delay });
  const quick = (await service.prepareQuickReview({ scanLimit: 10, executeLimit: 5 })).quickReview!;
  assert.equal(quick.candidates.length, 2);
  const events: QuickDetailProgress[] = [];
  const { plan } = await service.prepareQuickSelection(quick.reviewId, { selectedGroupIds: ['group', 'other'], executeLimit: 5 }, (progress) => {
    events.push(structuredClone(progress)); progress.checkedGroups = 999; throw new Error('Disconnected observer');
  });
  assert.equal(plan.candidates.length, 2); assert.deepEqual(plan.candidates[0].proposedAlbumIds, ['missing']);
  assert.ok(events.every((event) => event.reviewId === quick.reviewId && event.totalGroups === 2 && event.checkedGroups <= 2));
  for (const stage of ['checking-history', 'checking-identity', 'validating-selection', 'checking-membership', 'checking-assets', 'checking-albums', 'evaluating-rules', 'finalizing']) assert.ok(events.some((event) => event.stage === stage), stage);
  assert.ok(events.some((event) => event.groupId === 'other' && event.groupIndex === 2 && event.checkedGroups === 1));
  assert.equal(events.at(-1)?.checkedGroups, 2); assert.equal(events.at(-1)?.groupId, null);
  await assert.rejects(service.runReviewed(plan.planId, { selectedGroupIds: ['group', 'other'], dryRun: false }), (error: unknown) => error instanceof ExecutionServiceError && error.code === 'dry_run_required');
  assert.deepEqual(h.mutations, []); assert.deepEqual(other.mutations, []);
});

test('selected-detail HTTP streaming reports progress before reads finish and JSON compatibility is preserved', async (t) => {
  const h = await serve(t); const snapshot = await h.prepare();
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const albums = h.client.getAllAlbums;
  h.client.getAllAlbums = async (args) => { entered(); await waiting; return albums(args); };
  const endpoint = `/execution/quick-reviews/${snapshot.reviewId}/prepare-plan`;
  const selection = { selectedGroupIds: ['one'], executeLimit: 5 };
  const response = await h.post(endpoint, selection, true);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  assert.equal(JSON.parse(text.split('\n')[0]).type, 'progress');
  await started;
  const busy = await h.post(endpoint, selection, true); assert.equal(busy.status, 409); assert.equal((await busy.json()).code, 'execution_busy');
  release();
  for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value, { stream: true }); }
  const events = text.trim().split('\n').map((line) => JSON.parse(line) as QuickDetailEvent);
  assert.ok(events.some((event) => event.type === 'progress' && event.progress.stage === 'checking-albums'));
  const terminal = events.at(-1)!; assert.equal(terminal.type, 'result');
  if (terminal.type !== 'result') throw new Error('Expected a plan');
  assert.equal(terminal.result.plan.candidates.length, 1); assert.deepEqual(terminal.result.plan.candidates[0].proposedAlbumIds, ['missing']);
  const jsonResponse = await h.post(endpoint, selection); assert.match(jsonResponse.headers.get('content-type')!, /application\/json/);
  assert.equal((await jsonResponse.json()).plan.candidates.length, 1);
  assert.equal((await h.post(endpoint, { selectedGroupIds: [] }, true)).status, 400);
  assert.deepEqual(h.mutations, []);
});

test('selected-detail stale errors remain all-or-nothing and retain changed-group diagnostics', async (t) => {
  const h = executionHarness('one'), other = executionHarness('other');
  const original = h.client.getAssetInfo;
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(other.raw)];
  h.client.getAssetInfo = (args) => args.id.startsWith('other') ? other.client.getAssetInfo(args) : original(args);
  const server = await serve(t, h); const snapshot = await server.prepare();
  assert.equal(snapshot.candidates.length, 2); other.raw.assets[0].isFavorite = true;
  const response = await server.post(`/execution/quick-reviews/${snapshot.reviewId}/prepare-plan`, { selectedGroupIds: ['one', 'other'], executeLimit: 5 }, true);
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.some((event) => event.type === 'result'), false);
  assert.equal(events.at(-1).status, 409); assert.equal(events.at(-1).code, 'plan_changed');
  assert.equal(events.at(-1).changedGroups[0].groupId, 'other');
  assert.deepEqual(server.mutations, []); assert.deepEqual(other.mutations, []);
});

test('a disconnected detail stream holds its lock until all started reads settle, even when one fails', async (t) => {
  const h = await serve(t); const snapshot = await h.prepare();
  const original = h.client.getAssetInfo;
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  h.client.getAssetInfo = async (args) => {
    if (args.id.endsWith('keep')) throw new Error('private SDK details');
    entered(); await waiting; return original(args);
  };
  const endpoint = `/execution/quick-reviews/${snapshot.reviewId}/prepare-plan`;
  const selection = { selectedGroupIds: ['one'], executeLimit: 5 };
  const response = await h.post(endpoint, selection, true);
  await started; await response.body!.cancel();
  assert.equal((await h.post(endpoint, selection, true)).status, 409);
  h.client.getAssetInfo = original; release();
  let status = 409;
  for (let index = 0; index < 100 && status === 409; index++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await h.post(endpoint, selection); status = next.status; await next.arrayBuffer();
  }
  assert.equal(status, 200); assert.deepEqual(h.mutations, []);
});

test('selected-detail upstream errors are sanitized terminal stream errors', async (t) => {
  const h = await serve(t); const snapshot = await h.prepare();
  h.client.getAssetInfo = async () => { throw new Error('private SDK credentials'); };
  const response = await h.post(`/execution/quick-reviews/${snapshot.reviewId}/prepare-plan`, { selectedGroupIds: ['one'], executeLimit: 5 }, true);
  const text = await response.text(); assert.equal(text.includes('private SDK'), false);
  const terminal = text.trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.equal(terminal.type, 'error'); assert.equal(terminal.status, 503); assert.equal(terminal.code, 'preflight_unavailable');
  assert.deepEqual(h.mutations, []);
});
