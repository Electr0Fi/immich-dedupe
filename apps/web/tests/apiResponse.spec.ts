/// <reference types="vite/client" />
import { test, expect } from '@playwright/test';
import { ApiError, readResponse } from '../src/apiResponse';

const endpoint = { method: 'POST', path: '/execution/plans/review-id/select-all' };
async function failure(response: Response, request = endpoint) {
  try { await readResponse(response, request); }
  catch (error) { expect(error).toBeInstanceOf(ApiError); return error as ApiError; }
  throw new Error('Expected an API error');
}

test('missing Select All routes explain how to restart the API without exposing raw HTML', async () => {
  const error = await failure(new Response('<html>Cannot POST /execution/plans/review-id/select-all</html>', { status: 404, statusText: 'Not Found' }));
  expect(error.status).toBe(404); expect(error.code).toBe('api_endpoint_unavailable');
  expect(error.message).toContain('POST /execution/plans/review-id/select-all');
  expect(error.message).toContain('Restart the API from the current project checkout');
  expect(error.message).toContain('prepare a new review');
  expect(error.message).toContain('VITE_API_BASE_URL'); expect(error.message).not.toContain('<html>');
  expect(error.partialExecution).toBeUndefined();
});

test('missing preview GET routes include the failing endpoint and routing guidance', async () => {
  const error = await failure(new Response(null, { status: 404, statusText: 'Not Found' }), { method: 'GET', path: '/execution/status?scanLimit=100' });
  expect(error.message).toContain('GET /execution/status?scanLimit=100');
  expect(error.message).toContain('reverse-proxy routing');
});

test('legitimate JSON not-found and expired-plan errors retain their server messages', async () => {
  const missing = await failure(Response.json({ code: 'run_not_found', error: 'Run not found for the current connection' }, { status: 404 }));
  expect(missing.code).toBe('run_not_found'); expect(missing.message).not.toContain('Restart');
  expect(missing.message).toContain('Run not found for the current connection');
  const expired = await failure(Response.json({ code: 'plan_unavailable', error: 'Review expired or is unavailable' }, { status: 410 }));
  expect(expired.code).toBe('plan_unavailable'); expect(expired.status).toBe(410);
});

test('decoding errors preserves partial execution evidence, request identifiers and changed-group reasons', async () => {
  const partialExecution = { runId: 'recorded-run', results: [] };
  const error = await failure(Response.json({ code: 'journal_unavailable', error: 'Evidence write failed', runId: 'recorded-run', partialExecution }, { status: 503 }));
  expect(error.code).toBe('journal_unavailable'); expect(error.runId).toBe('recorded-run');
  expect(error.partialExecution).toEqual(partialExecution);
  const stale = await failure(Response.json({ code: 'plan_changed', error: 'Review changed', changedGroups: [{ groupId: 'group', reasons: ['Album membership changed'] }] }, { status: 409 }));
  expect(stale.message).toContain('Group group: Album membership changed');
});

test('successful JSON responses still decode and malformed success bodies are rejected', async () => {
  expect(await readResponse(Response.json({ ok: true, plan: { planId: 'id' } }), endpoint)).toEqual({ ok: true, plan: { planId: 'id' } });
  await expect(readResponse(new Response('<html>unexpected</html>'), endpoint)).rejects.toThrow('invalid JSON response');
});
