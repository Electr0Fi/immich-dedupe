import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRuleSet } from '@immich-dedupe/rule-engine';
import type { RecoveryAttempt, RuleSetDraft } from '@immich-dedupe/shared';
import { normalizeDuplicates } from '../src/normalizeDuplicates';
import { reconcileAttempt } from '../src/reconcileAttempt';
import { executionHarness } from './fixtures';

function setup() {
  const h = executionHarness();
  h.raw.assets[0].originalPath = '/external/preferred/photo.jpg';
  h.raw.assets[1].originalPath = '/external/other/photo.jpg';
  for (const asset of h.assets.values()) {
    asset.checksum = Buffer.alloc(20, 11).toString('base64');
    asset.exifInfo = { fileSizeInByte: 200 };
    asset.livePhotoVideoId = null;
  }
  const group = normalizeDuplicates([h.raw]).groups[0];
  group.assets.forEach((asset) => { asset.fileSize = 200; });
  const runId = randomUUID();
  const attempt: RecoveryAttempt = {
    runId, attemptId: randomUUID(), groupId: 'group', mode: 'execute',
    keepAssetId: 'group-keep', trashAssetId: 'group-trash', startedAt: new Date().toISOString(),
    checkpoints: [{ timestamp: new Date().toISOString(), event: { kind: 'preflight', snapshot: group.assets,
      requiredAlbumIds: ['missing', 'shared'], proposedAlbumIds: ['missing'], skippedAlbumIds: ['shared'] } }],
    result: null, assessments: [], releasedAt: null,
  };
  const draft: RuleSetDraft = { schemaVersion: 1, rules: [{
    id: 'exact', name: 'Identical files', enabled: true, action: 'include', comparison: 'checksum',
    acknowledgeHeuristic: false, conditions: { all: [] },
    keeperPreferences: [{ field: 'directory', direction: 'lowest', directories: ['/external/preferred', '/external/other'] }],
  }] };
  return { ...h, attempt, draft, ruleset: createRuleSet(draft) };
}

test('configured recovery verifies an intact same-source equal-size pair without mutations or rewriting evidence', async () => {
  const h = setup(), before = structuredClone(h.attempt);
  const assessment = await reconcileAttempt(h.client, h.attempt, h.delay, h.ruleset);
  assert.equal(assessment.classification, 'pair-intact');
  assert.deepEqual(h.mutations, []);
  assert.deepEqual(h.attempt, before);
  assert.ok(h.calls.includes('albums:group-keep'));
  assert.ok(h.calls.includes('albums:group-trash'));
});

test('historical recovery remains conservative without a configurable ruleset', async () => {
  const h = setup();
  const assessment = await reconcileAttempt(h.client, h.attempt, h.delay);
  assert.equal(assessment.classification, 'inconclusive');
  assert.deepEqual(h.mutations, []);
});

for (const change of ['rule-disabled', 'keeper-changed', 'protected', 'linkage-missing'] as const) {
  test(`configured recovery cannot release when ${change}`, async () => {
    const h = setup();
    if (change === 'rule-disabled') h.draft.rules[0].enabled = false;
    if (change === 'keeper-changed') h.draft.rules[0].keeperPreferences[0].directories!.reverse();
    if (change === 'protected') h.assets.get('group-keep')!.isFavorite = true;
    if (change === 'linkage-missing') delete h.assets.get('group-keep')!.livePhotoVideoId;
    const assessment = await reconcileAttempt(h.client, h.attempt, h.delay, createRuleSet(h.draft));
    assert.equal(assessment.classification, 'inconclusive');
    assert.deepEqual(h.mutations, []);
  });
}

test('configured recovery evaluates album rules using current album reads', async () => {
  const h = setup();
  h.draft.rules[0].conditions = { field: 'albumId', operator: 'eq', value: 'missing', target: 'trash' };
  const assessment = await reconcileAttempt(h.client, h.attempt, h.delay, createRuleSet(h.draft));
  assert.equal(assessment.classification, 'pair-intact');
  assert.deepEqual(h.mutations, []);
});

test('configured recovery preserves original required album evidence', async () => {
  const h = setup(); h.albums.get('missing')!.assets = [];
  const assessment = await reconcileAttempt(h.client, h.attempt, h.delay, h.ruleset);
  assert.equal(assessment.classification, 'inconclusive');
  assert.match(assessment.message, /Original album memberships/);
  assert.deepEqual(h.mutations, []);
});

test('verified resolution remains observable when the current rule no longer includes the pair', async () => {
  const h = setup();
  h.assets.get('group-trash')!.isTrashed = true;
  h.assets.get('group-trash')!.duplicateId = null;
  h.assets.get('group-keep')!.duplicateId = null;
  h.albums.get('missing')!.assets.push(h.assets.get('group-keep')!);
  h.client.getAssetDuplicates = async () => [];
  h.draft.rules[0].enabled = false;
  const assessment = await reconcileAttempt(h.client, h.attempt, h.delay, createRuleSet(h.draft));
  assert.equal(assessment.classification, 'verified-resolved');
  assert.deepEqual(h.mutations, []);
  assert.equal(h.attempt.result, null);
});
