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
  const h = executionHarness();
  h.raw.assets.forEach((asset) => { asset.livePhotoVideoId = null; });
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'immich-quick-review-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const journal = createExecutionJournal(path.join(dir, 'journal'));
  const log = createExecutionLog(path.join(dir, 'log.json'));
  let time = Date.now();
  const execution = createExecutionService({ client: h.client, journal, log, apiUrl: 'http://immich.invalid/api', now: () => time, delay: h.delay });
  const prepare = async () => {
    const result = await execution.prepareQuickReview({ scanLimit: 100, executeLimit: 5 });
    assert.ok(result.quickReview); return result.quickReview;
  };
  return { ...h, execution, prepare, journal, log, advance(ms: number) { time += ms; } };
}
const error = (status: number, code?: string) => (e: unknown) => e instanceof ExecutionServiceError && e.status === status && (!code || e.code === code);

test('Quick Review uses one duplicate read, no enrichment or journal run, and cannot be executed or used for thumbnails', async (t) => {
  const h = setup(t); const snapshot = await h.prepare();
  assert.deepEqual(h.calls, ['groups']); assert.deepEqual(h.mutations, []);
  assert.equal(snapshot.candidates.length, 1); assert.equal(snapshot.excludedGroups.length, 0);
  assert.equal(snapshot.candidates[0].keepAsset.fileSize, 200);
  assert.equal('albums' in snapshot.candidates[0].keepAsset, false);
  assert.equal('proposedAlbumIds' in snapshot.candidates[0], false);
  assert.equal(h.journal.runs(snapshot.scope).length, 0); assert.deepEqual(h.log.loadExecutionLog(), []);
  await assert.rejects(h.execution.runReviewed(snapshot.reviewId, { selectedGroupIds: ['group'], dryRun: false }), error(410));
  await assert.rejects(h.execution.reviewedAsset(snapshot.reviewId, 'group-keep'), error(410));
});

for (const field of ['isFavorite', 'isEdited', 'isTrashed', 'isArchived', 'isOffline', 'livePhotoVideoId', 'duplicateId', 'originalPath', 'type']) {
  test(`missing ${field} remains unverified without fallback reads`, async (t) => {
    const h = setup(t); Reflect.deleteProperty(h.raw.assets[0], field);
    const snapshot = await h.prepare();
    assert.equal(snapshot.candidates.length, 0); assert.equal(snapshot.excludedGroups[0].reason, 'unverified');
    assert.match(snapshot.excludedGroups[0].message, /Not verified in Quick Review.*Extra metadata reads were skipped/);
    assert.deepEqual(h.calls, ['groups']); assert.deepEqual(h.mutations, []);
  });
}
for (const invalid of [null, '', 'not-a-number', 0, -3]) test(`missing/invalid size ${JSON.stringify(invalid)} is unverified`, async (t) => {
  const h = setup(t); Reflect.set(h.raw.assets[0].exifInfo!, 'fileSizeInByte', invalid);
  const snapshot = await h.prepare(); assert.equal(snapshot.candidates.length, 0);
  assert.match(snapshot.excludedGroups[0].message, /file size/); assert.deepEqual(h.calls, ['groups']);
});

test('Quick Review honors safety protections, source classification and the two-asset rule', async (t) => {
  for (const change of ['favorite', 'video', 'linked', 'unknown-path', 'unequal-dimensions', 'three-assets', 'repeated-ids', 'invalid-link'] as const) {
    const h = setup(t);
    if (change === 'favorite') h.raw.assets[0].isFavorite = true;
    if (change === 'video') Reflect.set(h.raw.assets[0], 'type', 'VIDEO');
    if (change === 'linked') h.raw.assets[0].livePhotoVideoId = 'video-id';
    if (change === 'unknown-path') h.raw.assets[0].originalPath = '/unknown/photo.jpg';
    if (change === 'unequal-dimensions') h.raw.assets[0].width = 999;
    if (change === 'three-assets') h.raw.assets.push({ ...h.raw.assets[0], id: 'third' });
    if (change === 'repeated-ids') h.raw.assets[1].id = h.raw.assets[0].id;
    if (change === 'invalid-link') Reflect.set(h.raw.assets[0], 'livePhotoVideoId', 123);
    const snapshot = await h.prepare(); assert.equal(snapshot.candidates.length, 0, change);
    assert.deepEqual(h.calls, ['groups']); assert.deepEqual(h.mutations, []);
  }
});

test('numeric size strings are evaluated with the same deterministic rule', async (t) => {
  const h = setup(t); Reflect.set(h.raw.assets[0].exifInfo!, 'fileSizeInByte', '200');
  assert.equal((await h.prepare()).candidates[0].decision.confidence, 100);
});

test('selected details produce an immutable full review with real album proposals and require their own dry-run', async (t) => {
  const h = setup(t); const snapshot = await h.prepare();
  snapshot.candidates[0].keepAsset.fileSize = 999; // A caller cannot rewrite stored quick evidence.
  const { plan } = await h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 });
  assert.deepEqual(plan.candidates[0].proposedAlbumIds, ['missing']);
  assert.equal(plan.candidates[0].keepAsset.fileSize, 200);
  assert.notEqual(plan.planId, snapshot.reviewId); assert.equal(plan.executeLimit, 1);
  assert.equal(Date.parse(plan.expiresAt) - Date.parse(plan.createdAt), 900000);
  assert.deepEqual(h.mutations, []);
  await assert.rejects(h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), error(409, 'dry_run_required'));
  assert.equal((await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] })).results[0].outcome, 'dry-run');
  assert.equal((await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false })).results[0].outcome, 'succeeded');
});

for (const change of ['checksum', 'size', 'filename', 'favorite', 'membership'] as const) test(`selected quick ${change} changes reject the whole upgrade`, async (t) => {
  const h = setup(t); const snapshot = await h.prepare();
  const asset = h.assets.get('group-keep')!;
  if (change === 'checksum') asset.checksum = 'changed';
  if (change === 'size') asset.exifInfo!.fileSizeInByte = 300;
  if (change === 'filename') for (const a of h.assets.values()) a.originalFileName = 'new.jpg';
  if (change === 'favorite') asset.isFavorite = true;
  if (change === 'membership') h.client.getAssetDuplicates = async () => [];
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 5 }), error(409, 'plan_changed'));
  assert.deepEqual(h.mutations, []); assert.equal(h.journal.runs(snapshot.scope).length, 0);
});

test('only selected groups are enriched; newly loaded albums and previously unavailable checksums are not stale changes', async (t) => {
  const h = setup(t), other = executionHarness('other');
  other.raw.assets.forEach((asset) => { asset.livePhotoVideoId = null; });
  h.raw.assets.forEach((asset) => Reflect.deleteProperty(asset, 'checksum'));
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(other.raw)];
  const snapshot = await h.prepare(); assert.equal(snapshot.candidates.length, 2);
  h.assets.get('group-keep')!.checksum = 'newly-loaded-checksum';
  const { plan } = await h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 });
  assert.deepEqual(plan.candidates.map((candidate) => candidate.groupId), ['group']);
  assert.equal(h.calls.some((call) => call.includes('other')), false);
  assert.deepEqual(plan.candidates[0].proposedAlbumIds, ['missing']);
  assert.deepEqual(h.mutations, []);
});

test('all-or-nothing upgrade rejects a stale second candidate without installing or executing replacements', async (t) => {
  const h = setup(t), other = executionHarness('other');
  other.raw.assets.forEach((asset) => { asset.livePhotoVideoId = null; });
  const getInfo = h.client.getAssetInfo;
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(other.raw)];
  h.client.getAssetInfo = (args) => args.id.startsWith('other') ? other.client.getAssetInfo(args) : getInfo(args);
  const snapshot = await h.prepare(); other.assets.get('other-keep')!.checksum = 'changed';
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['other', 'group'], executeLimit: 2 }), (e: unknown) => {
    assert.ok(error(409, 'plan_changed')(e));
    assert.deepEqual((e as ExecutionServiceError).details.changedGroups && ((e as ExecutionServiceError).details.changedGroups as Array<{ groupId: string }>).map((group) => group.groupId), ['other']);
    return true;
  });
  assert.deepEqual(h.mutations, []); assert.deepEqual(other.mutations, []);
});

test('Quick Review preserves journal exclusions and releases no quarantined selections', async (t) => {
  const h = setup(t); const { plan } = await h.execution.preparePlan({ scanLimit: 10, executeLimit: 1 });
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  const snapshot = await h.prepare(); assert.equal(snapshot.candidates.length, 0);
  assert.equal(snapshot.excludedGroups[0].reason, 'quarantined');
});

test('quick snapshots enforce expiry, capacity, identity and scope; selection validation never substitutes groups', async (t) => {
  const h = setup(t); const snapshot = await h.prepare();
  for (const request of [{ selectedGroupIds: [], executeLimit: 1 }, { selectedGroupIds: ['group', 'group'], executeLimit: 2 }, { selectedGroupIds: ['unknown'], executeLimit: 1 }, { selectedGroupIds: ['group'], executeLimit: 0 }]) {
    await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, request), error(400));
  }
  h.client.getMyUser = async () => ({ id: 'other' });
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), error(409));
  h.client.getMyUser = async () => { throw { status: 403 }; };
  await assert.rejects(h.prepare(), error(503, 'identity_unavailable'));
  h.client.getMyUser = async () => ({ id: 'test-user' });
  for (let i = 0; i < 20; i++) await h.prepare();
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), error(410));
  const latest = await h.prepare(); h.advance(900000);
  await assert.rejects(h.execution.prepareQuickSelection(latest.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), error(410));
});

test('cancelling a quick scan keeps completed results with one upstream read and yields for HTTP cancellation', async (t) => {
  const h = setup(t);
  h.client.getAssetDuplicates = async () => Array.from({ length: 100 }, (_, index) => ({ ...structuredClone(h.raw), duplicateId: `group-${index}`,
    assets: h.raw.assets.map((asset) => ({ ...asset, id: `${asset.id}-${index}`, duplicateId: `group-${index}` })) }));
  let scheduled = false;
  const result = await h.execution.prepareQuickReview({ scanLimit: 100, executeLimit: 5 }, (p) => {
    if (p.stage === 'evaluating-rules' && !scheduled) { scheduled = true; setImmediate(() => h.execution.cancelPreparation(p.preparationId)); }
  });
  assert.equal(result.status, 'cancelled'); assert.ok(result.quickReview);
  assert.equal(result.quickReview.fetchedGroups, 25); assert.equal(result.quickReview.candidates.length, 25);
  assert.deepEqual(h.calls, []); assert.deepEqual(h.mutations, []);
});

test('quick preparation and detail loading share the lock and malformed responses fail closed', async (t) => {
  const h = setup(t); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.client.getAssetDuplicates = async () => { entered(); await wait; return [structuredClone(h.raw)]; };
  const pending = h.prepare(); await started;
  await assert.rejects(h.prepare(), error(409)); await assert.rejects(h.execution.clearLog(), error(409));
  release(); const snapshot = await pending;
  h.client.getAllAlbums = async () => { throw new Error('private upstream details'); };
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), error(503, 'preflight_unavailable'));
  h.client.getAssetDuplicates = async () => [structuredClone(h.raw), structuredClone(h.raw)];
  await assert.rejects(h.prepare(), error(503)); assert.deepEqual(h.mutations, []);
});

test('new quarantine after quick scanning prevents selected detail preparation', async (t) => {
  const h = setup(t); const snapshot = await h.prepare();
  const { plan } = await h.execution.preparePlan({ scanLimit: 10, executeLimit: 1 });
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  await h.execution.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  await assert.rejects(h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), (e: unknown) => {
    assert.ok(error(409, 'plan_changed')(e));
    assert.match(JSON.stringify((e as ExecutionServiceError).details.changedGroups), /quarantined/);
    return true;
  });
});

test('selected detail loading holds the lock until every started read settles after a failure', async (t) => {
  const h = setup(t); const snapshot = await h.prepare(); let release!: () => void, entered!: () => void, calls = 0;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.client.getAllAlbums = async () => {
    if (++calls === 1) { entered(); await wait; return []; }
    throw new Error('unavailable');
  };
  const pending = h.execution.prepareQuickSelection(snapshot.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 });
  const rejected = assert.rejects(pending, error(503));
  await started; await assert.rejects(h.prepare(), error(409));
  release(); await rejected; assert.equal(calls, 4); assert.deepEqual(h.mutations, []);
});

test('structurally invalid quick group responses fail with sanitized diagnostics', async (t) => {
  const h = setup(t); Reflect.set(h.raw, 'assets', null);
  await assert.rejects(h.prepare(), (e: unknown) => {
    assert.ok(error(503, 'preflight_unavailable')(e));
    assert.match((e as Error).message, /invalid duplicate group data/); return true;
  });
  assert.deepEqual(h.mutations, []);
});
