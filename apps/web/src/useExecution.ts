import type { ReviewPreparationProgress } from '@immich-dedupe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, getLatestRun, getRun, prepareReviewedPlan, cancelReviewedPreparation, runReviewedPlan, type ReviewedPlan, type ExecutionRunResponse, type RunView, type RunViewResponse } from './api';

type Request = { phase: 'pending' | 'unknown' | 'failed'; dryRun: boolean; message: string; runId?: string; partial?: boolean } | null;
function responseView(result: ExecutionRunResponse, startedAt: string): RunView {
  return {
    ...(result.planId ? { planId: result.planId, selectedCount: result.selectedCount } : {}),
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
  const [review, setReview] = useState<ReviewedPlan | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [limits, setLimits] = useState({ scanLimit: 100, executeLimit: 5 });
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [preparationProgress, setPreparationProgress] = useState<ReviewPreparationProgress | null>(null);
  const [preparationStartedAt, setPreparationStartedAt] = useState<number | null>(null);
  const [progressUpdatedAt, setProgressUpdatedAt] = useState<number | null>(null);
  const [preparationMessage, setPreparationMessage] = useState<string | null>(null);
  const preparation = useRef<{ id: string | null; requested: boolean; sent: boolean } | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [authorization, setAuthorization] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [expired, setExpired] = useState(false);
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
    if (scope.current && scope.current !== key) { setPartialRun(null); setRequest(null); setReview(null); setAuthorization(null); setSelected([]); }
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
    if (error instanceof ApiError && error.code === 'identity_unavailable') { setRun(null); setPartialRun(null); setReview(null); setAuthorization(null); setSelected([]); }
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

  useEffect(() => {
    if (!review) return;
    const timer = window.setTimeout(() => { setExpired(true); setAuthorization(null); }, Math.max(0, Date.parse(review.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [review]);

  function changeLimits(next: typeof limits) {
    if (pending.current) return;
    setLimits(next); setReview(null); setAuthorization(null); setSelected([]); setReviewError(null); setPreparationMessage(null);
  }
  function selectGroups(ids: string[]) {
    if (pending.current || !review) return;
    if (ids.length > review.executeLimit) return;
    const ordered = review.candidates.filter((c) => ids.includes(c.groupId)).map((c) => c.groupId);
    setSelected(ordered); setAuthorization(null);
  }
  async function sendCancellation(session: NonNullable<typeof preparation.current>) {
    if (!session.id || session.sent) return;
    session.sent = true;
    try { await cancelReviewedPreparation(session.id); }
    catch (error) {
      if (!mounted.current || preparation.current !== session || !pending.current) return;
      session.sent = false; session.requested = false; setCancelling(false);
      setReviewError(`Cancellation could not be confirmed. Preparation is still pending. ${error instanceof Error ? error.message : ''}`);
    }
  }
  function cancelPreparation() {
    const session = preparation.current;
    if (!session || session.requested || !pending.current) return;
    session.requested = true; setCancelling(true); setReviewError(null);
    void sendCancellation(session);
  }
  async function prepare() {
    if (pending.current) return;
    pending.current = true;
    const current = ++version.current;
    const session = { id: null as string | null, requested: false, sent: false };
    preparation.current = session;
    setCancelling(false); setPreparationProgress(null); setPreparationMessage(null);
    setPreparationStartedAt(Date.now()); setProgressUpdatedAt(Date.now());
    setPreparing(true); setReview(null); setSelected([]); setAuthorization(null); setReviewError(null); setReading(false);
    try {
      const value = await prepareReviewedPlan(limits.scanLimit, limits.executeLimit, (progress) => {
        if (!mounted.current || version.current !== current) return;
        session.id = progress.preparationId;
        setPreparationProgress(progress); setProgressUpdatedAt(Date.now());
        if (session.requested) void sendCancellation(session);
      });
      if (!mounted.current || version.current !== current) return;
      setReviewError(null);
      if (value.status === 'cancelled') {
        setPreparationMessage(value.plan
          ? `Review cancelled. ${value.plan.fetchedGroups} of ${value.plan.preparation?.targetGroups ?? value.plan.fetchedGroups} groups checked; completed results are available below.`
          : 'Review cancelled before any groups were checked.');
      } else if (session.requested) setPreparationMessage('The review finished before cancellation took effect. All completed results are available below.');
      if (!value.plan) return value.status;
      const key = JSON.stringify(value.plan.scope);
      if (scope.current && key !== scope.current) { setRun(null); setPartialRun(null); setRequest(null); }
      scope.current = key;
      setReview(value.plan); setSelected(value.plan.candidates.slice(0, value.plan.executeLimit).map((c) => c.groupId));
      setInvalid(false); setExpired(Date.parse(value.plan.expiresAt) <= Date.now());
      return value.status;
    } catch (error) {
      if (mounted.current && version.current === current) setReviewError(error instanceof Error ? error.message : 'Review could not be prepared');
    } finally { pending.current = false; if (mounted.current && version.current === current) { setPreparing(false); setCancelling(false); preparation.current = null; } }
  }
  const validReview = Boolean(review && !invalid && !expired);
  const selectionKey = JSON.stringify(selected);
  async function execute(params: { dryRun: boolean }) {
    if (pending.current || !review || !validReview || selected.length === 0 || (!params.dryRun && authorization !== selectionKey)) return;
    if (Date.parse(review.expiresAt) <= Date.now()) { setExpired(true); setAuthorization(null); return; }
    const approved = authorization;
    setAuthorization(null);
    if (!params.dryRun) setInvalid(true);
    pending.current = true;
    const current = ++version.current;
    const startedAt = new Date().toISOString();
    setReading(false); setReadError(null);
    setRequest({ phase: 'pending', dryRun: params.dryRun, message: params.dryRun ? 'Dry-run request in progress…' : 'Live execution request in progress…' });
    try {
      const result = await runReviewedPlan(review.planId, selected, params.dryRun);
      if (!mounted.current || version.current !== current) return;
      setRun(responseView(result, startedAt)); setPartialRun(null);
      if (result.runId) {
        try { applyLatest(await getRun(result.runId), current); }
        catch {
          if (mounted.current && version.current === current) setReadError('Results received; saved evidence could not be refreshed. Use Refresh latest to check the journal.');
        }
      }
      if (mounted.current && version.current === current) {
        setRequest(null);
        if (params.dryRun && result.ok && !result.stoppedEarly && result.results.length === selected.length && result.results.every((r) => r.outcome === 'dry-run')) setAuthorization(selectionKey);
        else { setInvalid(true); setAuthorization(null); }
      }
    } catch (error) {
      if (!mounted.current || version.current !== current) return;
      if (error instanceof ApiError && error.code === 'execution_busy') { setInvalid(false); setAuthorization(approved); }
      else setInvalid(true);
      const message = error instanceof Error ? error.message : 'The execution response was lost';
      if (error instanceof ApiError && error.partialExecution) setPartialRun(responseView(error.partialExecution, startedAt));
      const unknown = !(error instanceof ApiError) || (error.status >= 500 && !['identity_unavailable', 'journal_unavailable'].includes(error.code ?? ''));
      setRequest({ phase: unknown ? 'unknown' : 'failed', dryRun: params.dryRun, message,
        runId: error instanceof ApiError ? error.runId : undefined, partial: error instanceof ApiError && Boolean(error.partialExecution) });
    } finally { pending.current = false; }
  }
  return { review, selected, limits, preparing, cancelling, preparationProgress, preparationStartedAt, progressUpdatedAt, preparationMessage, cancelPreparation, reviewError, expired, invalid, validReview,
    prepare, selectGroups, changeLimits, canExecute: validReview && selected.length > 0 && authorization === selectionKey,
    run: partialRun ?? run, request, readError, reading, refreshLatest, execute, busy: request?.phase === 'pending', partial: Boolean(partialRun) };
}
export type ExecutionState = ReturnType<typeof useExecution>;
