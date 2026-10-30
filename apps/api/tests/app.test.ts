import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createApp, type AppDependencies } from '../src/app';
import { fakeImmich, rawGroup, rawAsset, album, temporaryLog } from './fixtures';

function dependencies(t: TestContext, overrides: Partial<AppDependencies> = {}): AppDependencies {
  const groups = [rawGroup('one'), rawGroup('two'), rawGroup('three')];
  return {
    config: { IMMICH_URL: 'http://immich.invalid/api', IMMICH_API_KEY: 'test-only' },
    log: temporaryLog(t),
    fetch: async () => { throw new Error('Unexpected external fetch'); },
    saveConnection: () => { throw new Error('Unexpected settings write'); },
    immich: fakeImmich({
      getAssetDuplicates: async () => groups,
      getAssetInfo: async ({ id }) => rawAsset(id, { exifInfo: { fileSizeInByte: id.endsWith('keep') ? 200 : 100 } }),
      getAllAlbums: async () => [],
    }),
    ...overrides,
  };
}

async function serve(t: TestContext, deps: AppDependencies) {
  const app = createApp(deps);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise<void>((resolve, reject) => {
    server.close((err) => err ? reject(err) : resolve());
    server.closeAllConnections();
  }));
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

test('app factory works without environment variables, SDK initialization, storage access or listening', () => {
  const unexpected = () => { throw new Error('Unexpected dependency access'); };
  const app = createApp({
    config: { IMMICH_URL: '', IMMICH_API_KEY: '' }, immich: fakeImmich(),
    log: { loadExecutionLog: unexpected, appendExecutionLog: unexpected, clearExecutionLog: unexpected,
      getProcessedGroupIds: unexpected, getExecutionLogPath: unexpected },
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
  deps.immich.getAllAlbums = async () => [album('missing', [raw.assets[1]])];
  deps.immich.getAlbumInfo = async () => album('missing', [raw.assets[1]]);
  const base = await serve(t, deps);
  const preview = await (await fetch(`${base}/execution/duplicates/one/preview`)).json();
  assert.equal(preview.executable, true);
  assert.deepEqual(preview.preview.albumsToTransfer, [{ albumId: 'missing', albumName: 'missing' }]);
  const execution = await (await fetch(`${base}/execution/duplicates/one`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"dryRun":true}',
  })).json();
  assert.equal(execution.execution.executed, false);
  assert.deepEqual(execution.execution.transferredAlbumIds, ['missing']);
  assert.equal(deps.log.loadExecutionLog().length, 0, 'single-group logging is unchanged in PR 1');
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
