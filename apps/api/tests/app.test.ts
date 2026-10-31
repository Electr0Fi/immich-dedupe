import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDependencies } from '../src/app';
import { fakeImmich, rawGroup, rawAsset, album, temporaryLog, executionHarness, temporaryJournal, heuristicTestRules } from './fixtures';

function dependencies(t: TestContext, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const groups = [rawGroup('one'), rawGroup('two'), rawGroup('three')];
  return {
    config: { IMMICH_URL: 'http://immich.invalid/api', IMMICH_API_KEY: 'test-only' },
    log: temporaryLog(t),
    journal: temporaryJournal(t),
    fetch: async () => { throw new Error('Unexpected external fetch'); },
    saveConnection: () => { throw new Error('Unexpected settings write'); },
    immich: fakeImmich({
      getAssetDuplicates: async () => groups,
      getAssetInfo: async ({ id }) => {
        const asset = groups.flatMap((g) => g.assets).find((a) => a.id === id);
        if (!asset) throw new Error('Unknown asset');
        return { ...asset, exifInfo: { fileSizeInByte: id.endsWith('keep') ? 200 : 100 } };
      },
      getAllAlbums: async () => [],
    }),
    ...overrides,
  };
}

async function serve(t: TestContext, deps: AppDependencies) {
  // Existing execution tests intentionally exercise the opt-in metadata preset.
  const rules = deps.rules ?? await heuristicTestRules({ apiUrl: deps.config.IMMICH_URL, accountId: 'test-user' });
  const app = createApp({ ...deps, rules });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test('app factory works without environment variables, SDK initialization, storage access or listening', (t) => {
  const unexpected = () => { throw new Error('Unexpected dependency access'); };
  const app = createApp({
    config: { IMMICH_URL: '', IMMICH_API_KEY: '' }, immich: fakeImmich(), journal: temporaryJournal(t),
    log: { loadExecutionLog: unexpected, appendExecutionLog: unexpected, clearExecutionLog: unexpected,
      getExecutionLogPath: unexpected },
    fetch: async () => unexpected(), saveConnection: unexpected,
  });
  assert.equal(typeof app, 'function');
});

test('health reports API liveness without contacting Immich', async (t) => {
  const base = await serve(t, dependencies(t, { immich: fakeImmich() }));
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true); assert.equal(body.service, 'api');
  assert.ok(Number.isFinite(Date.parse(body.timestamp)));
});

test('scan and execution limits remain separate, with batch logging', async (t) => {
  const deps = dependencies(t); const base = await serve(t, deps);
  const response = await fetch(`${base}/execution/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ scanLimit: 3, executeLimit: 1, dryRun: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.fetchedGroups, 3); assert.equal(body.eligibleCount, 3);
  assert.equal(body.results.length, 1); assert.equal(body.actuallyExecutedCount, 0);
  assert.equal(deps.log.loadExecutionLog().length, 1);
  const plan = await (await fetch(`${base}/execution/plan?scanLimit=2`)).json();
  assert.equal(plan.fetchedGroups, 2); assert.equal(plan.items.length, 2);
  const analysis = await (await fetch(`${base}/analysis/duplicates?limit=1`)).json();
  assert.equal(analysis.totalGroups, 1); assert.equal(analysis.autoResolveCount, 1);
});

test('album enrichment reaches preview and single-group dry-run without mutations', async (t) => {
  const raw = rawGroup('one');
  const deps = dependencies(t);
  deps.immich.getAllAlbums = async ({ assetId }) => assetId === 'one-keep' ? [] : [album('missing', [raw.assets[1]])];
  deps.immich.getAlbumInfo = async () => album('missing', [raw.assets[1]]);
  const base = await serve(t, deps);
  const preview = await (await fetch(`${base}/execution/duplicates/one/preview`)).json();
  assert.equal(preview.executable, true);
  assert.deepEqual(preview.preview.albumsToTransfer, [{ albumId: 'missing', albumName: 'missing' }]);
  const execution = await (await fetch(`${base}/execution/duplicates/one`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":true}',
  })).json();
  assert.equal(execution.execution.executed, false);
  assert.equal(execution.execution.outcome, 'dry-run');
  assert.deepEqual(execution.execution.proposedAlbumIds, ['missing']);
  assert.deepEqual(execution.execution.transferredAlbumIds, []);
  assert.equal(deps.log.loadExecutionLog().length, 1, 'single-group execution now uses unified logging');
  assert.equal((await fetch(`${base}/execution/duplicates/missing/preview`)).status, 404);
});

test('connection test and save use injected dependencies, not real fetch or .env', async (t) => {
  const writes: Record<string, string>[] = [];
  const base = await serve(t, dependencies(t, {
    fetch: async (url, init) => {
      assert.equal(url, 'http://fake.invalid/api/server/about');
      assert.deepEqual(init?.headers, { 'x-api-key': 'fake-key' });
      return Response.json({ version: 'test-version' });
    },
    saveConnection: (updates) => { writes.push(updates); },
  }));
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ immichUrl: 'http://fake.invalid/api', apiKey: 'fake-key' }) };
  const testResult = await (await fetch(`${base}/settings/test-connection`, options)).json();
  assert.equal(testResult.version, 'test-version'); assert.equal(writes.length, 0);
  const saved = await (await fetch(`${base}/settings/connection`, options)).json();
  assert.equal(saved.ok, true);
  assert.deepEqual(writes, [{ IMMICH_URL: 'http://fake.invalid/api', IMMICH_API_KEY: 'fake-key' }]);
});

test('file-size caches are isolated between constructed applications', async (t) => {
  const first = dependencies(t);
  const second = dependencies(t);
  second.immich.getAssetInfo = async ({ id }) => rawAsset(id, { exifInfo: { fileSizeInByte: 100 } });
  const firstBase = await serve(t, first); const secondBase = await serve(t, second);
  const a = await (await fetch(`${firstBase}/execution/plan?scanLimit=1`)).json();
  const b = await (await fetch(`${secondBase}/execution/plan?scanLimit=1`)).json();
  assert.equal(a.items.length, 1); assert.equal(b.items.length, 0);
});

test('log endpoints export and clear only the injected store', async (t) => {
  const deps = dependencies(t);
  deps.log.appendExecutionLog({ timestamp: '2026-01-01T00:00:00.000Z', groupId: 'one', mode: 'dry-run',
    keepAssetId: 'keep', trashAssetId: 'trash', executed: false, resolvedDuplicate: false,
    trashedAsset: false, message: 'A "quoted", multiline\nmessage' });
  const base = await serve(t, deps);
  const json = await (await fetch(`${base}/execution/log/export.json`)).json();
  assert.equal(json.count, 1); assert.equal(json.path, deps.log.getExecutionLogPath());
  const csv = await (await fetch(`${base}/execution/log/export.csv`)).text();
  assert.ok(csv.includes('"A ""quoted"", multiline\nmessage"'));
  const cleared = await (await fetch(`${base}/execution/log/clear`, { method: 'POST' })).json();
  assert.equal(cleared.clearedCount, 1); assert.equal(deps.log.loadExecutionLog().length, 0);
});

test('SDK failures preserve the existing HTTP error contract', async (t) => {
  const base = await serve(t, dependencies(t, { immich: fakeImmich({
    getAssetDuplicates: async () => { throw new Error('Simulated upstream failure'); },
  }) }));
  t.mock.method(console, 'error', () => {});
  const response = await fetch(`${base}/immich/duplicates`);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { ok: false, error: 'Simulated upstream failure' });
});

for (const route of ['/execution/run', '/execution/duplicates/one']) {
  test(`${route}: omitted dryRun simulates instead of executing`, async (t) => {
    const base = await serve(t, dependencies(t));
    const response = await fetch(`${base}${route}`, { method: 'POST' });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dryRun, true);
    const results = body.results ?? [body.execution];
    assert.ok(results.every((result: { outcome: string; executed: boolean }) => result.outcome === 'dry-run' && !result.executed));
  });

  test(`${route}: invalid modes and limits fail before SDK access`, async (t) => {
    const base = await serve(t, dependencies(t, { immich: fakeImmich() }));
    const bodies = [
      { dryRun: 'true' }, { dryRun: 'false' }, { dryRun: null }, { dryRun: 0 },
      ...['scanLimit', 'executeLimit', 'limit'].flatMap((field) =>
        [0, -1, 1.5, '10', null, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ [field]: value }))),
    ];
    for (const body of bodies) {
      const response = await fetch(`${base}${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal((await response.json()).ok, false);
    }
  });
}

test('execution defaults and explicit legacy-limit precedence remain predictable', async (t) => {
  const base = await serve(t, dependencies(t));
  const cases = [
    [{}, 100, 10], [{ limit: 1 }, 1, 1],
    [{ limit: 1, scanLimit: 2 }, 2, 1], [{ limit: 1, executeLimit: 2 }, 1, 2],
    [{ limit: 1, scanLimit: 2, executeLimit: 3 }, 2, 3],
  ] as const;
  for (const [input, scan, execute] of cases) {
    const body = await (await fetch(`${base}/execution/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
    })).json();
    assert.equal(body.scanLimit, scan); assert.equal(body.executeLimit, execute);
    assert.equal(body.stoppedEarly, false); assert.equal(body.stopReason, null);
  }
});

for (const route of ['/execution/run', '/execution/duplicates/one']) {
  test(`${route}: explicit live mode reports verified success with fake Immich`, async (t) => {
    const h = executionHarness('one');
    const deps = dependencies(t, { immich: h.client });
    const base = await serve(t, deps);
    const response = await fetch(`${base}${route}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":false}',
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.dryRun, false);
    assert.equal((body.results?.[0] ?? body.execution).outcome, 'succeeded');
    assert.deepEqual(h.mutations, ['add', 'resolve']);
    if (body.results) {
      const entry = deps.log.loadExecutionLog()[0];
      assert.equal(entry.outcome, 'succeeded'); assert.deepEqual(entry.transferredAlbumIds, ['missing']);
      const exported = await (await fetch(`${base}/execution/log/export.csv`)).text();
      assert.ok(exported.includes('outcome,failureStage,proposedAlbumIds,transferredAlbumIds'));
      assert.ok(exported.includes('succeeded'));
    }
  });
}

test('batch failure is HTTP 200 with a stop reason and unverified outcome', async (t) => {
  const h = executionHarness('one');
  const getGroups = h.client.getAssetDuplicates;
  h.client.getAssetDuplicates = async () => [...await getGroups({}), rawGroup('later')];
  h.client.resolveDuplicates = async () => { h.mutations.push('resolve'); return [{ id: 'one', success: false }]; };
  const read = h.client.getAssetInfo;
  h.client.getAssetInfo = async (args) => args.id.startsWith('later-') ?
    { ...rawGroup('later').assets.find((asset) => asset.id === args.id)!, exifInfo: { fileSizeInByte: args.id.endsWith('keep') ? 200 : 100 } } : await read(args);
  const deps = dependencies(t, { immich: h.client });
  const base = await serve(t, deps);
  const response = await fetch(`${base}/execution/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":false}',
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.stoppedEarly, true); assert.ok(body.stopReason);
  assert.equal(body.results[0].outcome, 'needs-verification');
  assert.equal(body.actuallyExecutedCount, 0); assert.equal(deps.log.loadExecutionLog()[0].executed, false);
  assert.deepEqual(h.mutations, ['add', 'resolve']);
});

test('protected assets are excluded consistently from analysis, plan and preview', async (t) => {
  const h = executionHarness('one'); h.assets.get('one-keep')!.isFavorite = true;
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const analysis = await (await fetch(`${base}/analysis/duplicates?limit=1`)).json();
  const plan = await (await fetch(`${base}/execution/plan?scanLimit=1`)).json();
  const preview = await (await fetch(`${base}/execution/duplicates/one/preview`)).json();
  assert.equal(analysis.autoResolveCount, 0); assert.equal(analysis.skipCount, 1);
  assert.equal(plan.items.length, 0); assert.equal(preview.executable, false);
  assert.deepEqual(h.mutations, []);
});

test('recovery HTTP API exposes evidence, validates confirmation, and never mutates during recheck/release', async (t) => {
  const h = executionHarness('one'); h.client.resolveDuplicates = async () => { throw new Error('Lost response'); };
  const deps = dependencies(t, { immich: h.client }); const base = await serve(t, deps);
  const response = await (await fetch(`${base}/execution/duplicates/one`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":false}',
  })).json();
  const id = response.execution.attemptId;
  assert.ok(id && response.runId);
  const listing = await (await fetch(`${base}/execution/recovery?limit=1`)).json();
  assert.equal(listing.items[0].attemptId, id); assert.equal(listing.total, 1);
  assert.equal((await fetch(`${base}/execution/recovery?limit=0`)).status, 400);
  assert.equal((await fetch(`${base}/execution/recovery/not-a-uuid`)).status, 400);
  const detail = await (await fetch(`${base}/execution/recovery/${id}`)).json();
  assert.equal(detail.attempt.result.outcome, 'needs-verification'); assert.ok(detail.attempt.checkpoints.length);
  const mutations = [...h.mutations];
  const checked = await (await fetch(`${base}/execution/recovery/${id}/recheck`, { method: 'POST' })).json();
  assert.equal(checked.attempt.assessments.at(-1).classification, 'pair-intact');
  assert.equal((await fetch(`${base}/execution/recovery/${id}/release`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}/execution/recovery/${id}/release`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}',
  })).status, 200);
  assert.deepEqual(h.mutations, mutations);
  assert.equal((await (await fetch(`${base}/execution/recovery`)).json()).total, 0);
  assert.equal(deps.log.loadExecutionLog().length, 1);
});

test('client disconnect does not release the coordinator while work is running', async (t) => {
  const deps = dependencies(t); const original = deps.immich.getAssetDuplicates;
  let enter!: () => void, unblock!: () => void;
  const started = new Promise<void>((resolve) => { enter = resolve; });
  const wait = new Promise<void>((resolve) => { unblock = resolve; });
  deps.immich.getAssetDuplicates = async (args) => { enter(); await wait; return original(args); };
  const base = await serve(t, deps); const abort = new AbortController();
  const first = fetch(`${base}/execution/run`, { method: 'POST', signal: abort.signal });
  // Attach rejection handler immediately; abort is an expected client-side outcome.
  const disconnected = assert.rejects(first);
  await started; abort.abort(); await disconnected;
  assert.equal((await fetch(`${base}/health`)).status, 200);
  assert.equal((await fetch(`${base}/execution/run`, { method: 'POST' })).status, 409);
  assert.equal((await fetch(`${base}/execution/log/clear`, { method: 'POST' })).status, 409);
  unblock();
  let active = true;
  for (let i = 0; i < 150; i++) {
    active = Boolean((await (await fetch(`${base}/execution/recovery`)).json()).activeRunId);
    if (!active) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(active, false); assert.equal(deps.log.loadExecutionLog().length, 3);
});

test('checkpoint failures return HTTP 503 with identifiers and partial execution results', async (t) => {
  const h = executionHarness('one'); const deps = dependencies(t, { immich: h.client });
  const checkpoint = deps.journal.checkpoint.bind(deps.journal);
  deps.journal.checkpoint = (scope, id, event) => {
    if (event.kind === 'resolution-intent') throw new Error('Simulated checkpoint failure');
    checkpoint(scope, id, event);
  };
  const base = await serve(t, deps);
  const response = await fetch(`${base}/execution/run`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":false}' });
  assert.equal(response.status, 503); const body = await response.json();
  assert.equal(body.code, 'journal_unavailable'); assert.ok(body.runId);
  assert.equal(body.partialExecution.results[0].outcome, 'needs-verification');
  assert.deepEqual(body.partialExecution.results[0].transferredAlbumIds, ['missing']);
  assert.deepEqual(h.mutations, ['add']);
});

test('run read endpoints are scoped, compact and side effect free', async (t) => {
  const deps = dependencies(t); const base = await serve(t, deps);
  assert.equal((await (await fetch(`${base}/execution/runs/latest`)).json()).run, null);
  assert.equal((await fetch(`${base}/execution/runs/not-a-uuid`)).status, 400);
  assert.equal((await fetch(`${base}/execution/runs/00000000-0000-4000-8000-000000000001`)).status, 404);
  const result = await (await fetch(`${base}/execution/run`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":true,"scanLimit":3,"executeLimit":1}',
  })).json();
  const response = await fetch(`${base}/execution/runs/${result.runId}`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.run.context.scanLimit, 3); assert.equal(body.run.report.eligibleCount, 3);
  assert.equal(body.run.phase, 'finished'); assert.equal(body.run.attempts.length, 1);
  assert.equal('checkpoints' in body.run.attempts[0], false);
  deps.immich.getMyUser = async () => ({ id: 'other' });
  assert.equal((await fetch(`${base}/execution/runs/${result.runId}`)).status, 404);
  deps.immich.getMyUser = async () => { throw { status: 403, data: { message: 'Missing required permission: user.read' } }; };
  assert.equal((await fetch(`${base}/execution/runs/latest`)).status, 503);
});

test('review endpoints validate bodies, require exact dry-run approval, and restrict thumbnail access', async (t) => {
  const h = executionHarness('one');
  h.client.viewAsset = async () => new Blob(['fake-image'], { type: 'image/jpeg' });
  let time = Date.now(); const deps = dependencies(t, { immich: h.client, now: () => time }); const base = await serve(t, deps);
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ scanLimit: 0 }, { executeLimit: 1.5 }, { scanLimit: '2' }, { scanLimit: Number.MAX_SAFE_INTEGER + 1 }]) assert.equal((await post('/execution/plans', body)).status, 400);
  const prepared = await post('/execution/plans', {}); assert.equal(prepared.status, 200);
  const { plan } = await prepared.json(); assert.equal(plan.scanLimit, 100); assert.equal(plan.executeLimit, 10);
  const endpoint = `/execution/plans/${plan.planId}/run`;
  assert.equal((await post(endpoint, { selectedGroupIds: ['one'], dryRun: false })).status, 409);
  for (const body of [{ selectedGroupIds: [] }, { selectedGroupIds: ['one', 'one'] }, { selectedGroupIds: ['one'], dryRun: 'false' }, { selectedGroupIds: ['one'], authorized: true }]) assert.equal((await post(endpoint, body)).status, 400);
  const thumbnail = `/execution/plans/${plan.planId}/assets/one-keep/thumbnail`;
  const image = await fetch(`${base}${thumbnail}`); assert.equal(image.status, 200); assert.equal(image.headers.get('cache-control'), 'no-store'); assert.equal(image.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(`${base}/execution/plans/${plan.planId}/assets/other/thumbnail`)).status, 404);
  h.client.viewAsset = async () => { throw new Error('secret credentials'); };
  const missing = await fetch(`${base}${thumbnail}`); assert.equal(missing.status, 502); assert.ok(!(await missing.text()).includes('secret'));
  const dry = await post(endpoint, { selectedGroupIds: ['one'] }); assert.equal(dry.status, 200); assert.equal((await dry.json()).results[0].outcome, 'dry-run');
  assert.deepEqual(h.mutations, []);
  time += 900000; assert.equal((await fetch(`${base}${thumbnail}`)).status, 410);
  assert.equal((await post(endpoint, { selectedGroupIds: ['one'] })).status, 410);
});

test('preparation streams progress before completion and accepts cancellation while locked', async (t) => {
  const h = executionHarness('one');
  let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  h.client.getAllAlbums = async () => { entered(); await wait; return []; };
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const response = await fetch(`${base}/execution/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: '{}' });
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  const first = decoder.decode((await reader.read()).value);
  const event = JSON.parse(first.split('\n')[0]);
  assert.equal(event.type, 'progress');
  await started;
  const cancel = await fetch(`${base}/execution/preparations/${event.progress.preparationId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200); assert.equal((await cancel.json()).status, 'cancelling');
  const busy = await fetch(`${base}/execution/plans`, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
  assert.equal(busy.status, 409);
  release();
  let text = first;
  for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  const terminal = events.at(-1);
  assert.equal(terminal.type, 'result'); assert.equal(terminal.result.status, 'cancelled');
  assert.equal(terminal.result.plan.candidates.length, 0); assert.equal(terminal.result.plan.fetchedGroups, 0);
  assert.deepEqual(h.mutations, []);
  assert.equal((await fetch(`${base}/execution/preparations/invalid/cancel`, { method: 'POST' })).status, 400);
  assert.equal((await fetch(`${base}/execution/preparations/00000000-0000-4000-8000-000000000001/cancel`, { method: 'POST' })).status, 404);
});

test('reviewed run streams dry-run progress and terminal stale-selection errors without mutations', async (t) => {
  const h = executionHarness('one'); const base = await serve(t, dependencies(t, { immich: h.client }));
  const post = (path: string, body: unknown, stream = false) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) });
  const { plan } = await (await post('/execution/plans', {})).json();
  const response = await post(`/execution/plans/${plan.planId}/run`, { selectedGroupIds: ['one'] }, true);
  assert.equal(response.headers.get('content-type'), 'application/x-ndjson'); assert.equal(response.headers.get('cache-control'), 'no-store');
  const events = (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(events.some((event) => event.type === 'progress' && event.progress.stage === 'checking-albums'));
  assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).result.results[0].outcome, 'dry-run');
  assert.deepEqual(h.mutations, []);
  h.raw.assets[0].isFavorite = true;
  const stale = await post(`/execution/plans/${plan.planId}/run`, { selectedGroupIds: ['one'], dryRun: false }, true);
  const errors = (await stale.text()).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(errors.at(-1).type, 'error'); assert.equal(errors.at(-1).status, 409);
  assert.equal(errors.at(-1).code, 'plan_changed'); assert.equal(errors.at(-1).changedGroups[0].groupId, 'one');
  assert.equal(errors.some((event) => event.type === 'result'), false); assert.deepEqual(h.mutations, []);
  assert.equal((await post(`/execution/plans/${plan.planId}/run`, { selectedGroupIds: [], dryRun: false }, true)).status, 400);
});

test('disconnecting a live run stream retains the lock, continues exactly once and saves verified results', async (t) => {
  const h = executionHarness('one'); const base = await serve(t, dependencies(t, { immich: h.client }));
  const post = (path: string, body: unknown, stream = false) => fetch(`${base}${path}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'application/x-ndjson' } : {}) }, body: JSON.stringify(body) });
  const { plan } = await (await post('/execution/plans', {})).json();
  const endpoint = `/execution/plans/${plan.planId}/run`;
  assert.equal((await post(endpoint, { selectedGroupIds: ['one'] })).status, 200);
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  t.after(() => release());
  const resolve = h.client.resolveDuplicates;
  h.client.resolveDuplicates = async (args) => { entered(); await waiting; return resolve(args); };
  const response = await post(endpoint, { selectedGroupIds: ['one'], dryRun: false }, true);
  await started; await response.body!.cancel();
  const busy = await post(endpoint, { selectedGroupIds: ['one'] }, true);
  assert.equal(busy.status, 409); assert.equal((await busy.json()).code, 'execution_busy');
  release();
  let saved;
  for (let index = 0; index < 100; index++) {
    saved = await (await fetch(`${base}/execution/runs/latest`)).json();
    if (saved.run?.finishedAt) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(saved.run.finishedAt); assert.equal(saved.run.attempts[0].result.outcome, 'succeeded');
  assert.deepEqual(h.mutations, ['add', 'resolve']);
});

test('run stream preserves partial evidence when a durable checkpoint fails', async (t) => {
  const h = executionHarness('one'); const journal = temporaryJournal(t);
  const base = await serve(t, dependencies(t, { immich: h.client, journal }));
  const { plan } = await (await fetch(`${base}/execution/plans`, { method: 'POST' })).json();
  journal.checkpoint = () => { throw new Error('Checkpoint unavailable'); };
  const response = await fetch(`${base}/execution/plans/${plan.planId}/run`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify({ selectedGroupIds: ['one'] }) });
  const terminal = (await response.text()).trim().split('\n').map((line) => JSON.parse(line)).at(-1);
  assert.equal(terminal.type, 'error'); assert.equal(terminal.status, 503); assert.equal(terminal.code, 'journal_unavailable');
  assert.equal(terminal.partialExecution.results[0].outcome, 'failed'); assert.equal(terminal.partialExecution.runId, terminal.runId);
  assert.deepEqual(h.mutations, []);
});

test('streamed preparation errors are terminal, sanitized and do not create a plan', async (t) => {
  const h = executionHarness('one'); h.client.getAssetDuplicates = async () => { throw new Error('private SDK connection details'); };
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const response = await fetch(`${base}/execution/plans`, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
  const text = await response.text();
  assert.equal(text.includes('private SDK'), false);
  const events = text.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(events.at(-1).type, 'error'); assert.equal(events.some((event) => event.type === 'result'), false);
  assert.deepEqual(h.mutations, []);
});

test('disconnecting a preparation stream leaves its work and lock active until reads settle', async (t) => {
  const h = executionHarness('one');
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  h.client.getAllAlbums = async () => { entered(); await wait; return []; };
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const response = await fetch(`${base}/execution/plans`, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
  await started;
  await response.body!.cancel();
  assert.equal((await fetch(`${base}/execution/plans`, { method: 'POST' })).status, 409);
  release();
  let status = 409;
  for (let i = 0; i < 150 && status === 409; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const next = await fetch(`${base}/execution/plans`, { method: 'POST' });
    status = next.status; await next.arrayBuffer();
  }
  assert.equal(status, 200); assert.deepEqual(h.mutations, []);
});

test('select-all endpoint validates requests and returns an expanded review requiring its own dry-run', async (t) => {
  const base = await serve(t, dependencies(t));
  const post = (url: string, body: unknown = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const { plan: original } = await (await post('/execution/plans', { scanLimit: 3, executeLimit: 1 })).json();
  const endpoint = `/execution/plans/${original.planId}/select-all`;
  assert.equal((await post('/execution/plans/invalid/select-all')).status, 400);
  assert.equal((await post('/execution/plans/00000000-0000-4000-8000-000000000001/select-all')).status, 410);
  assert.equal((await post(endpoint, { executeLimit: 999 })).status, 400);
  const response = await post(endpoint); assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const { plan } = await response.json();
  assert.equal(plan.executeLimit, 3); assert.notEqual(plan.planId, original.planId);
  assert.equal(plan.expiresAt, original.expiresAt); assert.deepEqual(plan.candidates, original.candidates);
  assert.equal((await post(`/execution/plans/${plan.planId}/run`, { selectedGroupIds: plan.candidates.map((c: { groupId: string }) => c.groupId), dryRun: false })).status, 409);
});

test('prepared review HTTP response explains unsupported asset counts to the UI', async (t) => {
  const h = executionHarness('three-assets');
  h.raw.assets.push({ ...h.raw.assets[0], id: 'third-asset' });
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const response = await fetch(`${base}/execution/plans`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200);
  const { plan } = await response.json();
  assert.equal(plan.candidates.length, 0);
  assert.equal(plan.excludedGroups[0].message, '3 assets in group; current rule definitions only support exactly 2 assets per group.');
  assert.deepEqual(h.mutations, []);
});

test('quick HTTP endpoints return provisional data, enrich only an explicit selection and reject direct execution', async (t) => {
  const h = executionHarness('one'); h.raw.assets.forEach((asset) => { asset.livePhotoVideoId = null; }); const base = await serve(t, dependencies(t, { immich: h.client }));
  const post = (url: string, body: unknown = {}) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  for (const body of [{ scanLimit: 0 }, { executeLimit: '5' }, { unexpected: true }]) assert.equal((await post('/execution/quick-reviews', body)).status, 400);
  const response = await post('/execution/quick-reviews', { scanLimit: 10, executeLimit: 1 });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  const { quickReview } = await response.json();
  assert.equal(quickReview.candidates.length, 1); assert.deepEqual(h.calls, ['groups']);
  assert.equal('albums' in quickReview.candidates[0].keepAsset, false);
  assert.equal((await post(`/execution/plans/${quickReview.reviewId}/run`, { selectedGroupIds: ['one'], dryRun: false })).status, 410);
  assert.equal((await fetch(`${base}/execution/plans/${quickReview.reviewId}/assets/one-keep/thumbnail`)).status, 410);
  const endpoint = `/execution/quick-reviews/${quickReview.reviewId}/prepare-plan`;
  for (const body of [{ selectedGroupIds: [], executeLimit: 1 }, { selectedGroupIds: ['one'], executeLimit: 0 }, { selectedGroupIds: ['one'], executeLimit: 1, dryRun: false }]) assert.equal((await post(endpoint, body)).status, 400);
  const detailed = await post(endpoint, { selectedGroupIds: ['one'], executeLimit: 1 }); assert.equal(detailed.status, 200);
  const { plan } = await detailed.json(); assert.deepEqual(plan.candidates[0].proposedAlbumIds, ['missing']);
  assert.equal((await post(`/execution/plans/${plan.planId}/run`, { selectedGroupIds: ['one'], dryRun: false })).status, 409);
  assert.deepEqual(h.mutations, []);
});

test('quick streaming cancellation preserves a normal partial result while holding the coordinator lock', async (t) => {
  const h = executionHarness('one'); let release!: () => void, entered!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  h.client.getAssetDuplicates = async () => { reads++; entered(); await wait; return [structuredClone(h.raw)]; };
  const base = await serve(t, dependencies(t, { immich: h.client }));
  const response = await fetch(`${base}/execution/quick-reviews`, { method: 'POST', headers: { Accept: 'application/x-ndjson' } });
  const reader = response.body!.getReader(), decoder = new TextDecoder();
  let text = decoder.decode((await reader.read()).value);
  const event = JSON.parse(text.split('\n')[0]); await started;
  const cancel = await fetch(`${base}/execution/preparations/${event.progress.preparationId}/cancel`, { method: 'POST' });
  assert.equal(cancel.status, 200);
  assert.equal((await fetch(`${base}/execution/plans`, { method: 'POST' })).status, 409);
  release();
  for (;;) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); }
  const terminal = JSON.parse(text.trim().split('\n').at(-1)!);
  assert.equal(terminal.type, 'result'); assert.equal(terminal.result.status, 'cancelled');
  assert.equal(terminal.result.plan, null); assert.equal(terminal.result.quickReview.fetchedGroups, 0);
  assert.equal(reads, 1); assert.deepEqual(h.mutations, []);
});
