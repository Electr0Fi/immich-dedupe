import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app';
import { upgradeResolutionDraft } from '@immich-dedupe/shared';
import { createDefaultRuleSetDraft, assertRuleSetDraft } from '@immich-dedupe/rule-engine';
import { saveRulePresetSchema } from '../src/rulesStore';
import { fakeImmich, temporaryJournal, temporaryLog } from './fixtures';

test('preset HTTP API validates explicit overwrite/delete requests and never publishes or mutates Immich', async (t) => {
  const app = createApp({ immich: fakeImmich(), journal: temporaryJournal(t), log: temporaryLog(t),
    config: { IMMICH_URL: 'https://immich.invalid/api', IMMICH_API_KEY: 'fake' },
    fetch: async () => { throw new Error('Unexpected external fetch'); }, saveConnection: () => { throw new Error('Unexpected settings write'); } });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => { server.close((error) => error ? reject(error) : resolve()); server.closeAllConnections(); }));
  await once(server, 'listening'); const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const initial = await (await fetch(`${base}/rules`)).json();
  const request = (url: string, method: string, body: unknown) => fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await request('/rules/presets', 'POST', { name: ' ', ruleset: initial.draft })).status, 400);
  const ruleset = structuredClone(initial.draft); ruleset.rules[0].name = 'Edited rule';
  const createdResponse = await request('/rules/presets', 'POST', { name: 'My preset', ruleset });
  assert.equal(createdResponse.status, 200); const created = await createdResponse.json();
  const preset = created.savedPresets.find((entry: { name: string }) => entry.name === 'My preset');
  assert.deepEqual(preset.ruleset, ruleset); assert.deepEqual(created.active, initial.active); assert.deepEqual(created.draft, initial.draft);
  assert.equal((await request('/rules/presets', 'POST', { name: 'My preset', ruleset })).status, 409);
  assert.equal((await request('/rules/presets', 'POST', { name: 'My preset', ruleset, overwriteId: preset.id })).status, 400);
  const overwritten = await (await request('/rules/presets', 'POST', { name: 'My preset', ruleset, overwriteId: preset.id, expectedRevision: 1 })).json();
  assert.equal(overwritten.savedPresets.find((entry: { id: string }) => entry.id === preset.id).revision, 2);
  assert.equal((await request(`/rules/presets/${preset.id}`, 'DELETE', { expectedRevision: 1 })).status, 409);
  assert.equal((await request('/rules/presets/not-an-id', 'DELETE', { expectedRevision: 2 })).status, 400);
  const deleted = await request(`/rules/presets/${preset.id}`, 'DELETE', { expectedRevision: 2 });
  assert.equal(deleted.status, 200); const final = await deleted.json();
  assert.equal(final.savedPresets.some((entry: { id: string }) => entry.id === preset.id), false);
  assert.deepEqual(final.active, initial.active); assert.deepEqual(final.draft, initial.draft);

  // Removing templates and choosing a new name needs no overwrite credentials.
  const reduced = structuredClone(initial.draft); reduced.rules = reduced.rules.slice(0, 1);
  reduced.rules[0].name = 'Only the remaining rule';
  const reducedResponse = await request('/rules/presets', 'POST', { name: 'Reduced rules', ruleset: reduced });
  assert.equal(reducedResponse.status, 200);
  const reducedState = await reducedResponse.json();
  assert.deepEqual(reducedState.savedPresets.find((entry: { name: string }) => entry.name === 'Reduced rules').ruleset, reduced);
  assert.deepEqual(reducedState.active, initial.active); assert.deepEqual(reducedState.draft, initial.draft);

  reduced.rules[0].comparison = 'metadata'; reduced.rules[0].acknowledgeHeuristic = false;
  const invalid = await request('/rules/presets', 'POST', { name: 'Needs acknowledgement', ruleset: reduced });
  assert.equal(invalid.status, 400);
  const diagnostic = await invalid.json();
  assert.match(diagnostic.error, /Rule 1: Enable heuristic acknowledgement/);
  assert.doesNotMatch(diagnostic.error, /overwrite/i);
  assert.deepEqual(diagnostic.issues[0].path, ['ruleset', 'rules', 0]);
});

test('retained legacy editor state upgrades without losing new requirements or weakening server validation', () => {
  const draft = createDefaultRuleSetDraft(); draft.rules = draft.rules.slice(0, 1);
  draft.rules[0].resolution = { all: [{ field: 'originalPath', operator: 'prefix', value: '/originals' }, { field: 'fileSize', operator: 'gt', compareTo: 'other' }] };
  assert.throws(() => assertRuleSetDraft(draft), /Unknown rules configuration property/);
  assert.equal(saveRulePresetSchema.safeParse({ name: 'New name', ruleset: draft }).success, false);
  const upgraded = upgradeResolutionDraft(draft);
  assert.equal(saveRulePresetSchema.safeParse({ name: 'New name', ruleset: upgraded }).success, true);
  assert.equal(upgraded.schemaVersion, 2);
  assert.deepEqual(upgraded.rules[0].resolution, draft.rules[0].resolution);
  assert.deepEqual(upgraded.rules[0].keeperPreferences, []);
  assert.equal(draft.schemaVersion, 1); assert.notEqual(draft.rules[0].keeperPreferences.length, 0);
});
