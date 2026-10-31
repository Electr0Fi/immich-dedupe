import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConfigurableRule, KeeperPreference, ResolutionCondition, RuleSetDraft } from '@immich-dedupe/shared';
import { createRuleSet, evaluateConfiguredGroup, upgradeRuleSetDraft, assertRuleSetDraft } from '@immich-dedupe/rule-engine';
import { group, executionHarness, temporaryJournal, temporaryLog } from './fixtures';
import { createRulesStore } from '../src/rulesStore';
import { createExecutionService } from '../src/executionService';
import { createScanStore } from '../src/scanStore';
import { currentCandidateSchema } from '../src/reviewedPlan';
const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
const strict: ResolutionCondition = { all: [{ field: 'originalPath', operator: 'prefix', value: '/originals', includeSubdirectories: true }, { field: 'fileSize', operator: 'gt', compareTo: 'other' }] };
function rule(resolution = strict): ConfigurableRule { return { id: 'requirements', name: 'Preferred directory AND larger', enabled: true, action: 'include', comparison: 'metadata', acknowledgeHeuristic: true, conditions: { all: [] }, keeperPreferences: [], resolution }; }
function input() { const value = group(); value.assets[0].originalPath = '/originals/2026/photo.jpg'; value.assets[1].originalPath = '/copies/photo.jpg'; return value; }
function evaluate(resolution: ResolutionCondition, value = input()) { return evaluateConfiguredGroup(value, createRuleSet({ schemaVersion: 2, rules: [rule(resolution)] })); }

test('AND selects exactly the asset in the preferred subtree AND larger in bytes', () => {
  const decision = evaluate(strict); assert.equal(decision.outcome, 'eligible'); assert.equal(decision.keepAssetId, 'group-keep'); assert.equal(decision.resolution?.status, 'matched');
  const value = input(); value.assets[1].fileSize = 300;
  const conflict = evaluate(strict,value); assert.equal(conflict.outcome, 'excluded'); assert.equal(conflict.keepAssetId, null); assert.equal(conflict.resolution?.status, 'no-match');
  assert.equal(conflict.resolution?.assets.find((asset) => asset.id === 'group-keep')?.requirements[1].matches, false);
  assert.equal(conflict.resolution?.assets.find((asset) => asset.id === 'group-trash')?.requirements[0].matches, false);
});
test('OR is boolean rather than a priority: both matching and equal sizes remain excluded', () => {
  const value = input(); value.assets[1].fileSize = 300;
  assert.equal(evaluate({ any: 'all' in strict ? strict.all : [] },value).resolution?.status, 'ambiguous');
  value.assets[1].fileSize = value.assets[0].fileSize;
  assert.equal(evaluate(strict,value).resolution?.status, 'no-match');
  assert.equal(evaluate({ all: [{ any: [{ field: 'fileSize', operator: 'gt', compareTo: 'other' }] }, { field: 'originalPath', operator: 'prefix', value: '/originals' }] }).outcome, 'eligible');
});
test('directory conditions respect boundaries and explicit subdirectory inclusion', () => {
  assert.equal(evaluate({ field: 'originalPath', operator: 'prefix', value: '/originals', includeSubdirectories: false }).outcome, 'excluded');
  const value = input(); value.assets[0].originalPath = '/originals/photo.jpg';
  assert.equal(evaluate({ field: 'originalPath', operator: 'prefix', value: '/originals', includeSubdirectories: false },value).outcome, 'eligible');
  value.assets[0].originalPath = '/originals-backup/photo.jpg'; assert.equal(evaluate(strict,value).outcome, 'excluded');
});
test('unknown resolution metadata defers; false AND branches and true OR branches retain three-valued logic', () => {
  const missing: ResolutionCondition = { field: 'exif.model', operator: 'ne', value: 'Protected camera' };
  const decision = evaluate(missing); assert.equal(decision.outcome, 'deferred'); assert.equal(decision.resolution?.status, 'unverified'); assert.ok(decision.missingFields.some((field) => field.endsWith('exif.model')));
  assert.equal(evaluate({ all: [missing, { field: 'fileSize', operator: 'gt', value: 1000 }] }).resolution?.status, 'no-match');
  assert.equal(evaluate({ any: [missing, { field: 'fileSize', operator: 'gt', value: 0 }] }).resolution?.status, 'ambiguous');
});
test('a qualified rule with a resolution conflict cannot fall through to a permissive rule', () => {
  const value = input(); value.assets[1].fileSize = 300;
  const decision = evaluateConfiguredGroup(value,createRuleSet({ schemaVersion: 2, rules: [rule(), { ...rule({ field: 'fileSize', operator: 'gt', compareTo: 'other' }), id: 'fallback' }] }));
  assert.equal(decision.matchedRuleId, 'requirements'); assert.equal(decision.outcome, 'excluded');
});
test('content evidence and protected-asset guards cannot be bypassed by resolution requirements', () => {
  const checksum = { ...rule(), comparison: 'checksum' as const };
  const value = input(); value.assets.forEach((asset) => { asset.checksum = 'a'.repeat(40); asset.fileSize = 200; });
  assert.equal(evaluateConfiguredGroup(value,createRuleSet({ schemaVersion: 2, rules: [checksum] })).outcome, 'excluded');
  value.assets[1].fileSize = 100;
  assert.match(evaluateConfiguredGroup(value,createRuleSet({ schemaVersion: 2, rules: [checksum] })).reasons.join(' '), /inconsistent/);
  value.assets[0].isFavorite = true; assert.equal(evaluate(strict,value).outcome, 'excluded');
});
test('resolution validation rejects empty/malformed nodes, incompatible operators and excessive depth', () => {
  for (const resolution of [{}, { field: 'originalPath', operator: 'gt', compareTo: 'other' }, { field: 'fileSize', operator: 'gt', compareTo: 'other', value: 10 }, { all: [], any: [] }]) {
    assert.throws(() => assertRuleSetDraft({ schemaVersion: 2, rules: [{ ...rule(), resolution }] }));
  }
  let nested: ResolutionCondition = strict; for (let i=0;i<6;i++) nested = { all: [nested] };
  assert.throws(() => createRuleSet({ schemaVersion: 2, rules: [rule(nested)] }));
});
test('priority conversion preserves keeper choices and eligibility across ties, paths, dates and missing values', () => {
  const preferences: KeeperPreference[][] = [[], [{ field: 'directory', direction: 'lowest', directories: ['/originals','/copies'] }], [{ field: 'fileSize', direction: 'highest' }, { field: 'directory', direction: 'lowest', directories: ['/originals','/copies'] }], [{ field: 'directory', direction: 'lowest', directories: ['/originals','/copies'] }, { field: 'fileSize', direction: 'highest' }], [{ field: 'fileModifiedAt', direction: 'lowest' }, { field: 'pixelCount', direction: 'highest' }]];
  for (const prefs of preferences) {
    const legacy: RuleSetDraft = { schemaVersion: 1, rules: [{ ...rule(), resolution: undefined, keeperPreferences: prefs }] };
    delete legacy.rules[0].resolution;
    const old = createRuleSet(legacy), updated = createRuleSet(upgradeRuleSetDraft(legacy));
    for (const first of ['/originals/a.jpg','/copies/a.jpg','/other/a.jpg']) for (const second of ['/originals/b.jpg','/copies/b.jpg','/other/b.jpg']) for (const sizes of [[100,100],[100,200],[300,100]]) for (const date of [null,'2026-01-02T00:00:00Z']) {
      const value = input(); value.assets[0].originalPath = first; value.assets[1].originalPath = second; value.assets[0].fileSize = sizes[0]; value.assets[1].fileSize = sizes[1]; value.assets[0].fileModifiedAt = date;
      const a = evaluateConfiguredGroup(value,old), b = evaluateConfiguredGroup(value,updated);
      assert.equal(b.outcome === 'eligible',a.outcome === 'eligible'); assert.equal(b.keepAssetId,a.keepAssetId);
    }
  }
});
test('persisted presets and drafts upgrade once, preserve historical active evidence and require publication', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'resolution-upgrade-')); t.after(() => fs.rmSync(directory,{ recursive: true, force: true }));
  const filePath = path.join(directory,'rules.json');
  const legacy: RuleSetDraft = { schemaVersion: 1, rules: [{ ...rule(), keeperPreferences: [{ field: 'fileSize', direction: 'highest' }] }] }; delete legacy.rules[0].resolution;
  const original = createRuleSet(legacy);
  fs.writeFileSync(filePath,JSON.stringify({ version: 1, scopes: [{ scope, draft: legacy, activeRevision: original.revision, revisions: [original], savedPresets: [{ id:'00000000-0000-4000-8000-000000000001',name:'My original preset',ruleset:legacy,revision:4 }] }] }));
  const rules = createRulesStore({ filePath }); const upgraded = await rules.get(scope);
  assert.deepEqual(upgraded.active,original); assert.equal(upgraded.draft.schemaVersion,2); assert.equal(upgraded.savedPresets[0].revision,5); assert.equal(upgraded.savedPresets[0].name,'My original preset');
  assert.equal((await createRulesStore({ filePath }).get(scope)).savedPresets[0].revision,5);
  const h = executionHarness(), service = createExecutionService({ client:h.client,apiUrl:scope.apiUrl,rules,journal:temporaryJournal(t),log:temporaryLog(t),delay:h.delay });
  await assert.rejects(service.preparePlan({ scanLimit:1,executeLimit:1 }),/publish rules/);
  const published = await rules.publish(scope,upgraded.draft); assert.equal(published.active.engineVersion,'2');
  const prepared = await service.preparePlan({ scanLimit:1,executeLimit:1 }); assert.equal(prepared.plan.candidates.length,1);
  const candidate = structuredClone(prepared.plan.candidates[0]); candidate.decision = { ...candidate.decision, resolution: { status:'matched',assets:[] } } as typeof candidate.decision;
  assert.equal(currentCandidateSchema.safeParse(candidate).success,false);
});
test('conflicts persist across continued scans, but rules, changed metadata and journal blocking invalidate them', () => {
  const scan = createScanStore(), value = input(); value.assets[1].fileSize = 300;
  const decision = evaluate(strict,value); scan.begin(scope,'r1',[value]);
  scan.record(scope,value.groupId,{ status:'excluded',reason:decision.reasons.join('; '),resolution:decision.resolution,ruleName:'My rule',cacheable:false });
  scan.begin(scope,'r1',[value]); assert.equal(scan.get(scope).conflicts?.length,1);
  scan.begin(scope,'r1',[value],{blockedAssetIds:[value.assets[0].id]}); assert.equal(scan.get(scope).conflicts?.length,0);
  scan.begin(scope,'r1',[value]); scan.record(scope,value.groupId,{status:'excluded',reason:'conflict',resolution:decision.resolution,cacheable:true});
  scan.begin(scope,'r2',[value]); assert.equal(scan.get(scope).conflicts?.length,0);
  scan.record(scope,value.groupId,{status:'excluded',reason:'conflict',resolution:decision.resolution,cacheable:true});
  value.assets[0].fileSize = 500; scan.begin(scope,'r2',[value]); assert.equal(scan.get(scope).conflicts?.length,0);
});

test('full and Quick reviews propagate the same conflicts, retain them while scanning and clear them on changed evidence', async (t) => {
  const h = executionHarness(), rules = createRulesStore(), scan = createScanStore();
  h.raw.assets[0].originalPath = '/originals/photo.jpg'; h.raw.assets[0].exifInfo = {fileSizeInByte:100};
  h.raw.assets[1].originalPath = '/copies/photo.jpg'; h.raw.assets[1].exifInfo = {fileSizeInByte:300};
  await rules.publish(scope,{schemaVersion:2,rules:[rule()]});
  const service = createExecutionService({client:h.client,apiUrl:scope.apiUrl,rules,scan,journal:temporaryJournal(t),log:temporaryLog(t),delay:h.delay});
  const full = await service.preparePlan({scanLimit:1,executeLimit:1,scan:{mode:'groups'}});
  assert.equal(full.plan.candidates.length,0); assert.equal(full.plan.excludedGroups[0].resolution?.status,'no-match');
  const tested = await service.testRules(full.plan.planId,(await rules.get(scope)).draft);
  assert.equal(tested.results[0].resolution?.status,'no-match');
  const before = h.calls.filter((call) => call.startsWith('asset:')).length;
  const quick = await service.prepareQuickReview({scanLimit:1,executeLimit:1,scan:{mode:'groups'}});
  assert.deepEqual(quick.quickReview!.excludedGroups[0].resolution,full.plan.excludedGroups[0].resolution);
  assert.equal(h.calls.filter((call) => call.startsWith('asset:')).length,before);
  const next = await service.prepareQuickReview({scanLimit:1,executeLimit:1,scan:{mode:'groups'}});
  assert.equal(next.quickReview!.fetchedGroups,0); assert.equal(next.quickReview!.scan?.conflicts?.length,1);
  assert.equal((await service.scanPending()).conflicts.length,1);
  h.raw.assets[0].exifInfo = {fileSizeInByte:400};
  const changed = await service.prepareQuickReview({scanLimit:1,executeLimit:1,scan:{mode:'groups'}});
  assert.equal(changed.quickReview!.candidates.length,1); assert.equal((await service.scanPending()).conflicts.length,0);
  const rejected = input(); rejected.assets[1].fileSize = 500;
  const legacy = await service.run({dryRun:false,scanLimit:1,executeLimit:1},async () => ({groups:[rejected],decisions:[{...evaluate(strict,input()),groupId:rejected.groupId}]}));
  assert.equal(legacy.results.length,0); assert.deepEqual(h.mutations,[]);
});

test('resolution pair comparisons compare complete known album sets and preserve unknown membership', () => {
  const value = input(); value.assets.forEach((asset) => { asset.albumsKnown = true; asset.albums = [{albumId:'shared',albumName:'Shared'}]; });
  const expression: ResolutionCondition = {all:[{field:'albumId',operator:'same'},{field:'fileSize',operator:'gt',compareTo:'other'}]};
  assert.equal(evaluate(expression,value).outcome,'eligible');
  value.assets[1].albums = []; assert.equal(evaluate(expression,value).outcome,'excluded');
  value.assets[1].albumsKnown = false; assert.equal(evaluate(expression,value).outcome,'deferred');
});
