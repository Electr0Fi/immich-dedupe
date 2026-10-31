import { consumeReviewPreparation } from '../src/reviewPreparationStream';
import { test, expect, type Page, type Route } from '@playwright/test';
import type { RunView, RunViewResponse, RulesState, SaveRulePresetRequest } from '@immich-dedupe/shared';

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
function reviewPlan(scanLimit = 100, executeLimit = 5) {
  const asset = (id: string, external: boolean) => ({ id, duplicateId: 'photos', fileName: 'photo.jpg', originalPath: external ? '/external/photo.jpg' : '/photos/internal/photo.jpg',
    checksum: 'checksum', assetType: 'IMAGE', width: 3000, height: 2000, fileSize: external ? 200 : 100,
    isEdited: false, isTrashed: false, isFavorite: false, isArchived: false, isOffline: false, livePhotoVideoId: null,
    isExternal: external, isInternal: !external, albums: external ? [] : [{ albumId: 'family', albumName: 'Family' }] });
  return { planId: runId, scope, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString(), scanLimit, executeLimit, fetchedGroups: 4, totalGroups: 4,
    candidates: [{ groupId: 'photos', keepAsset: asset('keeper', true), trashAsset: asset('loser', false),
      decision: { groupId: 'photos', status: 'auto-resolve', keepAssetId: 'keeper', trashAssetIds: ['loser'], confidence: 100, matchedRuleId: 'rule', matchedRuleName: 'Keep larger external', reasons: ['Matching filenames and dimensions'] },
      requiredAlbumIds: ['family'], proposedAlbumIds: ['family'], skippedAlbumIds: [] }],
    excludedGroups: [{ groupId: 'old', reason: 'processed', message: 'Already processed', attemptIds: [] }] };
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
      case '/execution/plans': { const input = request.postDataJSON(); json = { ok: true, plan: reviewPlan(input.scanLimit, input.executeLimit) }; break; }
      case '/execution/quick-reviews': { const input = request.postDataJSON(); json = { ok: true, quickReview: quickReviewFixture(8, input.scanLimit, input.executeLimit) }; break; }
      case `/execution/plans/${runId}/run`: json = executionResponse(state.latest ?? runView()); break;
      case `/execution/plans/${runId}/assets/keeper/thumbnail`:
      case `/execution/plans/${runId}/assets/loser/thumbnail`: return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aT8sAAAAASUVORK5CYII=', 'base64') });
      case '/settings/status': json = { ok: true, status: 'connected', immichUrl: scope.apiUrl }; break;
      case '/execution/scan/pending': json = { ok: true, pending: [], summary: { rulesetRevision: 'rules-1', totalGroups: 4, visitedGroups: 0, remainingGroups: 4, excludedGroups: 0, deferredGroups: 0, blockedGroups: 0, pendingCandidates: 0, updatedAt: new Date().toISOString() } }; break;
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
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
}
function summary(page: Page) { return page.getByRole('region', { name: 'Latest run results' }); }

test('summary counts, exclusions and keyboard details explain outcomes; restoration survives navigation and reload', async ({ page }) => {
  const state = await fakeApi(page, runView('succeeded')); await openDedupe(page);
  await expect(summary(page).getByText('Verified completed', { exact: true })).toBeVisible();
  const info = page.getByRole('button', { name: 'About Verified completed', exact: true });
  await info.hover();
  await expect(page.getByRole('tooltip')).toHaveText('Album preservation and resolution were confirmed.');
  await page.getByRole('heading', { name: 'Dedupe', exact: true }).hover();
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await info.focus();
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
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
  expect(state.calls.filter((c) => c.startsWith('POST') && !c.endsWith('/execution/plans'))).toEqual([]);
});

test('dry-run results stay visible when the subsequent preview refresh fails', async ({ page }) => {
  const state = await fakeApi(page, null); await openDedupe(page);
  state.latest = runView(); state.previewFailure = true;
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ json: executionResponse(runView()) }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Simulated' }).locator('dd')).toHaveText('1');
  await expect(page.getByRole('alert').filter({ hasText: 'Preview refresh failed' })).toBeVisible();
});

test('preview network failures can be retried without repeating execution or losing review approval', async ({ page }) => {
  const state = await fakeApi(page, null); await openDedupe(page);
  state.latest = runView();
  let disconnected = true;
  await page.route('**/execution/status?*', (route) => disconnected ? route.abort('failed') : route.fallback());
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Preview refresh failed' });
  await expect(alert).toContainText('Cannot reach the Dedupe API');
  await expect(alert).toContainText('Use Refresh previews to try again');
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Simulated' }).locator('dd')).toHaveText('1');
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  const posts = state.calls.filter((call) => call.startsWith('POST'));
  disconnected = false;
  await page.getByRole('button', { name: 'Refresh previews', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  await expect(summary(page).locator('dl.stats > div').filter({ hasText: 'Simulated' }).locator('dd')).toHaveText('1');
  expect(state.calls.filter((call) => call.startsWith('POST'))).toEqual(posts);
});

test('an initial preview connection failure recovers with an explicit refresh', async ({ page }) => {
  const state = await fakeApi(page);
  let disconnected = true;
  await page.route('**/execution/status?*', (route) => disconnected ? route.abort('failed') : route.fallback());
  await page.goto('/');
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Preview refresh failed' });
  await expect(alert).toContainText('Cannot reach the Dedupe API');
  disconnected = false;
  await page.getByRole('button', { name: 'Refresh previews', exact: true }).click();
  await expect(alert).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Status', exact: true }).locator('..')).toContainText('Total Duplicates');
  expect(state.calls.filter((call) => call.startsWith('POST'))).toEqual([]);
});

test('an in-flight request and its response survive navigation', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  let finish!: (route: Route) => Promise<void>;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const waiting = new Promise<(route: Route) => Promise<void>>((resolve) => { finish = async (route) => { resolve(() => route.fulfill({ json: executionResponse(runView()) })); }; });
  let held!: Route;
  await page.route('**/execution/plans/*/run', async (route) => { held = route; entered(); const fulfill = await waiting; await fulfill(route); });
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click(); await started;
  await expect(page.getByRole('button', { name: 'Running dry run…', exact: true })).toBeDisabled();
  await expect(page.getByRole('status').filter({ hasText: 'Dry run in progress… No Immich assets will be changed.' })).toBeVisible();
  await expect(page.locator('.dedupe-activity .spinner')).toBeVisible();
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByText('Dry-run request in progress…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  state.latest = runView(); await finish(held);
  await expect(summary(page)).toContainText('Safety checks passed; changes simulated.');
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
  await expect(page.locator('.dedupe-activity .spinner')).toHaveCount(0);
});

for (const status of [409, 503]) {
  test(`HTTP ${status} keeps prior results separate from a failed new request`, async ({ page }) => {
    await fakeApi(page, runView('succeeded')); await openDedupe(page);
    await page.route('**/execution/plans/*/run', (route) => route.fulfill({ status, json: { code: status === 409 ? 'execution_busy' : 'identity_unavailable', error: 'New request rejected' } }));
    await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: `HTTP ${status}` })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Previous recorded run' })).toBeVisible();
    await expect(page.getByText('Verified completed · Group photos')).toBeVisible();
  });
}

test('partial results survive a 503 and show confirmed album additions', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const partial = { ...executionResponse(runView('needs-verification')), ok: false };
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ status: 503, json: { code: 'journal_unavailable', runId, error: 'Recovery evidence could not be persisted', partialExecution: partial } }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByText('Needs verification · Group photos')).toBeVisible();
  await page.getByText('Technical details for group photos', { exact: true }).click();
  await expect(page.getByText('family', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'recording failure' })).toBeVisible();
  state.latest = null;
});

test('lost live response reports unknown and never retries automatically', async ({ page }) => {
  const state = await fakeApi(page, runView('succeeded')); await openDedupe(page);
  let requests = 0;
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ json: executionResponse(runView()) }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  await page.route('**/execution/plans/*/run', (route) => { requests++; return route.abort('failed'); });
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Execute selected', exact: true }).click();
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
  const review = page.getByRole('region', { name: 'Review exactly what will run', exact: true });
  await review.screenshot({ path: 'test-results/review-mobile.png' });
});

test('refreshing the latest journal cannot erase unsaved partial results', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const partial = { ...executionResponse(runView('needs-verification')), ok: false };
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ status: 503, json: { code: 'journal_unavailable', runId, error: 'Checkpoint failed', partialExecution: partial } }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
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
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ status: 503, json: {
    code: 'journal_unavailable', error: 'Checkpoint failed', partialExecution: { ...executionResponse(runView('needs-verification')), ok: false },
  } }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
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
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ json: executionResponse(runView()) }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  await page.route('**/execution/plans/*/run', (route) => route.abort('failed'));
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Execute selected', exact: true }).click();
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

test('review compares image metadata and named album changes, requires exact dry-run and resets approval on selection change', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const review = page.getByRole('region', { name: 'Review exactly what will run', exact: true });
  await expect(review.getByRole('heading', { name: 'Keep', exact: true })).not.toBeVisible();
  await review.getByRole('button', { name: 'Details for group photos', exact: true }).click();
  await expect(review.getByRole('heading', { name: 'Keep', exact: true })).toBeVisible();
  await expect(review.getByRole('heading', { name: 'Move to trash', exact: true })).toBeVisible();
  await expect(review.locator('.asset-facts').getByText('/external/photo.jpg', { exact: true })).toBeVisible();
  await expect(review.getByText('200 bytes', { exact: true })).toBeVisible();
  await review.screenshot({ path: 'test-results/review-desktop.png' });
  await expect(review.getByText('Proposed additions to keeper: Family', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Include group photos', exact: true }).uncheck();
  await expect(review).toContainText('0 groups selected');
  await page.getByRole('checkbox', { name: 'Include group photos', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  expect(state.calls.filter((c) => c === 'POST /execution/run')).toEqual([]);
});

test('changing limits discards the review and navigation preserves its selection until reload', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  await page.getByRole('checkbox', { name: 'Include group photos', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Logs', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).not.toBeChecked();
  await page.getByLabel('Scan Limit', { exact: true }).fill('20');
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).toHaveCount(0);
});

test('thumbnail access failures show placeholders without blocking simulation', async ({ page }) => {
  await fakeApi(page);
  await page.route('**/thumbnail', (route) => route.fulfill({ status: 502, json: { error: 'Thumbnail unavailable' } }));
  await openDedupe(page);
  await page.getByRole('button', { name: 'Details for group photos', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Thumbnail unavailable for photo.jpg' }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
});

test('expired and rejected reviews require rebuilding and cannot execute', async ({ page }) => {
  await fakeApi(page); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan: { ...reviewPlan(), expiresAt: new Date(Date.now() - 1000).toISOString() } } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This review expired' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
  await page.unroute('**/execution/plans');
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
  await page.route('**/execution/plans/*/run', (route) => route.fulfill({ status: 409, json: { code: 'plan_changed', error: 'Reviewed data changed', changedGroups: [{ groupId: 'photos', reasons: ['Keeper metadata changed'] }] } }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Keeper metadata changed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
});

test('live confirmation names the exact group and album counts and cancellation sends no request', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  let calls = 0;
  await page.route('**/execution/plans/*/run', (route) => { calls++; return route.fulfill({ json: executionResponse(runView()) }); });
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  page.once('dialog', (dialog) => { expect(dialog.message()).toContain('exactly 1 reviewed groups with 1 proposed album additions'); return dialog.dismiss(); });
  await page.getByRole('button', { name: 'Execute selected', exact: true }).click(); expect(calls).toBe(1);
});

test('selection limit is enforced without backfilling a deselected group', async ({ page }) => {
  await fakeApi(page); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const plan = reviewPlan(100, 1); const first = plan.candidates[0];
  plan.candidates.push({ ...first, groupId: 'other', keepAsset: { ...first.keepAsset, id: 'other-keeper' }, trashAsset: { ...first.trashAsset, id: 'other-loser' } });
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  const firstCheck = page.getByRole('checkbox', { name: 'Include group photos', exact: true });
  const otherCheck = page.getByRole('checkbox', { name: 'Include group other', exact: true });
  await expect(firstCheck).toBeChecked(); await expect(otherCheck).not.toBeChecked(); await expect(otherCheck).toBeDisabled();
  await firstCheck.uncheck(); await expect(otherCheck).not.toBeChecked(); await expect(otherCheck).toBeEnabled();
  await otherCheck.check(); await expect(firstCheck).not.toBeChecked(); await expect(firstCheck).toBeDisabled();
});

type PreparationTestWindow = Window & { preparationTest: {
  push: (event: unknown) => void; raw: (text: string) => void; finish: () => void;
  cancelCalls: number; rejectCancel: boolean;
} };
async function startStreamedPreparation(page: Page, quick = false) {
  const state = await fakeApi(page, null);
  await page.goto('/');
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  await page.evaluate(() => {
    const original = window.fetch.bind(window);
    let controller: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const harness = {
      push: (event: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`)),
      raw: (text: string) => controller.enqueue(encoder.encode(text)),
      finish: () => controller.close(), cancelCalls: 0, rejectCancel: false,
    };
    (window as unknown as PreparationTestWindow).preparationTest = harness;
    window.fetch = async (input, init) => {
      if ((String(input).endsWith('/execution/plans') || String(input).endsWith('/execution/quick-reviews')) && init?.method === 'POST') {
        return new Response(new ReadableStream<Uint8Array>({ start(c) { controller = c; } }), { headers: { 'Content-Type': 'application/x-ndjson' } });
      }
      if (String(input).includes('/execution/preparations/') && String(input).endsWith('/cancel')) {
        harness.cancelCalls++;
        if (harness.rejectCancel) throw new TypeError('Network unavailable');
        return new Response(JSON.stringify({ ok: true, status: 'cancelling' }), { headers: { 'Content-Type': 'application/json' } });
      }
      return original(input, init);
    };
  });
  if (quick) await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).check();
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel review', exact: true })).toBeEnabled();
  return state;
}
async function pushProgress(page: Page, checkedGroups = 1) {
  await page.evaluate(({ runId, checkedGroups }) => {
    (window as unknown as PreparationTestWindow).preparationTest.push({ type: 'progress', progress: {
      preparationId: runId, stage: 'checking-albums', checkedGroups, targetGroups: 100, eligibleGroups: checkedGroups, excludedGroups: 0,
    } });
  }, { runId, checkedGroups });
}
async function finishPreparation(page: Page, status: 'completed' | 'cancelled', empty = false) {
  const plan = empty ? null : { ...reviewPlan(), fetchedGroups: 1, totalGroups: 100, excludedGroups: [], preparation: { status, checkedGroups: 1, targetGroups: 100 } };
  await page.evaluate(({ status, plan }) => {
    const harness = (window as unknown as PreparationTestWindow).preparationTest;
    harness.push({ type: 'result', result: { status, plan } }); harness.finish();
  }, { status, plan });
}

test('review progress, elapsed time and cancellation survive navigation; completed groups remain usable', async ({ page }) => {
  await startStreamedPreparation(page);
  await pushProgress(page);
  await expect(page.getByText('Checking album memberships', { exact: true })).toBeVisible();
  await expect(page.getByText('1 of 100 groups checked · 1 eligible · 0 excluded')).toBeVisible();
  await expect(page.getByRole('progressbar', { name: 'Review groups checked' })).toHaveAttribute('value', '1');
  await expect(page.getByText(/Elapsed [1-9]\d*s/)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByText('1 of 100 groups checked · 1 eligible · 0 excluded')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancelling…', exact: true })).toBeDisabled();
  await expect.poll(() => page.evaluate(() => (window as unknown as PreparationTestWindow).preparationTest.cancelCalls)).toBe(1);
  await finishPreparation(page, 'cancelled');
  await expect(page.getByText('Review cancelled. 1 of 100 groups checked; completed results are available below.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: 'Include group photos' })).toBeChecked();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
});

test('an immediate cancellation is queued until the preparation ID arrives and zero results is normal', async ({ page }) => {
  await startStreamedPreparation(page);
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as PreparationTestWindow).preparationTest.cancelCalls)).toBe(0);
  await pushProgress(page, 0);
  await expect.poll(() => page.evaluate(() => (window as unknown as PreparationTestWindow).preparationTest.cancelCalls)).toBe(1);
  await finishPreparation(page, 'cancelled', true);
  await expect(page.getByText('Review cancelled before any groups were checked.')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
});

test('cancellation transport failure allows another cancellation without losing progress', async ({ page }) => {
  await startStreamedPreparation(page); await pushProgress(page);
  await page.evaluate(() => { (window as unknown as PreparationTestWindow).preparationTest.rejectCancel = true; });
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Cancellation could not be confirmed');
  await expect(page.getByRole('button', { name: 'Cancel review', exact: true })).toBeEnabled();
  await expect(page.getByText('1 of 100 groups checked · 1 eligible · 0 excluded')).toBeVisible();
  await page.evaluate(() => { (window as unknown as PreparationTestWindow).preparationTest.rejectCancel = false; });
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await finishPreparation(page, 'cancelled');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('completion winning a cancellation race retains the finished review', async ({ page }) => {
  await startStreamedPreparation(page); await pushProgress(page);
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  await finishPreparation(page, 'completed');
  await expect(page.getByText('The review finished before cancellation took effect. All completed results are available below.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
});

test('streamed terminal errors and truncation do not install a partial review', async ({ page }) => {
  await startStreamedPreparation(page); await pushProgress(page);
  await page.evaluate(() => {
    const h = (window as unknown as PreparationTestWindow).preparationTest;
    h.push({ type: 'error', status: 503, code: 'preflight_unavailable', error: 'Fresh data unavailable' }); h.finish();
  });
  await expect(page.getByRole('alert')).toContainText('Fresh data unavailable');
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await pushProgress(page);
  await page.evaluate(() => (window as unknown as PreparationTestWindow).preparationTest.finish());
  await expect(page.getByRole('alert')).toContainText('response was incomplete');
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
});

test('stream parser handles arbitrary byte boundaries including split UTF-8 characters', async () => {
  const text = JSON.stringify({ type: 'error', status: 503, code: 'test', error: 'Album “Família” unavailable' }) + '\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } });
  expect(await consumeReviewPreparation(body, () => undefined)).toEqual({ type: 'error', status: 503, code: 'test', error: 'Album “Família” unavailable' });
});

function streamBody(text: string) {
  return new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } });
}
test('stream parser rejects missing terminals, malformed events and post-terminal data', async () => {
  for (const text of ['', '{"type":"result"}', '{broken}\n', '{"type":"progress","progress":{}}\n', '{"type":"result","result":{"status":"completed","plan":null}}\n']) {
    await expect(consumeReviewPreparation(streamBody(text), () => undefined)).rejects.toThrow();
  }
  const terminal = JSON.stringify({ type: 'result', result: { status: 'cancelled', plan: null } }) + '\n';
  await expect(consumeReviewPreparation(streamBody(terminal + terminal), () => undefined)).rejects.toThrow('Unexpected data');
  expect(await consumeReviewPreparation(streamBody(terminal), () => undefined)).toEqual({ type: 'result', result: { status: 'cancelled', plan: null } });
});

function reviewWithCandidates(executeLimit: number, count: number) {
  const plan = reviewPlan(100, executeLimit);
  const first = plan.candidates[0];
  plan.candidates = Array.from({ length: count }, (_, i) => ({ ...structuredClone(first), groupId: `group-${i}`,
    keepAsset: { ...first.keepAsset, id: `keeper-${i}`, duplicateId: `group-${i}` },
    trashAsset: { ...first.trashAsset, id: `loser-${i}`, duplicateId: `group-${i}` },
    decision: { ...first.decision, groupId: `group-${i}`, keepAssetId: `keeper-${i}`, trashAssetIds: [`loser-${i}`] },
  }));
  plan.totalGroups = count + 1; plan.fetchedGroups = count + 1;
  return plan;
}

test('Select first follows the entered Execute Limit and Select All explicitly expands the reviewed batch', async ({ page }) => {
  await fakeApi(page, null);
  await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await page.getByLabel('Execute Limit', { exact: true }).fill('2');
  let original = reviewWithCandidates(2, 4);
  let prepareCalls = 0, selectAllCalls = 0;
  await page.route('**/execution/plans', (route) => {
    prepareCalls++;
    expect(route.request().postDataJSON().executeLimit).toBe(2);
    original = reviewWithCandidates(2, 4);
    return route.fulfill({ json: { ok: true, plan: original } });
  });
  const expanded = { ...original, planId: attemptId, executeLimit: 4 };
  await page.route(`**/execution/plans/${runId}/select-all`, (route) => {
    selectAllCalls++;
    return route.fulfill({ json: { ok: true, plan: { ...expanded, expiresAt: original.expiresAt } } });
  });
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select first 2', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('button', { name: 'Select first 2', exact: true }).click();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(4);
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('button', { name: 'Select first 4', exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Execute Limit increased from 2 to 4' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
  expect(prepareCalls).toBe(1); expect(selectAllCalls).toBe(1);
  let dryRunCalls = 0;
  await page.route(`**/execution/plans/${attemptId}/run`, (route) => {
    dryRunCalls++;
    expect(route.request().postDataJSON()).toEqual({ selectedGroupIds: ['group-0', 'group-1', 'group-2', 'group-3'], dryRun: true });
    const view = runView(); const firstAttempt = view.attempts[0];
    view.context = { ...view.context!, executeLimit: 4 };
    view.report = { ...view.report!, eligibleCount: 4, fetchedGroups: 4, excludedGroups: [] };
    view.attempts = expanded.candidates.map((candidate, i) => ({ ...firstAttempt, attemptId: `attempt-${i}`, groupId: candidate.groupId,
      result: { ...firstAttempt.result!, groupId: candidate.groupId, keepAssetId: candidate.keepAsset.id, trashAssetId: candidate.trashAsset.id } }));
    return route.fulfill({ json: { ...executionResponse(view), planId: attemptId } });
  });
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  expect(dryRunCalls).toBe(1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('4');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(4);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(4);
  expect(selectAllCalls).toBe(1);
});

test('Select All clears existing dry-run approval even when every candidate already fits the limit', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Include group photos' })).toBeChecked();
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('5');
  expect(state.calls.some((call) => call.endsWith('/select-all'))).toBe(false);
});

test('Select All failure preserves the existing review and selection for an explicit retry', async ({ page }) => {
  await fakeApi(page, null); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const plan = reviewWithCandidates(1, 3);
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan } }));
  await page.route(`**/execution/plans/${runId}/select-all`, (route) => route.fulfill({ status: 409, json: { code: 'execution_busy', error: 'Another request is running' } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Another request is running');
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Select All', exact: true })).toBeEnabled();
});

test('review groups start collapsed and keyboard toggles reveal only their own details', async ({ page }) => {
  await fakeApi(page); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const plan = reviewWithCandidates(5, 2);
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  const first = page.getByRole('article', { name: 'Review group group-0', exact: true });
  const second = page.getByRole('article', { name: 'Review group group-1', exact: true });
  const toggle = first.getByRole('button', { name: 'Details for group group-0', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(first.getByRole('checkbox')).toBeVisible();
  await expect(first.getByRole('heading', { name: 'Keep', exact: true })).not.toBeVisible();
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(first.getByRole('heading', { name: 'Keep', exact: true })).toBeVisible();
  await expect(second.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(second.getByRole('heading', { name: 'Keep', exact: true })).not.toBeVisible();
  const controls = await toggle.getAttribute('aria-controls');
  await expect(page.locator(`[id="${controls}"]`)).toBeVisible();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(first.getByRole('heading', { name: 'Keep', exact: true })).not.toBeVisible();
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(2);
});

test('Expand All and Collapse All include excluded groups without changing selection or dry-run approval', async ({ page }) => {
  const state = await fakeApi(page); await openDedupe(page);
  const toggle = page.getByRole('button', { name: 'Details for group photos', exact: true });
  const excluded = page.getByRole('button', { name: 'Details for group old', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(excluded).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  const execute = page.getByRole('button', { name: 'Execute selected', exact: true });
  await expect(execute).toBeEnabled();
  const calls = [...state.calls];
  await page.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(excluded).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByText('Already processed', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Keep', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Collapse All', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(excluded).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByText('Already processed', { exact: true })).not.toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include group photos', exact: true })).toBeChecked();
  await expect(execute).toBeEnabled();
  // Disclosure changes never submit mutations or preparation/selection requests. Thumbnail reads may load on expansion.
  expect(state.calls.filter((call) => call.startsWith('POST'))).toEqual(calls.filter((call) => call.startsWith('POST')));
  await page.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan: { ...reviewPlan(), planId: attemptId } } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

test('empty reviews disable bulk disclosure controls and small screens retain group toggles', async ({ page }) => {
  await fakeApi(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const plan = { ...reviewPlan(), candidates: [], excludedGroups: [] };
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Expand All', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Collapse All', exact: true })).toBeDisabled();
  await page.unroute('**/execution/plans');
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await page.getByRole('button', { name: 'Details for group photos', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Keep', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse All', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('missing Select All route gives restart guidance and preserves the existing review', async ({ page }) => {
  await fakeApi(page, null); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  const plan = reviewWithCandidates(1, 3);
  await page.route('**/execution/plans', (route) => route.fulfill({ json: { ok: true, plan } }));
  let calls = 0;
  await page.route(`**/execution/plans/${runId}/select-all`, (route) => {
    calls++;
    return route.fulfill({ status: 404, contentType: 'text/html', body: '<html>Cannot POST select-all</html>' });
  });
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Restart the API from the current project checkout');
  await expect(page.getByRole('alert')).toContainText('/select-all');
  await expect(page.getByRole('checkbox', { checked: true })).toHaveCount(1);
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('1');
  await expect(page.getByRole('button', { name: 'Select All', exact: true })).toBeEnabled();
  expect(calls).toBe(1);
});

function quickReviewFixture(count = 8, scanLimit = 100, executeLimit = 5) {
  const full = reviewWithCandidates(executeLimit, count);
  const candidates = full.candidates.map((candidate) => {
    const keepAsset = { ...candidate.keepAsset }, trashAsset = { ...candidate.trashAsset };
    Reflect.deleteProperty(keepAsset, 'albums'); Reflect.deleteProperty(trashAsset, 'albums');
    return { groupId: candidate.groupId, keepAsset, trashAsset, decision: candidate.decision };
  });
  return { reviewId: runId, scope, scanLimit, executeLimit, createdAt: full.createdAt, expiresAt: full.expiresAt,
    fetchedGroups: count + 1, totalGroups: count + 1, candidates, excludedGroups: full.excludedGroups,
    preparation: { status: 'completed', checkedGroups: count + 1, targetGroups: count + 1 } };
}
function previewCalls(calls: string[]) { return calls.filter((call) => /^GET \/(execution\/(status|plan)|analysis\/duplicates)$/.test(call)); }

test('Quick Review skips images and legacy refreshes, supports Select All and loads only the selected details', async ({ page }) => {
  const state = await fakeApi(page, null); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  const before = previewCalls(state.calls);
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).check();
  await page.getByLabel('Scan Limit', { exact: true }).fill('1000');
  await expect(page.getByRole('button', { name: 'Refresh previews', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toBeVisible();
  await page.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(page.locator('.review-thumbnail')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  expect(previewCalls(state.calls)).toEqual(before);
  expect(state.calls.some((call) => call.includes('/thumbnail'))).toBe(false);
  await page.getByRole('button', { name: 'Select All', exact: true }).click();
  await expect(page.getByLabel('Execute Limit', { exact: true })).toHaveValue('8');
  await expect(page.getByRole('checkbox', { name: /^Include group/, checked: true })).toHaveCount(8);
  expect(state.calls.some((call) => call.endsWith('/select-all'))).toBe(false);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Include group group-0', exact: true }).check();
  const detailed = reviewWithCandidates(8, 1); detailed.planId = attemptId;
  await page.route(`**/execution/quick-reviews/${runId}/prepare-plan`, (route) => {
    expect(route.request().postDataJSON()).toEqual({ selectedGroupIds: ['group-0'], executeLimit: 8 });
    return route.fulfill({ json: { ok: true, plan: detailed } });
  });
  await page.getByRole('button', { name: 'Load selected details', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Details for group group-0', exact: true }).click();
  await expect(page.getByText('Proposed additions to keeper: Family', { exact: true })).toBeVisible();
  state.latest = runView();
  await page.route(`**/execution/plans/${attemptId}/run`, (route) => route.fulfill({ json: { ...executionResponse(state.latest!), planId: attemptId } }));
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  expect(previewCalls(state.calls)).toEqual(before);
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: /^Include group/ })).toHaveCount(0);
});

test('Quick Review keeps unverified groups excluded and preserves provisional selection on detail-loading failure', async ({ page }) => {
  await fakeApi(page, null); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).check();
  const snapshot = quickReviewFixture(2);
  snapshot.excludedGroups.push({ groupId: 'missing-size', reason: 'unverified', attemptIds: [], message: 'Not verified in Quick Review: missing file size. Extra reads were skipped.' });
  snapshot.fetchedGroups++; snapshot.totalGroups++; snapshot.preparation.checkedGroups++; snapshot.preparation.targetGroups++;
  await page.route('**/execution/quick-reviews', (route) => route.fulfill({ json: { ok: true, quickReview: snapshot } }));
  await page.route(`**/execution/quick-reviews/${runId}/prepare-plan`, (route) => route.fulfill({ status: 409, json: { code: 'plan_changed', error: 'Selected quick results changed; prepare a new review', changedGroups: [{ groupId: 'group-0', reasons: ['Keeper metadata changed since Quick Review'] }] } }));
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await page.getByRole('button', { name: 'Expand All', exact: true }).click();
  await expect(page.getByText('Not verified in Quick Review: missing file size. Extra reads were skipped.')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Include group missing-size', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Load selected details', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Keeper metadata changed since Quick Review');
  await expect(page.getByRole('checkbox', { name: /^Include group/, checked: true })).toHaveCount(2);
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
});

test('quick cancellation retains provisional results and requests survive navigation without new preview enrichment', async ({ page }) => {
  const state = await startStreamedPreparation(page, true);
  const before = previewCalls(state.calls);
  await pushProgress(page, 1);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Quick Review', exact: true })).toBeChecked();
  await page.getByRole('button', { name: 'Cancel review', exact: true }).click();
  const snapshot = { ...quickReviewFixture(1), fetchedGroups: 1, excludedGroups: [], preparation: { status: 'cancelled', checkedGroups: 1, targetGroups: 100 } };
  await page.evaluate((snapshot) => {
    const h = (window as unknown as PreparationTestWindow).preparationTest;
    h.push({ type: 'result', result: { status: 'cancelled', plan: null, quickReview: snapshot } }); h.finish();
  }, snapshot);
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load selected details', exact: true })).toBeEnabled();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(previewCalls(state.calls)).toEqual(before);
});

test('late detailed preview errors do not block or replace quick results', async ({ page }) => {
  await fakeApi(page, null);
  const held: Route[] = [];
  await page.route('**/execution/status?*', (route) => { held.push(route); });
  await page.route('**/execution/plan?*', (route) => { held.push(route); });
  await page.route('**/analysis/duplicates?*', (route) => { held.push(route); });
  await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  // React StrictMode can mount this read-only effect twice in development.
  await expect.poll(() => new Set(held.map((route) => new URL(route.request().url()).pathname)).size).toBe(3);
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).check();
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Prepare review', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toBeVisible();
  await Promise.all(held.map((route) => route.fulfill({ status: 404, contentType: 'text/html', body: 'Not Found' })));
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Quick Review — provisional results' })).toBeVisible();
});

test('quick progress parser accepts evaluation and partial snapshots but rejects malformed terminal data', async () => {
  const snapshot = quickReviewFixture(1); snapshot.preparation.status = 'cancelled';
  const progress = { preparationId: runId, stage: 'evaluating-rules', checkedGroups: 1, targetGroups: 2, eligibleGroups: 1, excludedGroups: 0 };
  const text = JSON.stringify({ type: 'progress', progress }) + '\n' + JSON.stringify({ type: 'result', result: { status: 'cancelled', plan: null, quickReview: snapshot } }) + '\n';
  const events: unknown[] = [];
  const result = await consumeReviewPreparation(streamBody(text), (p) => events.push(p));
  expect(result.type).toBe('result'); expect(events).toEqual([progress]);
  await expect(consumeReviewPreparation(streamBody(JSON.stringify({ type: 'result', result: { status: 'completed', plan: null, quickReview: null } }) + '\n'), () => undefined)).rejects.toThrow();
});

test('switching quick mode on and off during a cached preview refresh never leaves Controls stuck busy', async ({ page }) => {
  await fakeApi(page, null); await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  let held: Route | undefined;
  await page.route('**/execution/status?*', (route) => { held = route; });
  await page.getByRole('button', { name: 'Refresh previews', exact: true }).click();
  await expect.poll(() => Boolean(held)).toBe(true);
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Quick Review', exact: true }).uncheck();
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
  await held!.fulfill({ status: 500, json: { error: 'Old preview failure' } });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Prepare review', exact: true })).toBeEnabled();
});

function configurableRulesFixture(): RulesState & { ok: true } {
  const rule = { id: 'exact', name: 'Identical files', enabled: true, action: 'include' as const, comparison: 'checksum' as const, acknowledgeHeuristic: false,
    conditions: { all: [{ field: 'fileName' as const, operator: 'same' as const }] },
    keeperPreferences: [{ field: 'directory' as const, direction: 'lowest' as const, directories: ['/photos/originals', '/photos/copies'] }] };
  return { ok: true, active: { schemaVersion: 1 as const, rules: [rule], revision: 'rules-1', engineVersion: '1' as const }, draft: { schemaVersion: 1 as const, rules: [rule] }, presets: [rule],
    savedPresets: [{ id: '00000000-0000-4000-8000-000000000051', name: 'Camera originals', ruleset: { schemaVersion: 1, rules: [structuredClone(rule)] }, revision: 1 }] };
}

test('Rules provides a draft builder and publishing clears a previous review and dry-run approval', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  await page.getByRole('button', { name: 'Dry-run selected', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeEnabled();
  const state = configurableRulesFixture();
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  let published = false;
  await page.route('**/rules/publish', (route) => {
    const input = route.request().postDataJSON();
    expect(input.ruleset.rules[0].comparison).toBe('metadata');
    expect(input.ruleset.rules[0].acknowledgeHeuristic).toBe(true);
    expect(input.ruleset.rules[0].keeperPreferences[0].directories).toEqual(['/directory-a', '/directory-b']);
    published = true;
    return route.fulfill({ json: { ...state, draft: input.ruleset, active: { ...input.ruleset, revision: 'rules-2', engineVersion: '1' } } });
  });
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Rules', exact: true })).toBeVisible();
  const enabled = page.getByRole('switch', { name: 'Enabled', exact: true });
  await expect(enabled).toBeChecked();
  await expect(enabled).toHaveCSS('width', '44px');
  await expect(enabled).toHaveCSS('height', '24px');
  await expect(enabled).toHaveCSS('border-radius', '12px');
  const desktop = page.viewportSize();
  for (const viewport of [desktop!, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    const heading = await page.getByRole('heading', { name: 'Rule 1', exact: true }).boundingBox();
    const label = await page.locator('.rule-enabled').boundingBox();
    expect(heading).not.toBeNull(); expect(label).not.toBeNull();
    expect(label!.x - (heading!.x + heading!.width)).toBeCloseTo(16, 0);
    expect(Math.abs(label!.y + label!.height / 2 - heading!.y - heading!.height / 2)).toBeLessThan(2);
  }
  await page.setViewportSize(desktop!);
  await enabled.uncheck();
  await expect(enabled).not.toBeChecked();
  await expect(enabled).toHaveCSS('background-color', 'rgb(104, 117, 138)');
  await enabled.focus(); await page.keyboard.press('Space');
  await expect(enabled).toBeChecked();
  await page.getByLabel('Comparison evidence', { exact: true }).selectOption('metadata');
  await page.getByRole('checkbox', { name: /I accept that metadata matching/ }).check();
  await page.getByLabel('Directories, preferred first (one per line)').fill('/directory-a\n/directory-b');
  await page.getByRole('button', { name: 'Publish rules', exact: true }).click();
  await expect(page.getByText(/Rules published/)).toBeVisible(); expect(published).toBe(true);
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Include group photos' })).toHaveCount(0);
});

test('Rules presets immediately replace every rule and its settings in the editor', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture();
  const variant = structuredClone(state.draft);
  variant.rules[0] = { ...variant.rules[0], name: 'Resolution variant', enabled: false, comparison: 'metadata', acknowledgeHeuristic: true,
    conditions: { field: 'width', operator: 'gt', value: 900, target: 'keeper' }, keeperPreferences: [{ field: 'pixelCount', direction: 'highest' }] };
  variant.rules.push({ ...structuredClone(variant.rules[0]), id: 'exclude', name: 'Exclude rule', action: 'exclude', enabled: true });
  state.savedPresets.push({ id: '00000000-0000-4000-8000-000000000052', name: 'Resolution rules', ruleset: variant, revision: 1 });
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Preset', { exact: true }).selectOption(state.savedPresets[1].id);
  await expect(page.locator('.rule-editor')).toHaveCount(2);
  const first = page.locator('.rule-editor').first(), second = page.locator('.rule-editor').nth(1);
  await expect(first.getByLabel('Name', { exact: true })).toHaveValue('Resolution variant');
  await expect(first.getByRole('switch')).not.toBeChecked();
  await expect(first.getByLabel('Comparison evidence', { exact: true })).toHaveValue('metadata');
  await expect(first.getByLabel('Field', { exact: true })).toHaveValue('width');
  await expect(first.getByLabel('Value', { exact: true })).toHaveValue('900');
  await expect(first.getByLabel('Apply to', { exact: true })).toHaveValue('keeper');
  await expect(first.getByLabel('Preference 1')).toHaveValue('pixelCount');
  await expect(first.getByLabel('Prefer', { exact: true })).toHaveValue('highest');
  await expect(second.getByLabel('Name', { exact: true })).toHaveValue('Exclude rule');
  await expect(second.getByLabel('Action', { exact: true })).toHaveValue('exclude');
  await page.getByLabel('Preset', { exact: true }).selectOption(state.savedPresets[0].id);
  await expect(page.locator('.rule-editor')).toHaveCount(1);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Identical files');
  await expect(page.getByLabel('Directories, preferred first (one per line)')).toHaveValue('/photos/originals\n/photos/copies');
});

test('Rules saving confirms new and existing names, preserves edits and restores saved contents after reload', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture(); const requests: SaveRulePresetRequest[] = [];
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  await page.route('**/rules/presets', (route) => {
    const input: SaveRulePresetRequest = route.request().postDataJSON(); requests.push(input);
    const existing = state.savedPresets.find((entry) => entry.id === input.overwriteId);
    if (existing) { expect(input.expectedRevision).toBe(existing.revision); existing.ruleset = structuredClone(input.ruleset); existing.revision++; }
    else state.savedPresets.push({ id: `00000000-0000-4000-8000-${String(60 + requests.length).padStart(12, '0')}`, name: input.name, ruleset: structuredClone(input.ruleset), revision: 1 });
    return route.fulfill({ json: state });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Edited rule contents');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Overwrite existing preset "Camera originals"'); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Save preset', exact: true }).click(); expect(requests).toHaveLength(0);
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Overwrite existing preset "Camera originals"'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  expect(requests[0].overwriteId).toBe(state.savedPresets[0].id); expect(requests[0].expectedRevision).toBe(1);
  expect(requests[0].ruleset.rules[0].name).toBe('Edited rule contents');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Edited rule contents');
  await page.getByLabel('Preset name', { exact: true }).fill('New camera preset');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toBe('Save new preset as "New camera preset"?'); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Save preset', exact: true }).click(); expect(requests).toHaveLength(1);
  page.once('dialog', async (dialog) => { expect(dialog.message()).toBe('Save new preset as "New camera preset"?'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('New camera preset');
  expect(requests[1].overwriteId).toBeUndefined(); expect(state.savedPresets).toHaveLength(2);
  expect(state.active.rules[0].name).toBe('Identical files'); expect(state.draft.rules[0].name).toBe('Identical files');
  const savedId = state.savedPresets[1].id;
  await page.reload(); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Preset', { exact: true }).selectOption(savedId);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Edited rule contents');
});

test('Rules creates a preset from an empty editor and deletes it without losing shown or published rules', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture(); let deletes = 0;
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  await page.route('**/rules/presets', (route) => {
    const input: SaveRulePresetRequest = route.request().postDataJSON();
    state.savedPresets.push({ id: '00000000-0000-4000-8000-000000000062', name: input.name, ruleset: input.ruleset, revision: 1 });
    return route.fulfill({ json: state });
  });
  await page.route('**/rules/presets/*', (route) => {
    expect(route.request().method()).toBe('DELETE'); expect(route.request().postDataJSON()).toEqual({ expectedRevision: 1 });
    deletes++; state.savedPresets = state.savedPresets.filter((entry) => entry.id !== '00000000-0000-4000-8000-000000000062');
    return route.fulfill({ json: state });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'New preset', exact: true }).click();
  await expect(page.locator('.rule-editor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save preset', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Add rule from template', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('My new rule');
  await page.getByLabel('Preset name', { exact: true }).fill('My new preset');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toBe('Save new preset as "My new preset"?'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('saved');
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Delete preset "My new preset"'); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click(); expect(deletes).toBe(0);
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('Delete preset "My new preset"'); await dialog.accept(); });
  await page.getByRole('button', { name: 'Delete preset', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('deleted'); expect(deletes).toBe(1);
  await expect(page.getByLabel('Preset', { exact: true }).getByRole('option', { name: 'My new preset', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('My new rule');
  expect(state.active.rules[0].name).toBe('Identical files');
});

test('Rules preset save failures preserve edits and allow refreshing stale presets', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture();
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  await page.route('**/rules/presets', (route) => route.fulfill({ status: 409, json: { ok: false, error: 'The preset changed. Refresh presets and confirm again.' } }));
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Unsaved rule edit');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('preset changed');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved rule edit');
  state.savedPresets[0].revision = 2;
  await page.getByRole('button', { name: 'Refresh presets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('editor contents were kept');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Unsaved rule edit');
});

test('Rules refresh rejects older or malformed preset responses without losing edits or the existing catalog', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture();
  const legacy: Partial<RulesState> = { ...state }; delete legacy.savedPresets;
  let returned: unknown = state;
  await page.route('**/rules', (route) => route.fulfill({ json: returned }));
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Keep my unsaved edit');
  for (const invalid of [legacy, { ...state, savedPresets: null }, { ...state, savedPresets: {} }]) {
    returned = invalid;
    await page.getByRole('button', { name: 'Refresh presets', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('API response is missing saved preset data');
    await expect(page.getByRole('alert')).toContainText('Restart the API');
    await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep my unsaved edit');
    await expect(page.getByLabel('Preset', { exact: true })).toHaveValue(state.savedPresets[0].id);
    await expect(page.getByRole('option', { name: 'Camera originals', exact: true })).toHaveCount(1);
  }
  returned = state;
  await page.getByRole('button', { name: 'Refresh presets', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Preset list refreshed');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Keep my unsaved edit');
  expect(errors).toEqual([]);
});

test('Rules can retry an initial legacy response after the API is updated', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture();
  const legacy: Partial<RulesState> = { ...state }; delete legacy.savedPresets;
  let updated = false;
  await page.route('**/rules', (route) => route.fulfill({ json: updated ? state : legacy }));
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Restart the API');
  updated = true;
  await page.getByRole('button', { name: 'Retry loading rules', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Identical files');
  await expect(page.getByLabel('Preset', { exact: true })).toHaveValue(state.savedPresets[0].id);
});

test('Rules preset saves reject a missing catalog without replacing editor contents', async ({ page }) => {
  await fakeApi(page); const state = configurableRulesFixture();
  const legacy: Partial<RulesState> = { ...state }; delete legacy.savedPresets;
  await page.route('**/rules', (route) => route.fulfill({ json: state }));
  await page.route('**/rules/presets', (route) => route.fulfill({ json: legacy }));
  await page.goto('/'); await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Preserve this edit');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Save preset', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('API response is missing saved preset data');
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Preserve this edit');
  await expect(page.getByRole('status')).toHaveCount(0);
});

test('Rules snapshot tests show evidence and missing values without authorizing execution', async ({ page }) => {
  await fakeApi(page); await openDedupe(page);
  await page.route('**/rules', (route) => route.fulfill({ json: configurableRulesFixture() }));
  await page.route('**/rules/test', (route) => {
    expect(route.request().postDataJSON().snapshotId).toBe(runId);
    return route.fulfill({ json: { ok: true, results: [{ groupId: 'photos', outcome: 'deferred', evidenceClass: 'unverified', matchedRuleName: 'Identical files', reasons: ['Checksum is missing'], missingFields: ['checksum'], observedValues: { checksum: [null, 'hash'] } }] } });
  });
  await page.getByRole('button', { name: 'Rules', exact: true }).click();
  await page.getByRole('button', { name: 'Test draft against prepared review', exact: true }).click();
  await page.getByText('Group photos: deferred · Unverified').click();
  await expect(page.getByText('Missing: checksum', { exact: true })).toBeVisible();
  await expect(page.getByText(/does not authorize execution/)).toBeVisible();
  await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
});

test('Candidate-target scans pass a separate budget and preserve pending proposals for fresh review', async ({ page }) => {
  await fakeApi(page, null);
  const proposal = { groupId: 'photos', keepAssetId: 'keeper', trashAssetId: 'loser', keepFileName: 'photo.jpg', trashFileName: 'photo.jpg', keepPath: '/directory-a/photo.jpg', trashPath: '/directory-b/photo.jpg', comparisonClass: 'checksum', reason: 'Matching stored checksums', rulesetRevision: 'rules-1', observedAt: new Date().toISOString() };
  await page.route('**/execution/scan/pending', (route) => route.fulfill({ json: { ok: true, pending: [proposal], summary: { rulesetRevision: 'rules-1', totalGroups: 300, visitedGroups: 100, remainingGroups: 200, excludedGroups: 99, deferredGroups: 0, blockedGroups: 0, pendingCandidates: 1, updatedAt: new Date().toISOString() } } }));
  let scans = 0;
  await page.route('**/execution/plans', (route) => {
    const input = route.request().postDataJSON(); expect(input.scan).toEqual({ mode: 'candidates', candidateTarget: 20 }); expect(input.scanLimit).toBe(300); expect(input.executeLimit).toBe(5); scans++;
    return route.fulfill({ json: { ok: true, plan: reviewPlan(input.scanLimit, input.executeLimit) } });
  });
  await page.route('**/execution/scan/prepare-pending', (route) => {
    expect(route.request().postDataJSON()).toEqual({ selectedGroupIds: ['photos'], executeLimit: 5 });
    return route.fulfill({ json: { ok: true, plan: reviewPlan() } });
  });
  await page.goto('/'); await page.getByRole('button', { name: 'Dedupe', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Review pending group photos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
  await page.getByLabel('Scan mode', { exact: true }).selectOption('candidates');
  await page.getByLabel('Fully checked candidate target', { exact: true }).fill('20');
  await page.getByLabel('Maximum groups to inspect', { exact: true }).fill('300');
  await page.getByRole('button', { name: 'Continue scanning', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Dry-run selected', exact: true })).toBeEnabled(); expect(scans).toBe(1);
  await page.getByRole('checkbox', { name: 'Review pending group photos' }).check();
  await page.getByRole('button', { name: 'Prepare selected pending candidates', exact: true }).click();
  await expect(page.getByText(/Fresh details loaded for pending candidates/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Execute selected', exact: true })).toBeDisabled();
});
