import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import type { DuplicateDecision } from '@immich-dedupe/shared';
import { createDecisionExecutor } from '../src/executeDecision';
import { createPlanExecutor } from '../src/executePlan';
import { fakeImmich, group, rawAsset, temporaryLog } from './fixtures';

const input = group();
const decision = evaluateDuplicateGroup(input);

test('dry-run proposes missing albums but calls no Immich operation', async () => {
  const result = await createDecisionExecutor(fakeImmich())(input, decision, true);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.executed, false);
  assert.equal(result.resolvedDuplicate, false);
  assert.equal(result.trashedAsset, false);
  assert.deepEqual(result.transferredAlbumIds, ['missing']);
  assert.deepEqual(result.skippedAlbumIds, ['shared']);
});

for (const [name, overrides] of Object.entries<Partial<DuplicateDecision>>({
  uncertain: { status: 'uncertain' }, confidence: { confidence: 40 },
  missingKeeper: { keepAssetId: null }, sameIds: { trashAssetIds: ['group-keep'] },
  multipleLosers: { trashAssetIds: ['group-trash', 'third'] },
  missingLoser: { trashAssetIds: ['not-in-group'] },
})) {
  test(`executor rejects ${name} before calling Immich`, async () => {
    const result = await createDecisionExecutor(fakeImmich())(input, { ...decision, ...overrides });
    assert.equal(result.executed, false);
    assert.match(result.message, /Safety guard failed/);
  });
}

test('executor rejects incorrect group size or source composition', async () => {
  const execute = createDecisionExecutor(fakeImmich());
  const changed = structuredClone(input); changed.assets[0].isExternal = false;
  assert.equal((await execute(changed, decision)).executed, false);
  changed.assets.pop();
  assert.equal((await execute(changed, decision)).executed, false);
});

test('transfers only missing albums, then resolves, then verifies the loser', async () => {
  const calls: string[] = [];
  const execute = createDecisionExecutor(fakeImmich({
    addAssetsToAlbums: async ({ albumsAddAssetsDto }) => {
      calls.push('albums');
      assert.deepEqual(albumsAddAssetsDto, { assetIds: ['group-keep'], albumIds: ['missing'] });
      return { success: true };
    },
    resolveDuplicates: async ({ duplicateResolveDto }) => {
      calls.push('resolve');
      assert.deepEqual(duplicateResolveDto.groups, [{ duplicateId: 'group', keepAssetIds: ['group-keep'], trashAssetIds: ['group-trash'] }]);
      return [{ id: 'group', success: true }];
    },
    getAssetInfo: async ({ id }) => {
      calls.push('verify'); assert.equal(id, 'group-trash');
      return rawAsset(id, { isTrashed: true, duplicateId: null });
    },
  }));
  const result = await execute(input, decision, false);
  assert.deepEqual(calls, ['albums', 'resolve', 'verify']);
  assert.equal(result.executed, true);
  assert.equal(result.resolvedDuplicate, true);
  assert.equal(result.trashedAsset, true);
});

test('an explicit untrashed response is not reported as successful', async () => {
  const execute = createDecisionExecutor(fakeImmich({
    addAssetsToAlbums: async () => ({ success: true }),
    resolveDuplicates: async () => [{ id: 'group', success: true }],
    getAssetInfo: async ({ id }) => rawAsset(id, { isTrashed: false }),
  }));
  const result = await execute(input, decision, false);
  assert.equal(result.executed, false);
  assert.equal(result.trashedAsset, false);
});

test('a thrown album transfer prevents resolution', async () => {
  const execute = createDecisionExecutor(fakeImmich({
    addAssetsToAlbums: async () => { throw new Error('Album unavailable'); },
  }));
  await assert.rejects(execute(input, decision, false), /Album unavailable/);
});

test('batch skips successfully processed groups and logs dry-runs without marking them processed', async (t) => {
  const log = temporaryLog(t);
  log.appendExecutionLog({ timestamp: new Date().toISOString(), groupId: 'processed', mode: 'execute',
    keepAssetId: 'processed-keep', trashAssetId: 'processed-trash', executed: true,
    resolvedDuplicate: true, trashedAsset: true, message: 'Done' });
  const groups = [group('processed'), group('pending'), group('beyond-limit')];
  const execute = createPlanExecutor({ executeDuplicateDecision: createDecisionExecutor(fakeImmich()), log });
  const results = await execute(groups, groups.map(evaluateDuplicateGroup), 1, true);
  assert.deepEqual(results.map((r) => r.groupId), ['pending']);
  assert.equal(log.loadExecutionLog().length, 2);
  assert.deepEqual([...log.getProcessedGroupIds()], ['processed']);
});

test('failed attempts count toward the batch limit; existing behavior continues to the next group', async (t) => {
  const log = temporaryLog(t);
  const groups = [group('first'), group('second'), group('third')];
  const execute = createPlanExecutor({
    log,
    executeDuplicateDecision: async (g, d, dryRun) => {
      if (g.groupId === 'first') throw new Error('Simulated failure');
      return createDecisionExecutor(fakeImmich())(g, d, dryRun);
    },
  });
  const results = await execute(groups, groups.map(evaluateDuplicateGroup), 2, true);
  assert.equal(results.length, 2);
  assert.equal(results[0].message, 'Simulated failure');
  assert.equal(results[1].groupId, 'second');
  assert.deepEqual(log.loadExecutionLog().map((e) => e.groupId), ['first', 'second']);
  assert.equal(log.getProcessedGroupIds().size, 0);
});

// Desired guarantees are intentionally pending until PR 2; do not bless the current defects.
test.todo('PR 2: a verification fetch exception must never count as successful trashing');
test.todo('PR 2: unsuccessful album-add response prevents duplicate resolution');
test.todo('PR 2: unsuccessful per-item resolution response cannot produce success');
