import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import type { DuplicateGroup } from '@immich-dedupe/shared';
import { group } from './fixtures';

test('eligible pair keeps the larger external original, regardless of input order', () => {
  const input = group();
  const before = structuredClone(input);
  const decision = evaluateDuplicateGroup(input);
  assert.equal(decision.status, 'auto-resolve');
  assert.equal(decision.confidence, 100);
  assert.equal(decision.keepAssetId, 'group-keep');
  assert.deepEqual(decision.trashAssetIds, ['group-trash']);
  assert.deepEqual(input, before, 'evaluation must not mutate input');
  input.assets.reverse();
  assert.deepEqual(evaluateDuplicateGroup(input), decision);
});

const cases: Array<[string, (input: DuplicateGroup) => void, string, number]> = [
  ['missing size', (g) => { g.assets[0].fileSize = null; }, 'uncertain', 40],
  ['equal sizes', (g) => { g.assets[0].fileSize = 100; }, 'uncertain', 10],
  ['smaller external', (g) => { g.assets[0].fileSize = 50; }, 'uncertain', 10],
  ['different name', (g) => { g.assets[0].fileName = 'other.jpg'; }, 'uncertain', 10],
  ['different resolution', (g) => { g.assets[0].width = 1000; }, 'skip', 0],
  ['unknown resolution', (g) => { g.assets[0].height = null; }, 'skip', 0],
  ['edited asset', (g) => { g.assets[1].isEdited = true; }, 'uncertain', 10],
  ['trashed asset', (g) => { g.assets[0].isTrashed = true; }, 'uncertain', 10],
  ['unknown source', (g) => { g.assets[0].isExternal = false; }, 'uncertain', 10],
  ['three assets', (g) => { g.assets.push({ ...g.assets[0], id: 'third' }); }, 'uncertain', 10],
];
for (const [name, change, status, confidence] of cases) {
  test(`does not auto-resolve: ${name}`, () => {
    const input = group(); change(input);
    const decision = evaluateDuplicateGroup(input);
    assert.equal(decision.status, status);
    assert.equal(decision.confidence, confidence);
    assert.equal(decision.keepAssetId, null);
    assert.deepEqual(decision.trashAssetIds, []);
  });
}

test('filename comparison trims whitespace and ignores case', () => {
  const input = group(); input.assets[0].fileName = ' PHOTO.JPG ';
  assert.equal(evaluateDuplicateGroup(input).status, 'auto-resolve');
});
