import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import type { DuplicateDecision } from '@immich-dedupe/shared';
import type { ImmichClient } from '../src/immichClient';
import { createDecisionExecutor } from '../src/executeDecision';
import { fakeImmich, group, executionHarness } from './fixtures';

const input = group();
const decision = evaluateDuplicateGroup(input);
function setup() {
  const harness = executionHarness();
  return { ...harness, execute: createDecisionExecutor(harness.client, { delay: harness.delay }) };
}

test('omitted executor mode is dry-run: fresh reads, proposed albums, no mutation', async () => {
  const h = setup(); const result = await h.execute(input, decision);
  assert.equal(result.mode, 'dry-run'); assert.equal(result.outcome, 'dry-run');
  assert.equal(result.executed, false); assert.equal(result.failureStage, null);
  assert.deepEqual(result.proposedAlbumIds, ['missing']);
  assert.deepEqual(result.transferredAlbumIds, []); assert.deepEqual(result.skippedAlbumIds, ['shared']);
  assert.deepEqual(h.mutations, []);
  assert.ok(h.calls.includes('groups') && h.calls.includes('asset:group-trash'));
});

for (const [name, overrides] of Object.entries<Partial<DuplicateDecision>>({
  uncertain: { status: 'uncertain' }, confidence: { confidence: 40 },
  missingKeeper: { keepAssetId: null }, sameIds: { trashAssetIds: ['group-keep'] },
  multipleLosers: { trashAssetIds: ['group-trash', 'third'] }, missingLoser: { trashAssetIds: ['missing'] },
  differentGroup: { groupId: 'other' }, reversedSelection: { keepAssetId: 'group-trash', trashAssetIds: ['group-keep'] },
})) {
  test(`executor rejects ${name} before SDK access`, async () => {
    const result = await createDecisionExecutor(fakeImmich())(input, { ...decision, ...overrides }, false);
    assert.equal(result.outcome, 'failed'); assert.equal(result.failureStage, 'preflight');
    assert.match(result.message, /Safety guard failed/);
  });
}

test('successful execution transfers, confirms all albums, resolves once, and verifies both assets', async () => {
  const h = setup(); const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'succeeded'); assert.equal(result.executed, true);
  assert.equal(result.resolvedDuplicate, true); assert.equal(result.trashedAsset, true);
  assert.deepEqual(result.proposedAlbumIds, ['missing']); assert.deepEqual(result.transferredAlbumIds, ['missing']);
  assert.deepEqual(h.mutations, ['add', 'resolve']);
  assert.ok(h.calls.indexOf('add') < h.calls.indexOf('album:missing'));
  assert.ok(h.calls.indexOf('album:missing') < h.calls.indexOf('resolve'));
  assert.ok(h.calls.indexOf('album:shared') < h.calls.indexOf('resolve'));
  assert.deepEqual(h.delays, []);
});

test('changed group membership prevents all mutation', async () => {
  for (const change of ['missing', 'third', 'duplicate', 'replacement']) {
    const h = setup();
    if (change === 'missing') h.client.getAssetDuplicates = async () => [];
    if (change === 'third') h.raw.assets.push({ ...h.raw.assets[0], id: 'third' });
    if (change === 'duplicate') h.raw.assets[1] = h.raw.assets[0];
    if (change === 'replacement') h.raw.assets[1] = { ...h.raw.assets[1], id: 'replacement' };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'failed', change); assert.deepEqual(h.mutations, []);
  }
});

const changes = {
  name: { originalFileName: 'different.jpg' }, resolution: { width: 100 },
  source: { originalPath: '/unknown/image.jpg' }, size: { exifInfo: { fileSizeInByte: 300 } },
  membership: { duplicateId: 'other' }, favorite: { isFavorite: true }, archived: { isArchived: true },
  offline: { isOffline: true }, edited: { isEdited: true }, trashed: { isTrashed: true },
  livePhoto: { livePhotoVideoId: 'linked-video' },
};
for (const [name, update] of Object.entries(changes)) {
  test(`fresh ${name} changes override previously eligible data`, async () => {
    const h = setup(); Object.assign(h.assets.get('group-trash')!, update);
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'failed'); assert.equal(result.failureStage, 'preflight');
    assert.deepEqual(h.mutations, []);
  });
}

test('fresh album memberships override stale proposals, including shared albums', async () => {
  const h = setup(); h.albums.delete('missing');
  h.albums.set('new-shared', { ...h.albums.get('shared')!, id: 'new-shared', assets: [h.assets.get('group-trash')!] });
  const list = h.client.getAllAlbums;
  h.client.getAllAlbums = async (args) => args.shared ? (await list(args)).filter((a) => a.id === 'new-shared') :
    (await list(args)).filter((a) => a.id !== 'new-shared');
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'succeeded');
  assert.deepEqual(result.proposedAlbumIds, ['new-shared']);
  assert.deepEqual(result.transferredAlbumIds, ['new-shared']);
});

test('unknown or malformed safety information fails without mutation', async () => {
  for (const field of ['isFavorite', 'isArchived', 'isEdited', 'isTrashed', 'isOffline', 'type', 'duplicateId']) {
    const h = setup();
    const get = h.client.getAssetInfo;
    h.client.getAssetInfo = async (args) => {
      const value = await get(args); Reflect.deleteProperty(value, field); return value;
    };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'failed', field); assert.deepEqual(h.mutations, []);
  }
});

test('malformed album listing is not interpreted as no memberships', async () => {
  const h = setup();
  h.client.getAllAlbums = async () => null as unknown as Awaited<ReturnType<ImmichClient['getAllAlbums']>>;
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'failed'); assert.deepEqual(h.mutations, []);
});

test('unsuccessful album-add response prevents resolution and retains confirmed partial changes', async () => {
  const h = setup(); const add = h.client.addAssetsToAlbums;
  h.client.addAssetsToAlbums = async (args) => { await add(args); return { success: false }; };
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'album-transfer');
  assert.deepEqual(result.transferredAlbumIds, ['missing']); assert.deepEqual(h.mutations, ['add']);
});

test('album-add exception is uncertainty, not successful preservation', async () => {
  const h = setup(); h.client.addAssetsToAlbums = async () => { throw new Error('Transfer timeout'); };
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'needs-verification'); assert.equal(result.executed, false);
  assert.equal(result.failureStage, 'album-transfer'); assert.deepEqual(h.mutations, []);
});

for (const mode of ['absent', 'wrong-id', 'malformed', 'error']) {
  test(`unconfirmed album membership (${mode}) prevents resolution`, async () => {
    const h = setup(); const read = h.client.getAlbumInfo;
    h.client.getAlbumInfo = async (args) => {
      const value = await read(args);
      if (mode === 'error') throw new Error('Album inaccessible');
      if (mode === 'absent') value.assets = [];
      if (mode === 'wrong-id') value.id = 'wrong';
      if (mode === 'malformed') Reflect.deleteProperty(value, 'assets');
      return value;
    };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'album-verification');
    assert.deepEqual(h.mutations, ['add']);
  });
}

for (const mode of ['unsuccessful', 'empty', 'malformed', 'throw']) {
  test(`resolution response ${mode} is never reported as success`, async () => {
    const h = setup();
    h.client.resolveDuplicates = async () => {
      h.mutations.push('resolve');
      if (mode === 'throw') throw new Error('Resolution timeout');
      if (mode === 'empty') return [];
      if (mode === 'malformed') return null as unknown as Awaited<ReturnType<ImmichClient['resolveDuplicates']>>;
      return [{ id: 'group', success: false }];
    };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'resolution');
    assert.equal(result.executed, false); assert.deepEqual(result.transferredAlbumIds, ['missing']);
    assert.deepEqual(h.mutations, ['add', 'resolve']);
  });
}

for (const mode of ['404', '401', 'network', 'untrashed', 'associated', 'keeper-trashed', 'keeper-missing-flag', 'loser-missing-flag']) {
  test(`verification ${mode} never counts as success or retries a mutation`, async () => {
    const h = setup(); const read = h.client.getAssetInfo;
    h.client.getAssetInfo = async (args) => {
      const value = await read(args);
      if (h.mutations.includes('resolve')) {
        if (['404', '401', 'network'].includes(mode)) throw new Error(mode);
        if (args.id === 'group-trash') {
          if (mode === 'untrashed') value.isTrashed = false;
          if (mode === 'associated') value.duplicateId = 'group';
          if (mode === 'loser-missing-flag') Reflect.deleteProperty(value, 'isTrashed');
        }
        if (args.id === 'group-keep') {
          if (mode === 'keeper-trashed') value.isTrashed = true;
          if (mode === 'keeper-missing-flag') Reflect.deleteProperty(value, 'isTrashed');
        }
      }
      return value;
    };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'verification');
    assert.equal(result.executed, false); assert.deepEqual(h.delays, [1000, 1000]);
    assert.deepEqual(h.mutations, ['add', 'resolve']);
  });
}

test('delayed postconditions can succeed on the third verification read', async () => {
  const h = setup(); const read = h.client.getAssetInfo; let rounds = 0;
  h.client.getAssetInfo = async (args) => {
    const value = await read(args);
    if (h.mutations.includes('resolve') && args.id === 'group-trash' && ++rounds < 3) value.isTrashed = false;
    return value;
  };
  assert.equal((await h.execute(input, decision, false)).outcome, 'succeeded');
  assert.equal(rounds, 3); assert.deepEqual(h.delays, [1000, 1000]);
  assert.deepEqual(h.mutations, ['add', 'resolve']);
});

test('a changed keeper selection is rejected rather than silently substituted', async () => {
  const h = setup();
  Object.assign(h.assets.get('group-keep')!, { originalPath: '/photos/internal/photo.jpg', exifInfo: { fileSizeInByte: 100 } });
  Object.assign(h.assets.get('group-trash')!, { originalPath: '/external/photo.jpg', exifInfo: { fileSizeInByte: 200 } });
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'failed'); assert.deepEqual(h.mutations, []);
});

test('partial album additions followed by a timeout retain positively confirmed memberships', async () => {
  const h = setup(); const add = h.client.addAssetsToAlbums;
  h.client.addAssetsToAlbums = async (args) => { await add(args); throw new Error('Response lost'); };
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'needs-verification'); assert.equal(result.failureStage, 'album-transfer');
  assert.deepEqual(result.transferredAlbumIds, ['missing']); assert.deepEqual(h.mutations, ['add']);
});

test('positive loser evidence survives later read failures, without producing success', async () => {
  const h = setup(); const read = h.client.getAssetInfo; let reads = 0;
  h.client.getAssetInfo = async (args) => {
    if (h.mutations.includes('resolve')) {
      if (args.id === 'group-keep' || ++reads > 1) throw new Error('Verification unavailable');
    }
    return read(args);
  };
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'needs-verification'); assert.equal(result.executed, false);
  assert.equal(result.trashedAsset, true); assert.equal(result.resolvedDuplicate, true);
});

test('no-album execution does not submit an unnecessary album addition', async () => {
  const h = setup(); h.albums.clear();
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'succeeded'); assert.deepEqual(h.mutations, ['resolve']);
});

test('unconfirmed existing memberships block resolution even with no proposed additions', async () => {
  const h = setup(); h.albums.delete('missing');
  h.client.getAlbumInfo = async () => { throw new Error('Album inaccessible'); };
  const result = await h.execute(input, decision, false);
  assert.equal(result.outcome, 'failed'); assert.equal(result.failureStage, 'album-verification');
  assert.deepEqual(h.mutations, []);
});

test('fresh EXIF dimensions can supply known resolution when top-level dimensions are null', async () => {
  const h = setup();
  for (const asset of h.assets.values()) {
    asset.width = null; asset.height = null;
    asset.exifInfo = { ...asset.exifInfo, exifImageWidth: 3000, exifImageHeight: 2000 };
  }
  assert.equal((await h.execute(input, decision, false)).outcome, 'succeeded');
});

for (const value of ['', 'not-a-number', 'Infinity', '-1', '0']) {
  test(`fresh invalid size ${JSON.stringify(value)} cannot authorize cleanup`, async () => {
    const h = setup(); const read = h.client.getAssetInfo;
    h.client.getAssetInfo = async (args) => {
      const asset = await read(args);
      if (args.id === 'group-trash') Reflect.set(asset.exifInfo!, 'fileSizeInByte', value);
      return asset;
    };
    const result = await h.execute(input, decision, false);
    assert.equal(result.outcome, 'failed'); assert.deepEqual(h.mutations, []);
  });
}
