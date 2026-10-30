import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { evaluateDuplicateGroup } from '@immich-dedupe/rule-engine';
import type { RecoveryAttempt } from '@immich-dedupe/shared';
import { createExecutionJournal, isUnresolved, type JournalRun } from '../src/executionJournal';
import { createExecutionLog } from '../src/executionLog';
import { createExecutionService, ExecutionServiceError } from '../src/executionService';
import { createDecisionExecutor, CheckpointFailure } from '../src/executeDecision';
import { writeAtomicJson, type JournalFs } from '../src/atomicJson';
import { executionHarness, group, rawGroup } from './fixtures';

const options = { dryRun: false, scanLimit: 100, executeLimit: 10 };
function setup(t: TestContext, io: JournalFs = fs) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'immich-pr3-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const journalDir = path.join(directory, 'journal');
  const log = createExecutionLog(path.join(directory, 'log.json'));
  const h = executionHarness();
  const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'test-user' };
  let journal = createExecutionJournal(journalDir, io);
  const service = () => createExecutionService({ client: h.client, apiUrl: scope.apiUrl, journal, log, delay: h.delay });
  return { ...h, directory, journalDir, log, scope, journal, service,
    restart() { journal = createExecutionJournal(journalDir); return { journal, execution: service() }; },
    load: async () => ({ groups: [group()], decisions: [evaluateDuplicateGroup(group())] }),
  };
}
function expectServiceError(status: number, code?: string) {
  return (error: unknown) => error instanceof ExecutionServiceError && error.status === status && (!code || error.code === code);
}
function prepared(scope: { apiUrl: string; accountId: string }): JournalRun {
  const runId = randomUUID();
  const attempt: RecoveryAttempt = { attemptId: randomUUID(), runId, groupId: 'group', mode: 'execute',
    keepAssetId: 'group-keep', trashAssetId: 'group-trash', startedAt: new Date().toISOString(),
    checkpoints: [], result: null, assessments: [], releasedAt: null };
  return { version: 1, runId, scope, startedAt: new Date().toISOString(), finishedAt: null, attempts: [attempt] };
}

test('success is journaled with IDs and remains processed after display-log clearing and restart', async (t) => {
  const h = setup(t); const execution = h.service();
  const result = await execution.run(options, h.load);
  assert.equal(result.results[0].outcome, 'succeeded');
  assert.ok(result.runId && result.results[0].attemptId);
  assert.equal(h.log.loadExecutionLog()[0].attemptId, result.results[0].attemptId);
  assert.equal(h.journal.runs(h.scope)[0].attempts[0].result?.outcome, 'succeeded');
  await execution.clearLog(); assert.deepEqual(h.log.loadExecutionLog(), []);
  const restarted = h.restart();
  const next = await restarted.execution.run({ ...options, dryRun: true }, h.load);
  assert.equal(next.results.length, 0); assert.equal(next.excludedGroups[0].reason, 'processed');
  assert.deepEqual(h.mutations, ['add', 'resolve']);
  await assert.rejects(restarted.execution.run({ ...options, singleGroupId: 'group' }, h.load), expectServiceError(409, 'group_excluded'));
});

test('dry-run logs proposals but does not mark the pair processed', async (t) => {
  const h = setup(t); const execution = h.service();
  for (let i = 0; i < 2; i++) {
    const result = await execution.run({ ...options, dryRun: true }, h.load);
    assert.equal(result.results[0].outcome, 'dry-run'); assert.equal(result.excludedGroups.length, 0);
  }
  assert.equal(h.log.loadExecutionLog().length, 2); assert.deepEqual(h.mutations, []);
});

test('one lock covers loading, simulations, clearing and recovery actions, and releases after errors', async (t) => {
  const h = setup(t); const execution = h.service();
  let unblock!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { unblock = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const first = execution.run({ ...options, dryRun: true }, async () => { entered(); await waiting; return h.load(); });
  await started;
  let secondLoaded = false;
  await assert.rejects(execution.run(options, async () => { secondLoaded = true; return h.load(); }), expectServiceError(409));
  await assert.rejects(execution.clearLog(), expectServiceError(409));
  await assert.rejects(execution.recheck(randomUUID()), expectServiceError(409));
  assert.equal(secondLoaded, false); assert.ok((await execution.list()).activeRunId);
  unblock(); await first;
  await assert.rejects(execution.run(options, async () => { throw new Error('Scan failed'); }), expectServiceError(500));
  assert.equal((await execution.list()).activeRunId, null);
  assert.equal((await execution.run({ ...options, dryRun: true }, h.load)).results[0].outcome, 'dry-run');
});

for (const boundary of ['prepared', 'preflight', 'album-intent', 'album-response', 'album-observed', 'resolution-intent', 'resolution-response', 'verification'] as const) {
  test(`restart after ${boundary} never resumes or repeats mutation`, async (t) => {
    const h = setup(t); h.journal.migrate(h.scope, h.log.loadExecutionLog);
    const run = prepared(h.scope); h.journal.save(run); const attemptId = run.attempts[0].attemptId;
    if (boundary !== 'prepared') {
      const execute = createDecisionExecutor(h.client, { delay: h.delay, onCheckpoint: async (event) => {
        h.journal.checkpoint(h.scope, attemptId, event);
        if (event.kind === boundary) throw new Error('Simulated process interruption');
      } });
      await assert.rejects(execute(group(), evaluateDuplicateGroup(group()), false), CheckpointFailure);
    }
    const mutations = [...h.mutations];
    const restarted = h.restart();
    const listing = await restarted.execution.list();
    assert.equal(listing.items.length, 1); assert.equal(listing.items[0].result, null);
    assert.equal(isUnresolved(listing.items[0]), true);
    const result = await restarted.execution.run(options, h.load);
    assert.equal(result.results.length, 0); assert.equal(result.excludedGroups[0].reason, 'quarantined');
    assert.deepEqual(h.mutations, mutations);
  });
}

for (const boundary of ['prepared', 'preflight', 'album-intent', 'album-response', 'album-observed', 'resolution-intent', 'resolution-response', 'verification', 'finished']) {
  test(`write failure at ${boundary} prevents further mutation and retains prior intent/evidence`, async (t) => {
    let enabled = true;
    const io: JournalFs = { ...fs, writeFileSync(file, data, settings) {
      if (enabled && typeof data === 'string') {
        const record = JSON.parse(data) as JournalRun;
        const attempt = record.attempts?.at(-1);
        if (attempt && (boundary === 'finished' ? attempt.result !== null : boundary === 'prepared' ? attempt.checkpoints.length === 0 : attempt.checkpoints.at(-1)?.event.kind === boundary)) {
          enabled = false; throw new Error('Disk failure');
        }
      }
      return fs.writeFileSync(file, data, settings);
    } };
    const h = setup(t, io); const execution = h.service();
    await assert.rejects(execution.run(options, h.load), (error: unknown) => {
      assert.ok(error instanceof ExecutionServiceError); assert.equal(error.status, 503);
      assert.ok(Array.isArray(error.details.results)); assert.ok(error.details.partialExecution);
      return true;
    });
    assert.deepEqual(h.mutations, ['prepared', 'preflight', 'album-intent'].includes(boundary) ? [] : ['album-response', 'album-observed', 'resolution-intent'].includes(boundary) ? ['add'] : ['add', 'resolve']);
    await assert.rejects(execution.run(options, h.load), expectServiceError(503));
    assert.equal((await execution.list()).health, 'unavailable');
    const restarted = h.restart();
    assert.equal((await restarted.execution.list()).items.length, boundary === 'prepared' ? 0 : 1);
  });
}

test('display-log failure stops work but durable verified success remains authoritative', async (t) => {
  const h = setup(t);
  const execution = createExecutionService({ client: h.client, apiUrl: h.scope.apiUrl, journal: h.journal,
    log: { ...h.log, appendExecutionLog: () => { throw new Error('Display storage failed'); } }, delay: h.delay });
  const result = await execution.run(options, h.load);
  assert.equal(result.stoppedEarly, true); assert.equal(result.results[0].outcome, 'succeeded');
  assert.match(result.stopReason!, /journal retains/);
  assert.equal((await h.restart().execution.run(options, h.load)).excludedGroups[0].reason, 'processed');
});

test('legacy import happens once, preserves original bytes, and remains scoped after log clearing', async (t) => {
  const h = setup(t);
  h.log.appendExecutionLog({ timestamp: new Date().toISOString(), groupId: 'group', mode: 'execute', keepAssetId: 'group-keep', trashAssetId: 'group-trash', executed: true, resolvedDuplicate: true, trashedAsset: true, message: 'Legacy' });
  const original = fs.readFileSync(h.log.getExecutionLogPath(), 'utf8');
  const execution = h.service();
  const result = await execution.run(options, h.load);
  assert.equal(result.excludedGroups[0].reason, 'legacy'); assert.equal(result.results.length, 0);
  assert.equal(fs.readFileSync(h.log.getExecutionLogPath(), 'utf8'), original);
  await execution.clearLog();
  assert.equal((await h.restart().execution.run(options, h.load)).excludedGroups[0].reason, 'legacy');
  h.client.getMyUser = async () => ({ id: 'different-account' });
  const other = await h.restart().execution.run({ ...options, dryRun: true }, h.load);
  assert.equal(other.excludedGroups.length, 0); assert.equal(other.results[0].outcome, 'dry-run');
  const migration = JSON.parse(fs.readFileSync(path.join(h.journalDir, 'legacy-exclusions.json'), 'utf8'));
  assert.equal(migration.scope.accountId, 'test-user');
});

test('malformed legacy history is preserved and prevents migration or clearing', async (t) => {
  const h = setup(t); fs.writeFileSync(h.log.getExecutionLogPath(), '{broken');
  const execution = h.service();
  await assert.rejects(execution.run(options, h.load), expectServiceError(503));
  await assert.rejects(execution.clearLog(), expectServiceError(503));
  assert.equal(fs.readFileSync(h.log.getExecutionLogPath(), 'utf8'), '{broken');
  assert.deepEqual(h.mutations, []);
});

for (const corruption of ['json', 'version', 'identity', 'sequence']) {
  test(`corrupt journal (${corruption}) fails closed without rewriting evidence`, async (t) => {
    const h = setup(t); const run = prepared(h.scope);
    fs.mkdirSync(h.journalDir, { recursive: true });
    fs.writeFileSync(path.join(h.journalDir, 'legacy-exclusions.json'), JSON.stringify({ version: 1, scope: h.scope, importedAt: new Date().toISOString(), groupIds: [] }));
    const file = path.join(h.journalDir, `${run.runId}.json`);
    if (corruption === 'version') Reflect.set(run, 'version', 99);
    if (corruption === 'identity') run.attempts[0].runId = randomUUID();
    if (corruption === 'sequence') run.attempts[0].checkpoints.push({ timestamp: new Date().toISOString(), event: { kind: 'resolution-intent' } });
    const contents = corruption === 'json' ? '{invalid' : JSON.stringify(run);
    fs.writeFileSync(file, contents);
    const execution = h.service(); assert.equal((await execution.list()).health, 'unavailable');
    await assert.rejects(execution.run(options, h.load), expectServiceError(503));
    await assert.rejects(execution.recheck(run.attempts[0].attemptId), expectServiceError(503));
    assert.equal(fs.readFileSync(file, 'utf8'), contents); assert.deepEqual(h.mutations, []);
  });
}

test('identity failure prevents processing or migration; credentials are not written to scope', async (t) => {
  const h = setup(t); h.client.getMyUser = async () => { throw new Error('Denied'); };
  await assert.rejects(h.service().run(options, h.load), expectServiceError(503, 'identity_unavailable'));
  assert.equal(fs.existsSync(h.journalDir), false); assert.deepEqual(h.mutations, []);
  h.client.getMyUser = async () => ({ id: 'test-user' });
  const service = createExecutionService({ client: h.client, apiUrl: 'http://name:password@IMMICH.invalid/api/?token=secret', journal: h.journal, log: h.log, delay: h.delay });
  await service.run({ ...options, dryRun: true }, h.load);
  const content = fs.readFileSync(path.join(h.journalDir, 'legacy-exclusions.json'), 'utf8');
  assert.ok(!content.includes('password') && !content.includes('secret') && !content.includes('name:'));
});

test('quarantine persists through clearing and regrouping, while unrelated groups remain usable', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const execution = h.service(); const first = await execution.run(options, h.load);
  assert.equal(first.results[0].outcome, 'needs-verification'); await execution.clearLog();
  const otherRaw = rawGroup('other'); otherRaw.assets[0].exifInfo = { fileSizeInByte: 200 }; otherRaw.assets[1].exifInfo = { fileSizeInByte: 100 };
  const get = h.client.getAssetInfo;
  h.client.getAssetInfo = async (args) => args.id.startsWith('other-') ? otherRaw.assets.find((a) => a.id === args.id)! : get(args);
  h.client.getAssetDuplicates = async () => [h.raw, otherRaw];
  const regrouped = { ...group(), groupId: 'regrouped' };
  const groups = [group(), regrouped, group('other')];
  h.client.resolveDuplicates = async ({ duplicateResolveDto }) => {
    assert.equal(duplicateResolveDto.groups[0].duplicateId, 'other');
    h.mutations.push('resolve-other');
    otherRaw.assets[1].isTrashed = true; otherRaw.assets[1].duplicateId = null; otherRaw.assets[0].duplicateId = null;
    return [{ id: 'other', success: true }];
  };
  const result = await h.restart().execution.run(options, async () => ({ groups, decisions: groups.map(evaluateDuplicateGroup) }));
  assert.deepEqual(result.excludedGroups.map((e) => e.reason), ['quarantined', 'quarantined']);
  assert.deepEqual(result.results.map((r) => r.groupId), ['other']); assert.equal(result.results[0].outcome, 'succeeded');
});

test('intact recheck stays quarantined; explicit release performs fresh checks and preserves assessments', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const execution = h.service(); const result = await execution.run(options, h.load); const attemptId = result.results[0].attemptId!;
  const mutations = [...h.mutations];
  const checked = await execution.recheck(attemptId);
  assert.equal(checked.assessments.at(-1)?.classification, 'pair-intact');
  assert.equal((await execution.list()).items.length, 1);
  const released = await execution.recheck(attemptId, true);
  assert.ok(released.releasedAt); assert.equal(released.assessments.length, 2);
  assert.equal(released.result?.outcome, 'needs-verification'); assert.deepEqual(h.mutations, mutations);
  assert.equal((await execution.list()).items.length, 0);
  const next = await execution.run({ ...options, dryRun: true }, h.load); assert.equal(next.results[0].outcome, 'dry-run');
});

test('release never trusts an old intact assessment after eligibility changes', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const execution = h.service(); const result = await execution.run(options, h.load); const id = result.results[0].attemptId!;
  await execution.recheck(id); h.assets.get('group-keep')!.isFavorite = true;
  await assert.rejects(execution.recheck(id, true), expectServiceError(409, 'release_not_verified'));
  const attempt = await execution.detail(id);
  assert.equal(attempt.releasedAt, null); assert.equal(attempt.assessments.length, 2);
  assert.equal(attempt.assessments.at(-1)?.classification, 'inconclusive');
});

test('verified resolved recovery records current proof without rewriting original uncertainty or replaying operations', async (t) => {
  const h = setup(t); const resolve = h.client.resolveDuplicates;
  h.client.resolveDuplicates = async (args) => { await resolve(args); throw new Error('Response lost'); };
  const execution = h.service(); const result = await execution.run(options, h.load); const id = result.results[0].attemptId!;
  h.client.getAssetDuplicates = async () => [];
  const mutations = [...h.mutations]; const checked = await execution.recheck(id);
  assert.equal(checked.assessments.at(-1)?.classification, 'verified-resolved');
  assert.equal(checked.result?.outcome, 'needs-verification'); assert.deepEqual(h.mutations, mutations);
  assert.equal((await h.restart().execution.run(options, h.load)).excludedGroups[0].reason, 'processed');
});

test('missing required album evidence stays inconclusive and blocked', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const execution = h.service(); const result = await execution.run(options, h.load); const id = result.results[0].attemptId!;
  h.albums.delete('missing');
  const checked = await execution.recheck(id);
  assert.equal(checked.assessments.at(-1)?.classification, 'inconclusive'); assert.deepEqual(h.delays.slice(-2), [1000, 1000]);
  assert.equal((await execution.list()).items.length, 1);
});

test('release does not override another unresolved attempt involving the same assets', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const execution = h.service(); const result = await execution.run(options, h.load); const id = result.results[0].attemptId!;
  const other = prepared(h.scope); h.journal.save(other);
  await execution.recheck(id, true);
  const blocked = await execution.run({ ...options, dryRun: true }, h.load);
  assert.equal(blocked.excludedGroups[0].reason, 'quarantined');
  assert.deepEqual(blocked.excludedGroups[0].attemptIds, [other.attempts[0].attemptId]);
});

test('recovery evidence cannot be read under another account', async (t) => {
  const h = setup(t); h.journal.migrate(h.scope, h.log.loadExecutionLog); const run = prepared(h.scope); h.journal.save(run);
  h.client.getMyUser = async () => ({ id: 'another-user' });
  await assert.rejects(h.service().detail(run.attempts[0].attemptId), expectServiceError(404));
});

test('atomic writer flushes file before rename and directory afterwards; failed rename preserves old JSON', (t) => {
  const h = setup(t); const file = path.join(h.directory, 'atomic.json'); fs.writeFileSync(file, '{"old":true}');
  const operations: string[] = [];
  const io: JournalFs = { ...fs,
    fsyncSync(fd) { operations.push('flush'); fs.fsyncSync(fd); },
    renameSync(from, to) { operations.push('rename'); fs.renameSync(from, to); },
  };
  writeAtomicJson(file, { next: true }, io);
  assert.deepEqual(operations, ['flush', 'rename', 'flush']);
  const failing: JournalFs = { ...fs, renameSync() { throw new Error('Rename failed'); } };
  assert.throws(() => writeAtomicJson(file, { partial: true }, failing));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { next: true });
});

test('directory-flush failure after intent rename stops mutation and preserves restart quarantine', async (t) => {
  let target = false, renamed = false, failed = false;
  const io: JournalFs = { ...fs,
    writeFileSync(file, data, settings) {
      if (typeof data === 'string') {
        const run = JSON.parse(data) as JournalRun;
        target = run.attempts?.at(-1)?.checkpoints.at(-1)?.event.kind === 'resolution-intent';
        renamed = false;
      }
      fs.writeFileSync(file, data, settings);
    },
    renameSync(from, to) { fs.renameSync(from, to); renamed = true; },
    fsyncSync(fd) {
      if (target && renamed && !failed) { failed = true; throw new Error('Directory flush failed'); }
      fs.fsyncSync(fd);
    },
  };
  const h = setup(t, io);
  await assert.rejects(h.service().run(options, h.load), expectServiceError(503));
  assert.deepEqual(h.mutations, ['add']);
  const restarted = h.restart();
  const item = (await restarted.execution.list()).items[0];
  assert.equal(item.checkpoints.at(-1)?.event.kind, 'resolution-intent'); assert.equal(item.result, null);
});

test('missing migration marker does not reimport old history into another account', async (t) => {
  const h = setup(t); await h.service().run({ ...options, dryRun: true }, h.load);
  fs.unlinkSync(path.join(h.journalDir, 'legacy-exclusions.json'));
  h.client.getMyUser = async () => ({ id: 'different-account' });
  const restarted = h.restart();
  assert.equal((await restarted.execution.list()).health, 'unavailable');
  await assert.rejects(restarted.execution.run(options, h.load), expectServiceError(503));
  assert.equal(fs.existsSync(path.join(h.journalDir, 'legacy-exclusions.json')), false);
});

test('inconsistent successful-response evidence cannot authorize a completed journal record', async (t) => {
  const h = setup(t); const result = await h.service().run(options, h.load);
  const file = path.join(h.journalDir, `${result.runId}.json`);
  const record = JSON.parse(fs.readFileSync(file, 'utf8')) as JournalRun;
  const event = record.attempts[0].checkpoints.find((c) => c.event.kind === 'resolution-response')!.event;
  assert.equal(event.kind, 'resolution-response');
  if (event.kind === 'resolution-response') event.accepted = false;
  fs.writeFileSync(file, JSON.stringify(record));
  assert.equal((await h.restart().execution.list()).health, 'unavailable');
});

test('existing checkpoints and terminal results cannot be silently rewritten', async (t) => {
  const h = setup(t); const result = await h.service().run({ ...options, dryRun: true }, h.load);
  const file = path.join(h.journalDir, `${result.runId}.json`);
  const before = fs.readFileSync(file, 'utf8');
  const record = h.journal.run(h.scope, result.runId)!;
  record.attempts[0].checkpoints = [];
  assert.throws(() => h.journal.save(record));
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(h.journal.health().health, 'unavailable');
});

test('quarantined groups remain explicitly reported when their current rules are no longer executable', async (t) => {
  const h = setup(t); h.client.resolveDuplicates = async () => { throw new Error('Response lost'); };
  const execution = h.service(); await execution.run(options, h.load);
  const changed = group(); changed.assets[1].isTrashed = true;
  const result = await execution.run(options, async () => ({ groups: [changed], decisions: [evaluateDuplicateGroup(changed)] }));
  assert.equal(result.eligibleCount, 0); assert.equal(result.results.length, 0);
  assert.equal(result.excludedGroups[0].reason, 'quarantined');
});

test('resolved recovery does not require irrelevant optional keeper metadata, while keeping required proof strict', async (t) => {
  const h = setup(t); const resolve = h.client.resolveDuplicates;
  h.client.resolveDuplicates = async (args) => { await resolve(args); throw new Error('Response lost'); };
  const execution = h.service(); const result = await execution.run(options, h.load);
  h.client.getAssetDuplicates = async () => [];
  const get = h.client.getAssetInfo;
  h.client.getAssetInfo = async (args) => {
    const value = await get(args);
    Reflect.deleteProperty(value, 'isFavorite');
    if (args.id === 'group-keep') Reflect.deleteProperty(value, 'duplicateId');
    return value;
  };
  const assessment = await execution.recheck(result.results[0].attemptId!);
  assert.equal(assessment.assessments.at(-1)?.classification, 'verified-resolved');
});
