import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import { createExecutionService, ExecutionServiceError } from '../src/executionService';
import { createExecutionJournal } from '../src/executionJournal';
import { createExecutionLog } from '../src/executionLog';
import { executionHarness } from './fixtures';

function setup(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'immich-plans-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const h = executionHarness(); const journal = createExecutionJournal(path.join(dir, 'journal'));
  const log = createExecutionLog(path.join(dir, 'log.json'));
  let time = Date.now();
  const service = () => createExecutionService({ client: h.client, journal, log, apiUrl: 'http://immich.invalid/api', now: () => time, delay: h.delay });
  const execution = service();
  const prepare = async () => (await execution.preparePlan({ scanLimit: 100, executeLimit: 10 })).plan;
  return { ...h, dir, journal, log, service, execution, prepare, advance: (ms: number) => { time += ms; } };
}
function error(status: number, code?: string) { return (e: unknown) => e instanceof ExecutionServiceError && e.status === status && (!code || e.code === code); }

test('review creation reads fresh comparisons, album actions and metadata, without mutations', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  assert.equal(plan.candidates.length, 1); assert.equal(plan.candidates[0].keepAsset.checksum, 'checksum');
  assert.equal(plan.candidates[0].keepAsset.fileSize, 200); assert.deepEqual(plan.candidates[0].proposedAlbumIds, ['missing']);
  assert.deepEqual(plan.candidates[0].requiredAlbumIds, ['missing', 'shared']);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 900000);
  plan.candidates[0].keepAsset.fileSize = 999; // Caller cannot alter the immutable stored plan.
  assert.equal((await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] })).results[0].outcome, 'dry-run');
  assert.deepEqual(h.mutations, []);
});

test('live requires the exact journaled dry-run and consumes its review', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), error(409, 'dry_run_required'));
  const dry = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  assert.equal(dry.results[0].outcome, 'dry-run'); assert.deepEqual(h.mutations, []);
  const live = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  assert.equal(live.results[0].outcome, 'succeeded'); assert.deepEqual(h.mutations, ['add', 'resolve']);
  const record = h.journal.runs(plan.scope).find((r) => r.runId === live.runId)!;
  assert.equal(record.version, 3); if (record.version !== 3) return;
  assert.equal(record.review.authorizingDryRunId, dry.runId);
  const restarted = createExecutionJournal(path.join(h.dir, 'journal'));
  assert.equal(restarted.runs(plan.scope).length, 2);
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] }), error(410));
});

for (const ids of [[], ['group', 'group'], ['unknown']]) test(`invalid selection ${JSON.stringify(ids)} cannot execute`, async (t) => {
  const h = setup(t); const plan = await h.prepare();
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ids }), error(400));
  assert.deepEqual(h.mutations, []);
});

test('expiry, capacity eviction, restart and connection identity fail closed', async (t) => {
  const h = setup(t); const first = await h.prepare();
  h.client.getMyUser = async () => ({ id: 'other' });
  await assert.rejects(h.execution.runReviewed(first.planId, { selectedGroupIds: ['group'] }), error(409, 'plan_scope_changed'));
  h.client.getMyUser = async () => ({ id: 'test-user' });
  for (let i = 0; i < 20; i++) await h.prepare();
  await assert.rejects(h.execution.runReviewed(first.planId, { selectedGroupIds: ['group'] }), error(410));
  const latest = await h.prepare(); h.advance(900000);
  await assert.rejects(h.execution.runReviewed(latest.planId, { selectedGroupIds: ['group'] }), error(410));
  const current = await h.prepare();
  await assert.rejects(h.service().runReviewed(current.planId, { selectedGroupIds: ['group'] }), error(410));
});

for (const change of ['size', 'name', 'path', 'checksum', 'favorite', 'album', 'group'] as const) test(`changed ${change} rejects a reviewed batch before any mutation`, async (t) => {
  const h = setup(t); const plan = await h.prepare();
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  if (change === 'size') h.assets.get('group-keep')!.exifInfo!.fileSizeInByte = 300;
  if (change === 'name') for (const a of h.assets.values()) a.originalFileName = 'renamed.jpg';
  if (change === 'path') h.assets.get('group-keep')!.originalPath = '/external/new.jpg';
  if (change === 'checksum') h.assets.get('group-keep')!.checksum = 'changed';
  if (change === 'favorite') h.assets.get('group-keep')!.isFavorite = true;
  if (change === 'album') h.albums.get('missing')!.albumName = 'Renamed';
  if (change === 'group') h.client.getAssetDuplicates = async () => [];
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), (e: unknown) => {
    assert.ok(error(409, 'plan_changed')(e));
    assert.ok((e as ExecutionServiceError).details.changedGroups); return true;
  });
  assert.deepEqual(h.mutations, []);
});

test('unrelated timestamps and thumbhash changes do not invalidate review', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  h.assets.get('group-keep')!.updatedAt = '2026-11-01T00:00:00Z'; h.assets.get('group-keep')!.thumbhash = 'changed';
  assert.equal((await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] })).results[0].outcome, 'dry-run');
});

test('unsupported or unsafe groups are excluded while upstream album failures prevent review creation', async (t) => {
  const h = setup(t); h.assets.get('group-keep')!.isFavorite = true;
  assert.equal((await h.prepare()).excludedGroups[0].reason, 'ineligible');
  h.assets.get('group-keep')!.isFavorite = false;
  h.client.getAllAlbums = async () => { throw new Error('network'); };
  await assert.rejects(h.prepare(), error(503)); assert.deepEqual(h.mutations, []);
});

test('display-log failures cannot authorize live execution', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  h.log.appendExecutionLog = () => { throw new Error('disk'); };
  const result = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  assert.equal(result.stoppedEarly, true);
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), error(410));
  assert.deepEqual(h.mutations, []);
});

test('selected groups execute in review order; a later stale group blocks all mutations', async (t) => {
  const h = setup(t), second = executionHarness('second');
  h.client.getAllAlbums = async () => [];
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(second.raw)];
  const get = h.client.getAssetInfo;
  h.client.getAssetInfo = async (args) => args.id.startsWith('second') ? second.client.getAssetInfo(args) : get(args);
  const plan = await h.prepare(); const ids = ['second', 'group'];
  const dry = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ids });
  assert.deepEqual(dry.results.map((r) => r.groupId), ['group', 'second']);
  second.assets.get('second-keep')!.exifInfo!.fileSizeInByte = 500;
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ids, dryRun: false }), error(409));
  assert.deepEqual(h.mutations, []); assert.deepEqual(second.mutations, []);
});

test('a fresh exclusion prevents a prepared selection, including asset-based quarantine', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  // Use a separate reviewed plan to create authoritative uncertainty involving the same assets.
  const other = await h.prepare(); await h.execution.runReviewed(other.planId, { selectedGroupIds: ['group'] });
  await h.execution.runReviewed(other.planId, { selectedGroupIds: ['group'], dryRun: false });
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] }), error(409, 'plan_changed'));
});

test('per-group checks catch a change after the first operation and retain its result', async (t) => {
  const h = setup(t), second = executionHarness('second');
  h.client.getAllAlbums = async () => [];
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(second.raw)];
  const get = h.client.getAssetInfo;
  h.client.getAssetInfo = async (args) => args.id.startsWith('second') ? second.client.getAssetInfo(args) : get(args);
  const plan = await h.prepare(); const ids = ['group', 'second'];
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ids });
  const resolve = h.client.resolveDuplicates;
  h.client.resolveDuplicates = async (args) => { const result = await resolve(args); second.assets.get('second-keep')!.isFavorite = true; return result; };
  const result = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ids, dryRun: false });
  assert.equal(result.results[0].outcome, 'succeeded'); assert.equal(result.results[1].outcome, 'failed'); assert.equal(result.stoppedEarly, true);
  assert.deepEqual(h.mutations, ['resolve']); assert.deepEqual(second.mutations, []);
});

test('reviewed requests share the coordinator lock through preparation and release it on failure', async (t) => {
  const h = setup(t); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const groups = h.client.getAssetDuplicates;
  h.client.getAssetDuplicates = async () => { entered(); await wait; return groups({}); };
  const pending = h.prepare(); await started;
  await assert.rejects(h.prepare(), error(409, 'execution_busy'));
  await assert.rejects(h.execution.clearLog(), error(409));
  release(); await pending;
  h.client.getAssetDuplicates = groups; assert.equal((await h.prepare()).candidates.length, 1);
});

test('journal failures return partial results, do not authorize retries and preserve v3 evidence', async (t) => {
  const h = setup(t); const plan = await h.prepare(); const checkpoint = h.journal.checkpoint.bind(h.journal);
  h.journal.checkpoint = (scope, id, event) => { checkpoint(scope, id, event); if (event.kind === 'preflight') throw new Error('Crash boundary'); };
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] }), (e: unknown) => {
    assert.ok(error(503, 'journal_unavailable')(e)); assert.ok((e as ExecutionServiceError).details.partialExecution); return true;
  });
  assert.deepEqual(h.mutations, []);
  const restarted = createExecutionJournal(path.join(h.dir, 'journal')); assert.equal(restarted.unresolved(plan.scope).length, 1);
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), error(410));
});

test('v3 review evidence is immutable and missing authorization files fail closed after restart', async (t) => {
  const h = setup(t); const plan = await h.prepare();
  const dry = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  const live = await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  const record = h.journal.runs(plan.scope).find((r) => r.runId === live.runId)!;
  assert.equal(record.version, 3); if (record.version !== 3) return;
  record.review.candidates[0].keepAsset.fileSize = 300;
  assert.throws(() => h.journal.save(record));
  const dryFile = path.join(h.dir, 'journal', `${dry.runId}.json`);
  const untouched = fs.readFileSync(dryFile, 'utf8'); fs.unlinkSync(dryFile);
  const restarted = createExecutionJournal(path.join(h.dir, 'journal'));
  assert.equal(restarted.health().health, 'unavailable');
  // Restoring a missing file is only a test fixture action, never application repair.
  fs.writeFileSync(dryFile, untouched);
  assert.equal(createExecutionJournal(path.join(h.dir, 'journal')).health().health, 'ready');
});
