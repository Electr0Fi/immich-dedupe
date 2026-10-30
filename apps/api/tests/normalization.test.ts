import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeDuplicates } from '../src/normalizeDuplicates';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import { rawGroup } from './fixtures';

for (const flag of ['isEdited', 'isTrashed', 'isFavorite', 'isArchived', 'isOffline']) {
  test(`normalization preserves missing ${flag} as unknown`, () => {
    const raw = rawGroup(); Reflect.deleteProperty(raw.assets[0], flag);
    const normalized = normalizeDuplicates([raw]).groups[0];
    assert.equal(Reflect.get(normalized.assets[0], flag), null);
    normalized.assets[0].fileSize = 200; normalized.assets[1].fileSize = 100;
    assert.equal(evaluateDuplicateGroup(normalized).status, 'uncertain');
  });
}

test('missing media type stays unknown; absent optional Live Photo link means no known link', () => {
  const raw = rawGroup(); Reflect.deleteProperty(raw.assets[0], 'type');
  const asset = normalizeDuplicates([raw]).groups[0].assets[0];
  assert.equal(asset.assetType, null); assert.equal(asset.livePhotoVideoId, null);
});
