import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createScanStore } from '../src/scanStore';
import { normalizeDuplicates } from '../src/normalizeDuplicates';
import { rawGroup } from './fixtures';

const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
test('pending metadata and separate rule reasons persist without changing proposal authority', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-pending-metadata-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'scan.json'); const store = createScanStore({ filePath });
  const group = normalizeDuplicates([rawGroup('group')]).groups[0];
  group.assets[0].fileSize = 4370785; group.assets[1].fileSize = 2038391;
  store.begin(scope, 'rules-1', [group]);
  store.record(scope, group.groupId, { status: 'eligible', keepAssetId: group.assets[0].id, trashAssetId: group.assets[1].id,
    comparisonClass: 'metadata', reason: 'Names match; dimensions match', ruleName: 'Keep larger copy', reasons: ['Names match; dimensions match', 'One keeper qualifies'] });
  const pending = store.getPending(scope)[0];
  assert.deepEqual(pending.keepMetadata, { fileSize: 4370785, width: 3000, height: 2000 });
  assert.deepEqual(pending.trashMetadata, { fileSize: 2038391, width: 3000, height: 2000 });
  assert.equal(pending.ruleName, 'Keep larger copy');
  assert.deepEqual(pending.reasons, ['Names match; dimensions match', 'One keeper qualifies']);
  assert.deepEqual(createScanStore({ filePath }).getPending(scope), [pending]);
  assert.equal(store.get(scope).summary.pendingCandidates, 1);
  assert.equal(store.get(scope).summary.remainingGroups, 0);
});

test('older pending proposals remain readable unchanged when display metadata is absent', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'immich-legacy-pending-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'scan.json'); const store = createScanStore({ filePath });
  const group = normalizeDuplicates([rawGroup('group')]).groups[0];
  store.begin(scope, 'rules-1', [group]);
  store.record(scope, group.groupId, { status: 'eligible', keepAssetId: group.assets[0].id, trashAssetId: group.assets[1].id, reason: 'Stored explanation' });
  const historical = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const proposal = historical.sessions[0].entries[0].pending;
  for (const field of ['keepMetadata', 'trashMetadata', 'ruleName', 'reasons']) delete proposal[field];
  const bytes = JSON.stringify(historical); fs.writeFileSync(filePath, bytes);
  const restored = createScanStore({ filePath }).getPending(scope)[0];
  assert.equal(restored.keepMetadata, undefined); assert.equal(restored.trashMetadata, undefined);
  assert.equal(restored.ruleName, undefined); assert.equal(restored.reasons, undefined);
  assert.equal(restored.reason, 'Stored explanation');
  assert.equal(fs.readFileSync(filePath, 'utf8'), bytes);
});

test('unavailable or invalid advisory display measurements remain unknown', () => {
  const store = createScanStore(); const group = normalizeDuplicates([rawGroup('group')]).groups[0];
  group.assets[0].fileSize = null; group.assets[0].width = 0; group.assets[0].height = -1;
  store.begin(scope, 'rules-1', [group]);
  store.record(scope, group.groupId, { status: 'eligible', keepAssetId: group.assets[0].id, trashAssetId: group.assets[1].id, reason: 'Advisory record' });
  assert.deepEqual(store.getPending(scope)[0].keepMetadata, { fileSize: null, width: null, height: null });
});
