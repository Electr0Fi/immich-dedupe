import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { createExecutionService } from '../src/executionService';
import { createRulesStore } from '../src/rulesStore';
import { createScanStore } from '../src/scanStore';
import { createExecutionJournal } from '../src/executionJournal';
import { executionHarness, fakeImmich, rawGroup, temporaryJournal, temporaryLog } from './fixtures';

const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
function exactHarness(t: TestContext) {
  const h = executionHarness();
  h.raw.assets.forEach((asset, index) => {
    asset.checksum = 'a'.repeat(40); asset.livePhotoVideoId = null;
    asset.exifInfo = { fileSizeInByte: 200 };
    asset.originalPath = index ? '/external/copies/photo.jpg' : '/external/originals/photo.jpg';
  });
  const rules = createRulesStore(), scan = createScanStore(), journal = temporaryJournal(t), log = temporaryLog(t);
  const service = createExecutionService({ client: h.client, ...scope, apiUrl: scope.apiUrl, journal, log, rules, scan, delay: h.delay });
  return { ...h, rules, scan, journal, log, service };
}

test('configured same-source pairs require fresh dry-run and journal v5 before verified fake resolution', async (t) => {
  const h = exactHarness(t);
  const state = await h.rules.get(scope);
  state.draft.rules[0].resolution = { field: 'originalPath', operator: 'prefix', value: '/external/originals', includeSubdirectories: true };
  await h.rules.publish(scope, state.draft);
  const { plan } = await h.service.preparePlan({ scanLimit: 10, executeLimit: 1, scan: { mode: 'groups' } });
  assert.equal(plan.candidates.length, 1);
  assert.equal(h.calls.filter((call) => call === 'groups').length, 1, 'full preparation uses one duplicate snapshot');
  assert.equal(plan.candidates[0].decision.keepAssetId, 'group-keep');
  await assert.rejects(h.service.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false }), /dry-run/);
  const dry = await h.service.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  assert.equal(dry.results[0]?.outcome, 'dry-run');
  assert.equal(h.journal.run(scope, dry.runId)?.version, 5);
  assert.deepEqual(h.mutations, []);
  const live = await h.service.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  assert.equal(live.results[0]?.outcome, 'succeeded');
  assert.deepEqual(h.mutations, ['add', 'resolve']);
  assert.equal(h.scan.getPending(scope).length, 0);
});

test('publishing rules invalidates full reviews, Quick upgrades and dry-run authorization', async (t) => {
  const h = exactHarness(t);
  // Original paths tie under seeded directories; choose an explicit keeper.
  const state = await h.rules.get(scope);
  state.draft.rules[0].resolution = { field: 'originalPath', operator: 'prefix', value: '/external/originals', includeSubdirectories: true };
  await h.rules.publish(scope, state.draft);
  const full = await h.service.preparePlan({ scanLimit: 1, executeLimit: 1 });
  const quick = await h.service.prepareQuickReview({ scanLimit: 1, executeLimit: 1 });
  await h.service.runReviewed(full.plan.planId, { selectedGroupIds: ['group'] });
  const changed = structuredClone(state.draft); changed.rules[0].name = 'New revision';
  await h.service.saveRules(changed, true);
  await assert.rejects(h.service.runReviewed(full.plan.planId, { selectedGroupIds: ['group'], dryRun: false }), /Rules changed/);
  await assert.rejects(h.service.selectAllReviewed(full.plan.planId), /Rules changed/);
  await assert.rejects(h.service.prepareQuickSelection(quick.quickReview!.reviewId, { selectedGroupIds: ['group'], executeLimit: 1 }), /Rules changed/);
  assert.deepEqual(h.mutations, []);
});

test('continued Quick scans bypass excluded front windows, survive restart/reorder and hydrate pending proposals', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'scan-integration-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  let groups = Array.from({ length: 8 }, (_, i) => rawGroup(`g${i}`));
  for (const [i, group] of groups.entries()) group.assets.forEach((asset, ai) => {
    asset.livePhotoVideoId = null; asset.checksum = i < 6 && ai ? 'b'.repeat(40) : 'a'.repeat(40);
    asset.exifInfo = { fileSizeInByte: 100 };
  });
  let listReads = 0, assetReads = 0;
  const client = fakeImmich({ getAssetDuplicates: async () => { listReads++; return structuredClone(groups); },
    getAssetInfo: async ({ id }) => { assetReads++; return structuredClone(groups.flatMap((group) => group.assets).find((asset) => asset.id === id)!); }, getAllAlbums: async () => [] });
  const rules = createRulesStore(), log = temporaryLog(t), journal = createExecutionJournal(path.join(directory, 'journal'));
  const make = () => createExecutionService({ client, apiUrl: scope.apiUrl, rules, scan: createScanStore({ filePath: path.join(directory, 'scan.json') }), log, journal, delay: async () => {} });
  let service = make();
  const first = await service.prepareQuickReview({ scanLimit: 3, executeLimit: 2, scan: { mode: 'groups' } });
  assert.equal(first.quickReview!.candidates.length, 0);
  const state = await rules.get(scope);
  const tested = await service.testRules(first.quickReview!.reviewId, state.draft);
  assert.equal(tested.results.length, 3, 'draft tests include excluded groups from the prepared snapshot');
  assert.equal(first.quickReview!.scan!.summary.remainingGroups, 5);
  groups = [...groups].reverse(); service = make();
  await service.prepareQuickReview({ scanLimit: 3, executeLimit: 2, scan: { mode: 'groups' } });
  const third = await service.prepareQuickReview({ scanLimit: 3, executeLimit: 2, scan: { mode: 'candidates', candidateTarget: 1 } });
  assert.equal(third.quickReview!.candidates.length, 1);
  assert.equal(third.quickReview!.scan!.preparation!.stopReason, 'target-reached');
  assert.equal(listReads, 3); assert.equal(assetReads, 0);
  const pending = await service.scanPending(); assert.equal(pending.pending.length, 1);
  const { plan } = await service.preparePending({ selectedGroupIds: [pending.pending[0].groupId], executeLimit: 1 });
  assert.equal(plan.candidates.length, 1); assert.ok(assetReads > 0);
  await assert.rejects(service.runReviewed(plan.planId, { selectedGroupIds: [pending.pending[0].groupId], dryRun: false }), /dry-run/);
});

test('cancelled continued scans flush completed classifications and leave unfinished groups available', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'scan-cancel-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const groups = Array.from({ length: 30 }, (_, index) => rawGroup(`cancel-${index}`));
  groups.forEach((group) => group.assets.forEach((asset, index) => {
    asset.checksum = (index ? 'a' : 'b').repeat(40); asset.exifInfo = { fileSizeInByte: 100 }; asset.livePhotoVideoId = null;
  }));
  const rules = createRulesStore(), scanPath = path.join(directory, 'scan.json');
  const service = createExecutionService({ client: fakeImmich({ getAssetDuplicates: async () => groups }), apiUrl: scope.apiUrl,
    rules, scan: createScanStore({ filePath: scanPath }), journal: temporaryJournal(t), log: temporaryLog(t) });
  const result = await service.prepareQuickReview({ scanLimit: 30, executeLimit: 5, scan: { mode: 'groups' } }, (progress) => {
    if (progress.checkedGroups === 3) service.cancelPreparation(progress.preparationId);
  });
  assert.equal(result.status, 'cancelled');
  assert.equal(result.quickReview!.fetchedGroups, 3);
  assert.equal(result.quickReview!.scan!.preparation!.stopReason, 'cancelled');
  const restored = createScanStore({ filePath: scanPath }).get(scope);
  assert.equal(restored.summary.visitedGroups, 3);
  assert.equal(restored.summary.remainingGroups, 27);
});

test('configured album conditions fetch album data in full review and remain deferred in Quick Review', async (t) => {
  const h = exactHarness(t); const state = await h.rules.get(scope);
  state.draft.rules[0].conditions = { field: 'albumId', operator: 'eq', value: 'missing', target: 'any' };
  state.draft.rules[0].resolution = { field: 'originalPath', operator: 'prefix', value: '/external/originals', includeSubdirectories: true };
  await h.rules.publish(scope, state.draft);
  const quick = await h.service.prepareQuickReview({ scanLimit: 1, executeLimit: 1 });
  assert.equal(quick.quickReview!.candidates.length, 0);
  assert.equal(quick.quickReview!.excludedGroups[0].reason, 'unverified');
  const full = await h.service.preparePlan({ scanLimit: 1, executeLimit: 1 });
  assert.equal(full.plan.candidates.length, 1);
});

test('production HTTP defaults to checksum rules and validates rule/scan requests', async (t) => {
  const h = exactHarness(t);
  const app = createApp({ immich: h.client, journal: h.journal, log: h.log, config: { IMMICH_URL: scope.apiUrl, IMMICH_API_KEY: 'fake' },
    fetch: async () => { throw new Error('Unexpected external fetch'); }, saveConnection: () => {} });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const rules = await (await fetch(`${base}/rules`)).json();
  assert.equal(rules.active.rules.filter((rule: { enabled: boolean }) => rule.enabled).length, 1);
  assert.equal(rules.active.rules[0].comparison, 'checksum');
  const invalid = await fetch(`${base}/rules/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ruleset: { schemaVersion: 1, rules: [{ enabled: true }] } }) });
  assert.equal(invalid.status, 400);
  const missingTarget = await fetch(`${base}/execution/quick-reviews`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scan: { mode: 'candidates' } }) });
  assert.equal(missingTarget.status, 400);
  assert.equal((await fetch(`${base}/execution/scan/pending`)).status, 200);
});
