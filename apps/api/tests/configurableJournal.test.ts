import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { evaluateDuplicateGroup, evaluateConfiguredGroup, createRuleSet } from '@immich-dedupe/rule-engine';
import type { ReviewedCandidate, RuleSetDraft } from '@immich-dedupe/shared';
import { candidateFromGroup, candidateToGroup, configurableCandidateSchema, reviewedCandidateSchema, currentCandidateSchema, changedCandidate } from '../src/reviewedPlan';
import { createExecutionJournal, type JournalRun } from '../src/executionJournal';
import { group } from './fixtures';

const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
const draft: RuleSetDraft = { schemaVersion: 1, rules: [{
  id: 'exact', name: 'Exact files in preferred directory', enabled: true, action: 'include',
  comparison: 'checksum', acknowledgeHeuristic: false, conditions: { field: 'fileSize', operator: 'same' },
  keeperPreferences: [{ field: 'directory', direction: 'lowest', directories: ['/preferred', '/other'] }],
}] };
function configured() {
  const assets = group();
  assets.assets[0].originalPath = '/preferred/photo.jpg';
  assets.assets[1].originalPath = '/other/photo.jpg';
  for (const asset of assets.assets) {
    asset.checksum = Buffer.alloc(20, 7).toString('base64'); asset.fileSize = 200;
    // Same-source copies are intentional: the configured rule is directory-based.
    asset.isExternal = true; asset.isInternal = false;
  }
  const ruleset = createRuleSet(draft);
  const decision = evaluateConfiguredGroup(assets, ruleset);
  assert.equal(decision.status, 'auto-resolve');
  return candidateFromGroup(assets, decision, ruleset);
}
function setup(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'immich-configured-journal-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journal = createExecutionJournal(directory);
  journal.migrate(scope, () => []);
  return { directory, journal };
}
function run(candidate: ReviewedCandidate, version: 3 | 4 = 4): JournalRun {
  const now = new Date().toISOString();
  return {
    version, runId: randomUUID(), scope, startedAt: now, finishedAt: null, attempts: [],
    context: { dryRun: true, scanLimit: 100, executeLimit: 5, source: 'batch', groupId: null }, report: null,
    review: { planId: randomUUID(), createdAt: now, expiresAt: new Date(Date.parse(now) + 900000).toISOString(),
      selectedGroupIds: [candidate.groupId], candidates: [candidate], authorizingDryRunId: null },
  };
}

test('configured evidence supports directory-selected same-source pairs without changing historical semantics', () => {
  const candidate = configured();
  assert.equal(configurableCandidateSchema.safeParse(candidate).success, true, JSON.stringify(configurableCandidateSchema.safeParse(candidate)));
  assert.equal(currentCandidateSchema.safeParse(candidate).success, true);
  assert.equal(reviewedCandidateSchema.safeParse(candidate).success, false);
  const historicalGroup = group();
  const historical = candidateFromGroup(historicalGroup, evaluateDuplicateGroup(historicalGroup));
  assert.equal(reviewedCandidateSchema.safeParse(historical).success, true);
  assert.equal(currentCandidateSchema.safeParse(historical).success, true);
});

test('configured evidence rejects altered rules, decisions, metadata and album actions', () => {
  const original = configured();
  for (const mutate of [
    (candidate: ReviewedCandidate) => { candidate.ruleset!.rules[0].name = 'Tampered'; },
    (candidate: ReviewedCandidate) => { candidate.decision.keepAssetId = candidate.trashAsset.id; },
    (candidate: ReviewedCandidate) => { candidate.ruleAssets![0].fileSize = 1; },
    (candidate: ReviewedCandidate) => { candidate.proposedAlbumIds = ['tampered']; },
    (candidate: ReviewedCandidate) => { candidate.ruleAssets![0].isFavorite = true; },
  ]) {
    const altered = structuredClone(original); mutate(altered);
    assert.equal(configurableCandidateSchema.safeParse(altered).success, false);
    assert.ok(changedCandidate(original, altered).length > 0);
  }
});

test('configured evidence is reproducible when upstream returns the keeper second', () => {
  const original = configured();
  const reversed = candidateToGroup(original); reversed.assets.reverse();
  const decision = evaluateConfiguredGroup(reversed, original.ruleset!);
  const actual = candidateFromGroup(reversed, decision, original.ruleset);
  assert.deepEqual(changedCandidate(original, actual), []);
  assert.equal(configurableCandidateSchema.safeParse(actual).success, true);
});

test('a satisfied OR branch can be journaled while retaining unknown observations', () => {
  const original = configured();
  const rules = structuredClone(draft);
  rules.rules[0].conditions = { any: [{ field: 'fileName', operator: 'same' }, { field: 'exif.model', operator: 'same' }] };
  const ruleset = createRuleSet(rules), assets = candidateToGroup(original);
  const decision = evaluateConfiguredGroup(assets, ruleset);
  assert.equal(decision.status, 'auto-resolve');
  assert.deepEqual(decision.observedValues['exif.model'], [null, null]);
  const candidate = candidateFromGroup(assets, decision, ruleset);
  assert.equal(configurableCandidateSchema.safeParse(candidate).success, true);
});

test('v4 survives restart alongside historical v1/v2/v3 records without rewriting them', (t) => {
  const { directory, journal } = setup(t);
  const configuredRun = run(configured()); journal.save(configuredRun);
  const assets = group(), historical = candidateFromGroup(assets, evaluateDuplicateGroup(assets));
  const old = run(historical, 3); journal.save(old);
  const legacy1: JournalRun = { version: 1, runId: randomUUID(), scope, startedAt: old.startedAt, finishedAt: null, attempts: [] };
  const legacy2: JournalRun = { version: 2, runId: randomUUID(), scope, startedAt: old.startedAt, finishedAt: null, attempts: [], context: { dryRun: true, scanLimit: 100, executeLimit: 5, source: 'batch', groupId: null }, report: null };
  journal.save(legacy1); journal.save(legacy2);
  const before = fs.readFileSync(path.join(directory, `${old.runId}.json`), 'utf8');
  const restarted = createExecutionJournal(directory);
  assert.deepEqual(restarted.runs(scope).map((record) => record.version).sort(), [1, 2, 3, 4]);
  assert.equal(fs.readFileSync(path.join(directory, `${old.runId}.json`), 'utf8'), before);
});

test('v4 rejects mutation of pinned review evidence after initial save', (t) => {
  const { journal } = setup(t); const record = run(configured()); journal.save(record);
  if (record.version !== 4) assert.fail('Expected v4');
  record.review.candidates[0].ruleset!.rules[0].name = 'Changed after checkpoint';
  assert.throws(() => journal.save(record));
});

test('v4 live runs require a successful exact v4 dry-run including its pinned rules', (t) => {
  const { journal } = setup(t);
  const dry = run(configured());
  if (dry.version !== 4) assert.fail('Expected v4');
  const candidate = dry.review.candidates[0], attemptId = randomUUID();
  dry.attempts = [{ attemptId, runId: dry.runId, groupId: candidate.groupId, mode: 'dry-run',
    keepAssetId: candidate.keepAsset.id, trashAssetId: candidate.trashAsset.id, startedAt: dry.startedAt,
    checkpoints: [{ timestamp: dry.startedAt, event: { kind: 'preflight', snapshot: candidate.ruleAssets!,
      requiredAlbumIds: candidate.requiredAlbumIds, proposedAlbumIds: candidate.proposedAlbumIds, skippedAlbumIds: candidate.skippedAlbumIds } }],
    result: { runId: dry.runId, attemptId, groupId: candidate.groupId, mode: 'dry-run', outcome: 'dry-run', failureStage: null,
      proposedAlbumIds: candidate.proposedAlbumIds, skippedAlbumIds: candidate.skippedAlbumIds, transferredAlbumIds: [],
      executed: false, resolvedDuplicate: false, trashedAsset: false, keepAssetId: candidate.keepAsset.id, trashAssetId: candidate.trashAsset.id,
      message: 'Dry run' }, assessments: [], releasedAt: null }];
  dry.finishedAt = dry.startedAt;
  dry.report = { fetchedGroups: 1, eligibleCount: 1, excludedGroups: [], stoppedEarly: false, stopReason: null, requestError: null };
  journal.save(dry);
  const live = structuredClone(dry); live.runId = randomUUID(); live.startedAt = new Date().toISOString();
  live.context.dryRun = false; live.finishedAt = null; live.report = null; live.attempts = [];
  live.review.authorizingDryRunId = dry.runId;
  journal.save(live);
  const unauthorized = structuredClone(live); unauthorized.runId = randomUUID(); unauthorized.review.planId = randomUUID();
  assert.throws(() => journal.save(unauthorized));
});
