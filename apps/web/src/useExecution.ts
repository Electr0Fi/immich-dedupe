import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getLatestRun, getRun, runExecution, type ExecutionRunResponse, type RunView, type RunViewResponse } from './api';

type Request = { phase: 'pending' | 'unknown' | 'failed'; dryRun: boolean; message: string; runId?: string; partial?: boolean } | null;
function responseView(result: ExecutionRunResponse, startedAt: string): RunView {
  return {
    runId: result.runId ?? 'Not recorded', startedAt, finishedAt: result.ok ? new Date().toISOString() : null,
    phase: result.ok ? 'finished' : 'interrupted',
    context: { dryRun: result.dryRun, scanLimit: result.scanLimit, executeLimit: result.executeLimit, source: 'batch', groupId: null },
    report: { fetchedGroups: result.fetchedGroups, eligibleCount: result.eligibleCount, excludedGroups: result.excludedGroups ?? [], stoppedEarly: result.stoppedEarly, stopReason: result.stopReason, requestError: null },
    attempts: result.results.map((r) => ({ attemptId: r.attemptId ?? r.groupId, groupId: r.groupId, mode: r.mode,
      keepAssetId: r.keepAssetId, trashAssetId: r.trashAssetId, result: r, lastStage: r.failureStage ?? r.outcome,
      confirmedAlbumIds: r.transferredAlbumIds,
      confirmedEffects: { loserTrashed: r.trashedAsset, loserUnlinked: r.resolvedDuplicate, keeperUntrashed: r.executed },
      recovery: r.outcome === 'needs-verification' ? 'quarantined' : 'closed', assessment: null })),
  };
}

/** Owned by the shell so navigation cannot lose an in-flight request or its result. */
export function useExecution(open: boolean) {
  const [run, setRun] = useState<RunView | null>(null);
  const [partialRun, setPartialRun] = useState<RunView | null>(null);
  const [request, setRequest] = useState<Request>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [reading, setReading] = useState(true);
  const version = useRef(0);
  const pending = useRef(false);
  const mounted = useRef(false);
  const scope = useRef<string | null>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const applyLatest = useCallback((value: RunViewResponse, current: number) => {
    if (!mounted.current || version.current !== current) return;
    const key = JSON.stringify(value.scope);
    if (scope.current && scope.current !== key) { setPartialRun(null); setRequest(null); }
    scope.current = key;
    setRun(value.run); setReadError(null);
    setPartialRun((partial) => partial && partial.runId === value.run?.runId ? {
      ...partial,
      attempts: partial.attempts.map((attempt) => {
        const saved = value.run?.attempts.find((a) => a.attemptId === attempt.attemptId);
        return saved ? { ...attempt, recovery: saved.recovery, assessment: saved.assessment } : attempt;
      }),
    } : partial);
    // A read cannot attribute an unidentified lost response to a particular run.
    // Preserve partial-response evidence separately even when disk checkpointing failed.
  }, []);
  const readFailure = useCallback((error: unknown, current: number) => {
    if (!mounted.current || version.current !== current) return;
    setReadError(error instanceof Error ? error.message : 'Latest run could not be loaded');
    if (error instanceof ApiError && error.code === 'identity_unavailable') { setRun(null); setPartialRun(null); }
  }, []);
  const refreshLatest = useCallback(async () => {
    if (pending.current) return;
    const current = ++version.current;
    setReading(true); setReadError(null);
    try { applyLatest(await getLatestRun(), current); }
    catch (error) { readFailure(error, current); }
    finally { if (mounted.current && version.current === current) setReading(false); }
  }, [applyLatest, readFailure]);

  useEffect(() => {
    if (!open || pending.current) return;
    const current = ++version.current;
    getLatestRun().then((value) => applyLatest(value, current)).catch((error: unknown) => readFailure(error, current))
      .finally(() => { if (mounted.current && version.current === current) setReading(false); });
  }, [open, applyLatest, readFailure]);

  async function execute(params: { dryRun: boolean; scanLimit: number; executeLimit: number }) {
    if (pending.current) return;
    pending.current = true;
    const current = ++version.current;
    const startedAt = new Date().toISOString();
    setReading(false); setReadError(null);
    setRequest({ phase: 'pending', dryRun: params.dryRun, message: params.dryRun ? 'Dry-run request in progress…' : 'Live execution request in progress…' });
    try {
      const result = await runExecution(params);
      if (!mounted.current || version.current !== current) return;
      setRun(responseView(result, startedAt)); setPartialRun(null);
      if (result.runId) {
        try { applyLatest(await getRun(result.runId), current); }
        catch {
          if (mounted.current && version.current === current) setReadError('Results received; saved evidence could not be refreshed. Use Refresh latest to check the journal.');
        }
      }
      if (mounted.current && version.current === current) setRequest(null);
    } catch (error) {
      if (!mounted.current || version.current !== current) return;
      const message = error instanceof Error ? error.message : 'The execution response was lost';
      if (error instanceof ApiError && error.partialExecution) setPartialRun(responseView(error.partialExecution, startedAt));
      const unknown = !(error instanceof ApiError) || (error.status >= 500 && !['identity_unavailable', 'journal_unavailable'].includes(error.code ?? ''));
      setRequest({ phase: unknown ? 'unknown' : 'failed', dryRun: params.dryRun, message,
        runId: error instanceof ApiError ? error.runId : undefined, partial: error instanceof ApiError && Boolean(error.partialExecution) });
    } finally { pending.current = false; }
  }
  return { run: partialRun ?? run, request, readError, reading, refreshLatest, execute, busy: request?.phase === 'pending', partial: Boolean(partialRun) };
}
export type ExecutionState = ReturnType<typeof useExecution>;
