import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import { readAlbumMembership, AlbumMembershipError } from '../src/albumMembership';
import { createDecisionExecutor } from '../src/executeDecision';
import { createExecutionService } from '../src/executionService';
import { reconcileAttempt } from '../src/reconcileAttempt';
import { executionHarness, group, temporaryJournal, temporaryLog, heuristicTestRules } from './fixtures';

function modernHarness() {
  const h = executionHarness(); const original = h.client.getAlbumInfo;
  h.client.getAlbumInfo = async (args) => {
    const response = await original(args);
    Reflect.deleteProperty(response, 'assets'); // Exact v3 album shape: metadata, no assets.
    return response;
  };
  return h;
}
const input = group(), decision = evaluateDuplicateGroup(input);

test('Immich v3 metadata-only albums verify transfers and existing memberships before resolution', async () => {
  const h = modernHarness();
  const result = await createDecisionExecutor(h.client, { delay: h.delay })(input, decision, false);
  assert.equal(result.outcome, 'succeeded'); assert.deepEqual(result.transferredAlbumIds, ['missing']);
  assert.deepEqual(h.mutations, ['add', 'resolve']);
  assert.ok(h.calls.indexOf('album:missing') < h.calls.indexOf('resolve'));
  assert.ok(h.calls.indexOf('album:shared') < h.calls.indexOf('resolve'));
});

test('a v3 keeper already in all required albums is verified without repeating album additions', async () => {
  const h = modernHarness();
  h.albums.get('missing')!.assets.push(h.assets.get('group-keep')!);
  const result = await createDecisionExecutor(h.client, { delay: h.delay })(input, decision, false);
  assert.equal(result.outcome, 'succeeded'); assert.deepEqual(result.proposedAlbumIds, []);
  assert.deepEqual(h.mutations, ['resolve']);
});

test('modern album dry-runs do not perform album additions or resolution', async () => {
  const h = modernHarness();
  const result = await createDecisionExecutor(h.client)(input, decision);
  assert.equal(result.outcome, 'dry-run'); assert.deepEqual(h.mutations, []);
});

test('a successful add response and album count cannot substitute for positive v3 keeper membership', async () => {
  const h = modernHarness(); h.client.addAssetsToAlbums = async () => ({ success: true });
  const result = await createDecisionExecutor(h.client)(input, decision, false);
  assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'album-verification');
  assert.deepEqual(result.transferredAlbumIds, []); assert.equal(h.calls.includes('resolve'), false);
});

for (const failure of ['permission', 'malformed', 'conflicting-names', 'renamed', 'absent'] as const) {
  test(`v3 membership verification fails closed after album mutation: ${failure}`, async () => {
    const h = modernHarness(); const lists = h.client.getAllAlbums, add = h.client.addAssetsToAlbums;
    let added = false;
    h.client.addAssetsToAlbums = async (args) => { const response = await add(args); added = true; return response; };
    h.client.getAllAlbums = async (args) => {
      if (!added || args.assetId !== 'group-keep') return lists(args);
      if (failure === 'permission') throw new Error('private SDK credential details');
      if (failure === 'malformed') return undefined as never;
      const values = await lists(args);
      if (failure === 'absent') return values.filter((album) => album.id !== 'missing');
      if (failure === 'renamed') return values.map((album) => ({ ...album, albumName: 'Different name' }));
      return [...values, { ...values[0], albumName: 'Conflicting name' }];
    };
    const result = await createDecisionExecutor(h.client)(input, decision, false);
    assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'album-verification');
    assert.equal(result.executed, false); assert.deepEqual(h.mutations, ['add']);
    assert.doesNotMatch(result.message, /private SDK/);
    if (failure === 'malformed') assert.match(result.message, /incomplete album membership response/);
  });
}

test('malformed embedded assets never fall back to a permissive membership response', async () => {
  const h = executionHarness(); const read = h.client.getAlbumInfo;
  h.client.getAlbumInfo = async (args) => { const value = await read(args); Reflect.set(value, 'assets', null); return value; };
  await assert.rejects(readAlbumMembership(h.client, 'shared', ['group-keep']), AlbumMembershipError);
});

test('wrong album identities never become confirmed through filtered memberships', async () => {
  const h = modernHarness(); const read = h.client.getAlbumInfo;
  h.client.getAlbumInfo = async (args) => ({ ...await read(args), id: 'another-album' });
  await assert.rejects(readAlbumMembership(h.client, 'shared', ['group-keep']), /Album identity changed/);
});

test('modern membership errors await every started read before rejecting', async () => {
  const h = modernHarness(); let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.client.getAllAlbums = async ({ assetId }) => {
    if (assetId === 'group-keep') throw new Error('Private upstream error');
    entered(); await waiting; return [];
  };
  let settled = false;
  const pending = readAlbumMembership(h.client, 'shared', ['group-keep', 'group-trash']);
  const checked = assert.rejects(pending, /Album memberships could not be read/).finally(() => { settled = true; });
  await started; await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false); release(); await checked;
});

test('v3 recovery rechecks the original quarantined attempt without replay and permits a separate freshly approved attempt', async (t) => {
  const h = modernHarness(), journal = temporaryJournal(t), log = temporaryLog(t);
  const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
  const rules = await heuristicTestRules(scope);
  const service = createExecutionService({ client: h.client, apiUrl: scope.apiUrl, journal, log, rules, delay: h.delay });
  const { plan } = await service.preparePlan({ scanLimit: 5, executeLimit: 1 });
  await service.runReviewed(plan.planId, { selectedGroupIds: ['group'] });
  const lists = h.client.getAllAlbums, add = h.client.addAssetsToAlbums;
  let hideKeeper = false;
  h.client.addAssetsToAlbums = async (args) => { const response = await add(args); hideKeeper = true; return response; };
  h.client.getAllAlbums = (args) => hideKeeper && args.assetId === 'group-keep' ? Promise.resolve([]) : lists(args);
  const live = await service.runReviewed(plan.planId, { selectedGroupIds: ['group'], dryRun: false });
  assert.equal(live.results[0].outcome, 'needs-verification'); assert.deepEqual(h.mutations, ['add']);
  const attemptId = live.results[0].attemptId!;
  const original = structuredClone(journal.attempt(scope, attemptId)!.attempt);
  h.client.getAllAlbums = async () => undefined as never;
  const inconclusive = await service.recheck(attemptId);
  assert.equal(inconclusive.assessments.at(-1)?.classification, 'inconclusive');
  assert.match(inconclusive.assessments.at(-1)!.message, /incomplete album membership response/);
  await assert.rejects(service.recheck(attemptId, true), /fresh intact eligible pair/);
  assert.deepEqual(h.mutations, ['add']);
  h.client.getAllAlbums = lists;
  hideKeeper = false; h.client.addAssetsToAlbums = add;
  const assessment = await service.recheck(attemptId);
  assert.equal(assessment.assessments.at(-1)?.classification, 'pair-intact');
  assert.equal(assessment.releasedAt, null); assert.deepEqual(h.mutations, ['add']);
  const released = await service.recheck(attemptId, true);
  assert.ok(released.releasedAt); assert.deepEqual(h.mutations, ['add']);
  assert.deepEqual(released.checkpoints, original.checkpoints); assert.deepEqual(released.result, original.result);
  const next = (await service.preparePlan({ scanLimit: 5, executeLimit: 1 })).plan;
  assert.equal(next.candidates.length, 1); assert.deepEqual(next.candidates[0].proposedAlbumIds, []);
  await assert.rejects(service.runReviewed(next.planId, { selectedGroupIds: ['group'], dryRun: false }), /dry-run/);
  await service.runReviewed(next.planId, { selectedGroupIds: ['group'] });
  const final = await service.runReviewed(next.planId, { selectedGroupIds: ['group'], dryRun: false });
  assert.equal(final.results[0].outcome, 'succeeded'); assert.deepEqual(h.mutations, ['add', 'resolve']);
  h.client.getAssetDuplicates = async () => []; // Immich no longer lists resolved groups.
  const resolved = await reconcileAttempt(h.client, original, h.delay);
  assert.equal(resolved.classification, 'verified-resolved'); assert.deepEqual(h.mutations, ['add', 'resolve']);
});
