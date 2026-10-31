import type { ReviewPreparationProgress, QuickReview } from '@immich-dedupe/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { clearDedupeCache } from './dedupeCache';
import { getPendingCandidates, preparePendingCandidates, recheckExcludedGroups, resetScanProgress, type PendingCandidate, type ScanSummary, type ScanRequest, ApiError, getLatestRun, getRun, prepareReviewedPlan, prepareQuickReview, prepareQuickSelection, cancelReviewedPreparation, selectAllReviewedPlan, runReviewedPlan, type ReviewedPlan, type ExecutionRunResponse, type RunView, type RunViewResponse } from './api';

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
  const [quickSnapshot, setQuickSnapshot] = useState<QuickReview | null>(null);
  const [quickReviewEnabled, setQuickReviewEnabled] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [scanOptions, setScanOptions] = useState<ScanRequest>({ mode: 'groups' });
  const [pendingCandidates, setPendingCandidates] = useState<PendingCandidate[]>([]);
  const [scanSummary, setScanSummary] = useState<ScanSummary | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanLoading, setScanLoading] = useState(false);
  const [limits, setLimits] = useState({ scanLimit: 100, executeLimit: 5 });
  const [preparing, setPreparing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectingAll, setSelectingAll] = useState(false);
  const [selectionMessage, setSelectionMessage] = useState<string | null>(null);
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
    if (scope.current && scope.current !== key) { setPartialRun(null); setRequest(null); setReview(null); setQuickSnapshot(null); setAuthorization(null); setSelected([]); }
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
    if (error instanceof ApiError && error.code === 'identity_unavailable') { setRun(null); setPartialRun(null); setReview(null); setQuickSnapshot(null); setAuthorization(null); setSelected([]); }
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
    if (!open || pending.current) return;
    let active = true;
    getPendingCandidates().then((value) => { if (active && mounted.current) { setPendingCandidates(value.pending); setScanSummary(value.summary); setScanError(null); } })
      .catch((error: unknown) => { if (active && mounted.current) setScanError(error instanceof Error ? error.message : 'Scan progress could not be loaded'); });
    return () => { active = false; };
  }, [open]);

  useEffect(() => {
    const snapshot = review ?? quickSnapshot;
    if (!snapshot) return;
    const timer = window.setTimeout(() => { setExpired(true); setAuthorization(null); }, Math.max(0, Date.parse(snapshot.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [review, quickSnapshot]);

  function invalidateReview() {
    if (pending.current) return;
    setReview(null); setQuickSnapshot(null); setAuthorization(null); setSelected([]);
    setInvalid(false); setExpired(false); setReviewError(null); setSelectionMessage(null); setPreparationMessage(null);
    clearDedupeCache();
  }
  function rulesPublished() { invalidateReview(); void refreshPending(); }
  function changeScanOptions(next: ScanRequest) {
    if (pending.current) return;
    setScanOptions(next); invalidateReview();
  }
  async function refreshPending() {
    if (pending.current) return;
    const current = version.current;
    setScanLoading(true); setScanError(null);
    try {
      const data = await getPendingCandidates();
      if (mounted.current && current === version.current) { setPendingCandidates(data.pending); setScanSummary(data.summary); }
    } catch (error) {
      if (mounted.current && current === version.current) setScanError(error instanceof Error ? error.message : 'Scan progress could not be loaded');
    } finally { if (mounted.current) setScanLoading(false); }
  }
  async function updateScan(action: 'recheck' | 'reset') {
    if (pending.current || scanLoading) return;
    setScanLoading(true); setScanError(null);
    try {
      await (action === 'reset' ? resetScanProgress() : recheckExcludedGroups());
      invalidateReview();
      const data = await getPendingCandidates(); setPendingCandidates(data.pending); setScanSummary(data.summary);
    } catch (error) { setScanError(error instanceof Error ? error.message : 'Scan progress could not be updated'); }
    finally { setScanLoading(false); }
  }
  async function loadPendingCandidates(ids: string[]) {
    if (pending.current || ids.length === 0 || ids.length > limits.executeLimit) return;
    pending.current = true;
    const current = ++version.current;
    setLoadingDetails(true); setReading(false); setReviewError(null); setAuthorization(null);
    try {
      const { plan } = await preparePendingCandidates(ids, limits.executeLimit);
      if (!mounted.current || current !== version.current) return;
      setReview(plan); setQuickSnapshot(null); setSelected(plan.candidates.map((candidate) => candidate.groupId));
      setLimits({ scanLimit: plan.scanLimit, executeLimit: plan.executeLimit }); setInvalid(false); setExpired(Date.parse(plan.expiresAt) <= Date.now());
      setSelectionMessage('Fresh details loaded for pending candidates. Inspect this review and complete a new dry-run before execution.');
    } catch (error) {
      if (mounted.current && current === version.current) setReviewError(error instanceof Error ? error.message : 'Pending candidates could not be prepared');
    } finally {
      pending.current = false;
      if (mounted.current && current === version.current) setLoadingDetails(false);
    }
    await refreshPending();
  }
  function changeQuickReview(enabled: boolean) {
    if (pending.current) return;
    setQuickReviewEnabled(enabled); setQuickSnapshot(null); setReview(null); setAuthorization(null); setSelected([]);
    setReviewError(null); setSelectionMessage(null); setPreparationMessage(null); setInvalid(false); setExpired(false);
  }
  async function loadSelectedDetails() {
    if (pending.current || !quickSnapshot || invalid || expired || selected.length === 0) return;
    if (Date.parse(quickSnapshot.expiresAt) <= Date.now()) { setExpired(true); return; }
    pending.current = true;
    const current = ++version.current;
    setLoadingDetails(true); setReading(false); setAuthorization(null); setReviewError(null);
    try {
      const { plan } = await prepareQuickSelection(quickSnapshot.reviewId, selected, limits.executeLimit);
      if (!mounted.current || version.current !== current) return;
      setReview(plan); setQuickSnapshot(null); setSelected(plan.candidates.map((candidate) => candidate.groupId));
      setLimits({ scanLimit: plan.scanLimit, executeLimit: plan.executeLimit });
      setInvalid(false); setExpired(Date.parse(plan.expiresAt) <= Date.now());
      setSelectionMessage(`Detailed review prepared for ${plan.candidates.length} selected Quick Review groups. Inspect album actions and complete a dry-run before execution.`);
    } catch (error) {
      if (!mounted.current || version.current !== current) return;
      setReviewError(error instanceof Error ? error.message : 'Selected details could not be loaded');
      if (error instanceof ApiError && ['quick_review_unavailable', 'plan_scope_changed', 'identity_unavailable'].includes(error.code ?? '')) setInvalid(true);
    } finally {
      pending.current = false;
      if (mounted.current && version.current === current) setLoadingDetails(false);
    }
  }
  function changeLimits(next: typeof limits) {
    if (pending.current) return;
    setLimits(next); setReview(null); setQuickSnapshot(null); setAuthorization(null); setSelected([]); setReviewError(null); setPreparationMessage(null); setSelectionMessage(null);
  }
  function selectGroups(ids: string[]) {
    const snapshot = review ?? quickSnapshot;
    if (pending.current || !snapshot) return;
    if (ids.length > (review?.executeLimit ?? limits.executeLimit)) return;
    const ordered = snapshot.candidates.filter((c) => ids.includes(c.groupId)).map((c) => c.groupId);
    setSelected(ordered); setAuthorization(null); setSelectionMessage(null);
  }
  async function selectAll() {
    if (!pending.current && quickSnapshot && !invalid && !expired) {
      if (Date.parse(quickSnapshot.expiresAt) <= Date.now()) { setExpired(true); return; }
      const ids = quickSnapshot.candidates.map((candidate) => candidate.groupId);
      setLimits({ ...limits, executeLimit: Math.max(limits.executeLimit, ids.length) });
      setSelected(ids); setAuthorization(null);
      setSelectionMessage(`Selected all ${ids.length} provisional candidates. Execute Limit is ${Math.max(limits.executeLimit, ids.length)}. Load selected details before dry-run or execution.`);
      return;
    }
    if (pending.current || !review || invalid || expired || review.candidates.length === 0) return;
    if (Date.parse(review.expiresAt) <= Date.now()) { setExpired(true); setAuthorization(null); return; }
    const ids = review.candidates.map((candidate) => candidate.groupId);
    if (ids.length <= review.executeLimit) { selectGroups(ids); return; }
    pending.current = true;
    const current = ++version.current;
    setSelectingAll(true); setReading(false); setAuthorization(null); setReviewError(null); setSelectionMessage(null);
    try {
      const { plan } = await selectAllReviewedPlan(review.planId);
      if (!mounted.current || version.current !== current) return;
      setReview(plan); setSelected(plan.candidates.map((candidate) => candidate.groupId));
      setLimits({ scanLimit: plan.scanLimit, executeLimit: plan.executeLimit });
      setExpired(Date.parse(plan.expiresAt) <= Date.now()); setInvalid(false);
      setSelectionMessage(`Selected all ${plan.candidates.length} eligible groups. Execute Limit increased from ${review.executeLimit} to ${plan.executeLimit}. Complete a new dry-run before execution.`);
    } catch (error) {
      if (!mounted.current || version.current !== current) return;
      setReviewError(error instanceof Error ? error.message : 'All groups could not be selected');
      if (error instanceof ApiError && ['plan_unavailable', 'plan_scope_changed', 'identity_unavailable'].includes(error.code ?? '')) setInvalid(true);
    } finally {
      pending.current = false;
      if (mounted.current && version.current === current) setSelectingAll(false);
    }
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
    setCancelling(false); setPreparationProgress(null); setPreparationMessage(null); setSelectionMessage(null);
    setPreparationStartedAt(Date.now()); setProgressUpdatedAt(Date.now());
    setPreparing(true); setReview(null); setQuickSnapshot(null); setSelected([]); setAuthorization(null); setReviewError(null); setReading(false);
    try {
      const value = await (quickReviewEnabled ? prepareQuickReview : prepareReviewedPlan)(limits.scanLimit, limits.executeLimit, (progress) => {
        if (!mounted.current || version.current !== current) return;
        session.id = progress.preparationId;
        setPreparationProgress(progress); setProgressUpdatedAt(Date.now());
        if (session.requested) void sendCancellation(session);
      }, scanOptions);
      if (!mounted.current || version.current !== current) return;
      setReviewError(null);
      const snapshot = value.quickReview ?? value.plan;
      if (value.status === 'cancelled') {
        setPreparationMessage(snapshot
          ? `Review cancelled. ${snapshot.fetchedGroups} of ${snapshot.preparation?.targetGroups ?? snapshot.fetchedGroups} groups checked; completed results are available below.`
          : 'Review cancelled before any groups were checked.');
      } else if (session.requested) setPreparationMessage('The review finished before cancellation took effect. All completed results are available below.');
      if (!snapshot) return value.status;
      const key = JSON.stringify(snapshot.scope);
      if (scope.current && key !== scope.current) { setRun(null); setPartialRun(null); setRequest(null); }
      scope.current = key;
      setLimits({ scanLimit: snapshot.scanLimit, executeLimit: snapshot.executeLimit });
      if ('reviewId' in snapshot) setQuickSnapshot(snapshot); else setReview(snapshot);
      setSelected(snapshot.candidates.slice(0, snapshot.executeLimit).map((c) => c.groupId));
      setInvalid(false); setExpired(Date.parse(snapshot.expiresAt) <= Date.now());
      return value.status;
    } catch (error) {
      if (mounted.current && version.current === current) setReviewError(error instanceof Error ? error.message : 'Review could not be prepared');
    } finally { pending.current = false; if (mounted.current && version.current === current) { setPreparing(false); setCancelling(false); preparation.current = null; } void refreshPending(); }
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
    } finally { pending.current = false; void refreshPending(); }
  }
  return { scanOptions, changeScanOptions, pendingCandidates, scanSummary, scanError, scanLoading, refreshPending, updateScan, loadPendingCandidates, invalidateReview, rulesPublished, review, quickSnapshot, quickReviewEnabled, changeQuickReview, loadingDetails, loadSelectedDetails, validQuickReview: Boolean(quickSnapshot && !invalid && !expired), selected, limits, preparing, selectingAll, selectionMessage, selectAll, cancelling, preparationProgress, preparationStartedAt, progressUpdatedAt, preparationMessage, cancelPreparation, reviewError, expired, invalid, validReview,
    prepare, selectGroups, changeLimits, canExecute: validReview && selected.length > 0 && authorization === selectionKey,
    run: partialRun ?? run, request, readError, reading, refreshLatest, execute, busy: request?.phase === 'pending', partial: Boolean(partialRun) };
}
export type ExecutionState = ReturnType<typeof useExecution>;
