import { test, expect, type Page, type Route } from '@playwright/test';
import type { RunView, RunViewResponse } from '@immich-dedupe/shared';

const runId = '00000000-0000-4000-8000-000000000001';
const attemptId = '00000000-0000-4000-8000-000000000002';
const scope = { apiUrl: 'http://immich.invalid/api', accountId: 'fake-user' };
function runView(outcome: 'dry-run' | 'succeeded' | 'needs-verification' | 'failed' = 'dry-run'): RunView {
  const result = {
    runId, attemptId, groupId: 'photos', mode: outcome === 'dry-run' ? 'dry-run' as const : 'execute' as const,
    outcome, failureStage: outcome === 'needs-verification' ? 'verification' as const : outcome === 'failed' ? 'preflight' as const : null,
    keepAssetId: 'keeper', trashAssetId: 'loser', executed: outcome === 'succeeded',
    resolvedDuplicate: outcome === 'succeeded', trashedAsset: outcome === 'succeeded',
    proposedAlbumIds: ['family'], transferredAlbumIds: outcome === 'succeeded' || outcome === 'needs-verification' ? ['family'] : [], skippedAlbumIds: [],
    message: outcome === 'dry-run' ? 'Safety checks passed; changes simulated.' : 'Recorded resolution outcome.',
  };
  return {
    runId, startedAt: '2026-10-30T10:00:00.000Z', finishedAt: '2026-10-30T10:01:00.000Z', phase: 'finished',
    context: { dryRun: outcome === 'dry-run', scanLimit: 100, executeLimit: 5, source: 'batch', groupId: null },
    report: { fetchedGroups: 4, eligibleCount: 1, excludedGroups: [
      { groupId: 'old', reason: 'processed', attemptIds: [] }, { groupId: 'legacy', reason: 'legacy', attemptIds: [] },
      { groupId: 'blocked', reason: 'quarantined', attemptIds: [attemptId] },
    ], stoppedEarly: outcome === 'needs-verification' || outcome === 'failed', stopReason: outcome === 'needs-verification' ? 'Verification incomplete' : outcome === 'failed' ? 'Preflight rejected the pair' : null, requestError: null },
    attempts: [{ attemptId, groupId: 'photos', mode: result.mode, keepAssetId: 'keeper', trashAssetId: 'loser', result,
      lastStage: 'verification', confirmedAlbumIds: result.transferredAlbumIds,
      confirmedEffects: { loserTrashed: outcome === 'succeeded', loserUnlinked: outcome === 'succeeded', keeperUntrashed: outcome === 'succeeded' },
      recovery: outcome === 'needs-verification' ? 'quarantined' : 'closed', assessment: null }],
  };
}
function response(run: RunView | null): RunViewResponse { return { ok: true, scope, run }; }
function executionResponse(run: RunView) {
  return { ok: true, runId: run.runId, ...run.context, ...run.report,
    actuallyExecutedCount: 0, resolvedCount: 0, trashedCount: 0, results: run.attempts.flatMap((a) => a.result ? [a.result] : []) };
}
async function fakeApi(page: Page, initial: RunView | null = runView()) {
  const state = { latest: initial, previewFailure: false, calls: [] as string[] };
  await page.route('**/*', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    if (url.origin === 'http://127.0.0.1:4175') return route.fallback();
    if (url.origin !== 'http://fake-api.invalid') return route.abort();
    state.calls.push(`${request.method()} ${url.pathname}`);
    let json: unknown;
    switch (url.pathname) {
      case '/settings/status': json = { ok: true, status: 'connected', immichUrl: scope.apiUrl }; break;
      case '/execution/runs/latest': json = response(state.latest); break;
      case `/execution/runs/${runId}`: json = response(state.latest); break;
      case '/execution/status':
        if (state.previewFailure) return route.fulfill({ status: 500, json: { error: 'Preview unavailable' } });
        json = { ok: true, scanLimit: 100, duplicateCount: 4, scannedDuplicateCount: 4, executableCount: 1, logCount: 0, lastExecutionEntry: null }; break;
      case '/execution/plan': json = { ok: true, scanLimit: 100, fetchedGroups: 4, executableCount: 0, items: [] }; break;
      case '/analysis/duplicates': json = { ok: true, results: [], totalGroups: 4, autoResolveCount: 0, uncertainCount: 0, skipCount: 0 }; break;
      case '/execution/log': json = { ok: true, count: 0, data: [] }; break;
      case '/execution/recovery': json = { ok: true, health: 'ready', error: null, activeRunId: null, scope, items: [], total: 30, offset: 0, limit: 25 }; break;
      case `/execution/recovery/${attemptId}`: json = { ok: true, attempt: {
        attemptId, runId, groupId: 'photos', mode: 'execute', keepAssetId: 'keeper', trashAssetId: 'loser', startedAt: initial?.startedAt,
        checkpoints: [], result: runView('needs-verification').attempts[0].result,
        assessments: [{ checkedAt: '2026-10-30T11:00:00.000Z', classification: 'pair-intact', message: 'Pair is still intact.', evidence: [] }], releasedAt: null,
      } }; break;
      case '/settings/connection': json = { ok: true, immichUrl: scope.apiUrl, apiKey: 'fake-only' }; break;
      default: return route.fulfill({ status: 500, json: { error: `Unexpected fake request ${url.pathname}` } });
    }
    return route.fulfill({ json });
  });
  return state;
}
async function openDedupe(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dry run', exact: true })).toBeEnabled();
}
function summary(page: Page) { return page.getByRole('region', { name: 'Latest run results' }); }

test('summary counts, exclusions and keyboard details explain outcomes; restoration survives navigation and reload', async ({ page }) => {
  const state = await fakeApi(page, runView('succeeded')); await openDedupe(page);
  await expect(summary(page).getByText('Verified completed', { exact: true })).toBeVisible();
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Verified completed' }).locator('dd')).toHaveText('1');
  const details = page.getByText('Technical details for group photos', { exact: true });
  await details.focus(); await page.keyboard.press('Enter');
  await expect(page.getByText('family', { exact: true }).last()).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(summary(page)).toContainText(runId);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Welcome', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(summary(page)).toContainText(runId);
  expect(state.calls.filter((c) => c.startsWith('POST'))).toEqual([]);
});

test('dry-run results stay visible when the subsequent preview refresh fails', async ({ page }) => {
  const state = await fakeApi(page, null); await openDedupe(page);
  state.latest = runView(); state.previewFailure = true;
  await page.route('**/execution/run', (route) => route.fulfill({ json: executionResponse(runView()) }));
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Simulated' }).locator('dd')).toHaveText('1');
  await expect(page.getByRole('alert').filter({ hasText: 'Preview refresh failed' })).toBeVisible();
});

test('an in-flight request and its response survive navigation', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  let finish!: (route: Route) => Promise<void>;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<(route: Route) => Promise<void>>((resolve) => { finish = async (route) => { resolve(() => route.fulfill({ json: executionResponse(runView()) })); }; });
  let held!: Route;
  await page.route('**/execution/run', async (route) => { held = route; entered(); const fulfill = await waiting; await fulfill(route); });
  await page.getByRole('button', { name: 'Dry run', exact: true }).click(); await started;
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByText('Dry-run request in progress…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute', exact: true })).toBeDisabled();
  state.latest = runView(); await finish(held);
  await expect(summary(page)).toContainText('Safety checks passed; changes simulated.');
});

for (const status of [409, 503]) {
  test(`HTTP ${status} keeps prior results separate from a failed new request`, async ({ page }) => {
    await fakeApi(page, runView('succeeded')); await openDedupe(page);
    await page.route('**/execution/run', (route) => route.fulfill({ status, json: { code: status === 409 ? 'execution_busy' : 'identity_unavailable', error: 'New request rejected' } }));
    await page.getByRole('button', { name: 'Dry run', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: `HTTP ${status}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Previous recorded run' })).toBeVisible();
    await expect(page.getByText('Verified completed · Group photos')).toBeVisible();
  });
}

test('partial results survive a 503 and show confirmed album additions', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const partial = { ...executionResponse(runView('needs-verification')), ok: false };
  await page.route('**/execution/run', (route) => route.fulfill({ status: 503, json: { code: 'journal_unavailable', runId, error: 'Recovery evidence could not be persisted', partialExecution: partial } }));
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByText('Needs verification · Group photos')).toBeVisible();
  await page.getByText('Technical details for group photos', { exact: true }).click();
  await expect(page.getByText('family', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'recording failure' })).toBeVisible();
  state.latest = null;
});

test('lost live response reports unknown and never retries automatically', async ({ page }) => {
  const state = await fakeApi(page, runView('succeeded')); await openDedupe(page);
  let requests = 0;
  await page.route('**/execution/run', (route) => { requests++; return route.abort('failed'); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Outcome unknown' })).toBeVisible();
  expect(requests).toBe(1);
  expect(state.calls.filter((c) => c.includes('/recheck') || c.includes('/release'))).toEqual([]);
});

test('recovery links load an attempt outside the page and release requires confirmation', async ({ page }) => {
  await fakeApi(page, runView('needs-verification')); await openDedupe(page);
  await page.getByRole('button', { name: 'Review recovery' }).last().click();
  await expect(page.getByRole('heading', { name: 'Logs', exact: true })).toBeVisible();
  await expect(page.getByText(`Evidence for ${attemptId}`)).toBeVisible();
  await expect(page.locator('details[open]')).toBeFocused();
  let releases = 0;
  await page.route('**/release', (route) => { releases++; return route.fulfill({ status: 409, json: { error: 'Pair changed' } }); });
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: 'Allow new attempt', exact: true }).click(); expect(releases).toBe(0);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Allow new attempt', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'HTTP 409' })).toBeVisible(); expect(releases).toBe(1);
  await page.getByRole('button', { name: 'Back to results', exact: true }).click();
  await expect(summary(page)).toBeVisible();
});

test('legacy unknown fields and interrupted attempts are explained', async ({ page }) => {
  const old = runView(); old.context = null; old.report = null; old.phase = 'interrupted'; old.finishedAt = null;
  old.attempts[0].result = null; old.attempts[0].recovery = 'quarantined';
  await fakeApi(page, old); await openDedupe(page);
  await expect(summary(page)).toContainText('Mode not recorded');
  await expect(summary(page)).toContainText('Older journal record');
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Awaiting recorded result' }).locator('dd')).toHaveText('1');
});

test('settings describe actual effects and diagnostics omit credentials and invented performance settings', async ({ page }) => {
  await fakeApi(page); await page.goto('/'); await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Test and save', exact: true })).toBeVisible();
  await expect(page.getByText('Always enforced by the backend')).toBeVisible();
  await expect(page.getByLabel('Batch Size', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox')).toHaveCount(1);
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Clear form', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export Diagnostics', exact: true }).click();
  const download = await downloadPromise; const stream = await download.createReadStream();
  const chunks: Buffer[] = []; for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
  const diagnostics = JSON.parse(Buffer.concat(chunks).toString());
  expect(diagnostics).not.toHaveProperty('performance'); expect(diagnostics.connection).not.toHaveProperty('apiKey');
  expect(diagnostics.browserPreferences).toEqual({ requireConfirmation: true });
});

test('narrow screens retain navigation and readable outcome cards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await fakeApi(page, runView('needs-verification')); await openDedupe(page);
  await expect(page.getByRole('button', { name: 'Logs', exact: true })).toBeVisible();
  await expect(summary(page)).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/outcomes-mobile.png', fullPage: true });
});

test('refreshing the latest journal cannot erase unsaved partial results', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const partial = { ...executionResponse(runView('needs-verification')), ok: false };
  await page.route('**/execution/run', (route) => route.fulfill({ status: 503, json: { code: 'journal_unavailable', runId, error: 'Checkpoint failed', partialExecution: partial } }));
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Partial results returned by the API' })).toBeVisible();
  state.latest = null;
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click();
  await expect(page.getByText('Needs verification · Group photos')).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByText('Needs verification · Group photos')).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByText('No recorded run loaded.')).toBeVisible();
});

test('an account change clears partial evidence from the previous scope', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  await page.route('**/execution/run', (route) => route.fulfill({ status: 503, json: {
    code: 'journal_unavailable', error: 'Checkpoint failed', partialExecution: { ...executionResponse(runView('needs-verification')), ok: false },
  } }));
  await page.getByRole('button', { name: 'Dry run', exact: true }).click();
  await expect(page.getByText('Needs verification · Group photos')).toBeVisible();
  await page.route('**/execution/runs/latest', (route) => route.fulfill({ json: { ok: true, scope: { ...scope, accountId: 'other' }, run: null } }));
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Latest run results' })).toBeVisible();
  await expect(page.getByText('No recorded run loaded.')).toBeVisible();
  await expect(page.getByText('Needs verification · Group photos')).toHaveCount(0);
});

test('late reads cannot overwrite newer latest evidence from another tab', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let reads = 0;
  const newer = { ...runView('succeeded'), runId: '00000000-0000-4000-8000-000000000099' };
  await page.route('**/execution/runs/latest', async (route) => {
    if (++reads === 1) { entered(); await held; return route.fulfill({ json: response(runView()) }); }
    return route.fulfill({ json: response(newer) });
  });
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click(); await started;
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(summary(page)).toContainText(newer.runId);
  const oldResponse = page.waitForResponse('**/execution/runs/latest'); release(); await oldResponse;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(summary(page)).toContainText(newer.runId);
});

test('lost live-response warning survives refresh of an older run', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  await page.route('**/execution/run', (route) => route.abort('failed'));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Execute', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Outcome unknown' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Outcome unknown' })).toBeVisible();
});


test('failed preflight and an empty completed run never imply successful cleanup', async ({ page }) => {
  const state = await fakeApi(page, runView('failed')); await openDedupe(page);
  await expect(page.getByText('Failed · Group photos')).toBeVisible();
  await expect(page.getByText('Stopped during: Fresh safety checks')).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'Batch stopped: Preflight rejected the pair' })).toBeVisible();
  state.latest = { ...runView(), attempts: [] };
  await page.getByRole('button', { name: 'Refresh latest', exact: true }).click();
  await expect(page.getByText('No groups were attempted in this run.')).toBeVisible();
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Verified completed' }).locator('dd')).toHaveText('0');
});

test('active runs and closed recovery links offer current facts without repeating actions', async ({ page }) => {
  const active = runView('needs-verification'); active.phase = 'running'; active.finishedAt = null; active.report = null;
  await fakeApi(page, active); await openDedupe(page);
  await expect(page.getByRole('status').filter({ hasText: 'still active' })).toBeVisible();
  const detail = {
    attemptId, runId, groupId: 'photos', mode: 'execute', keepAssetId: 'keeper', trashAssetId: 'loser',
    startedAt: active.startedAt, checkpoints: [], result: active.attempts[0].result,
    assessments: [{ checkedAt: active.startedAt, classification: 'verified-resolved', message: 'Resolution verified.', evidence: [] }], releasedAt: null,
  };
  await page.route(`**/execution/recovery/${attemptId}`, (route) => route.fulfill({ json: { ok: true, attempt: detail } }));
  await page.getByRole('button', { name: 'Review recovery' }).last().click();
  await expect(page.getByText('This attempt is verified resolved. Earlier evidence is preserved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Recheck outcome', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Allow new attempt', exact: true })).toHaveCount(0);
});
