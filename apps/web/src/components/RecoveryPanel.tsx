import { useCallback, useEffect, useRef, useState } from 'react';
import { getRecovery, getRecoveryAttempt, recheckAttempt, releaseAttempt, type RecoveryList, type RecoveryAttempt } from '../api';

export function RecoveryPanel({ focusAttemptId = null }: { focusAttemptId?: string | null }) {
  const [state, setState] = useState<RecoveryList | null>(null);
  const [offset, setOffset] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [detail, setDetail] = useState<RecoveryAttempt | null>(null);
  const version = useRef(0);
  const mounted = useRef(false);
  const pageSize = 25;
  const namespace = useRef<string | null>(null);
  const applyState = useCallback((value: RecoveryList) => {
    const key = JSON.stringify(value.scope);
    if (namespace.current !== key) {
      namespace.current = key; setDetail(null); setNotice(null);
    } else {
      setDetail((current) => current ? value.items.find((item) => item.attemptId === current.attemptId) ?? current : null);
    }
    setState(value);
  }, []);

  useEffect(() => {
    mounted.current = true;
    const request = ++version.current;
    getRecovery(offset, pageSize)
      .then(async (value) => {
        if (!mounted.current || request !== version.current) return;
        applyState(value); setError(null);
        if (focusAttemptId) {
          const selected = await getRecoveryAttempt(focusAttemptId);
          if (mounted.current && request === version.current) setDetail(selected.attempt);
        }
      })
      .catch((failure: unknown) => { if (mounted.current && request === version.current) setError(failure instanceof Error ? failure.message : 'Recovery information could not be loaded'); });
    return () => { mounted.current = false; };
  }, [offset, applyState, focusAttemptId]);

  async function refresh() {
    const request = ++version.current;
    const value = await getRecovery(offset, pageSize);
    if (mounted.current && request === version.current) applyState(value);
  }
  async function action(attemptId?: string, kind?: 'details' | 'recheck' | 'release') {
    if (kind === 'release' && !window.confirm('Allow a new attempt only if a fresh check confirms this pair is intact and eligible? Earlier operations may have left partial changes. This will not run cleanup or remove other quarantines.')) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (attemptId && kind) {
        const result = kind === 'details' ? await getRecoveryAttempt(attemptId) : kind === 'release' ? await releaseAttempt(attemptId) : await recheckAttempt(attemptId);
        if (mounted.current) {
          setDetail(result.attempt);
          setNotice(kind === 'release' ? 'Release recorded. Other unresolved attempts may still block these assets. Cleanup requires a separate execution request.' : kind === 'recheck' ? result.attempt.assessments.at(-1)?.message ?? 'Recheck completed' : null);
        }
      }
      await refresh();
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : 'Recovery action failed');
      try { await refresh(); } catch { /* retain the original action error */ }
    } finally { if (mounted.current) setBusy(false); }
  }
  return <RecoveryView state={state} busy={busy} error={error} notice={notice} detail={detail}
    onAction={action} onPage={setOffset} />;
}

/** Presentational view also permits rendering recovery/error states with fake responses. */
export function RecoveryView({ state, busy, error, notice, detail, onAction, onPage }: {
  state: RecoveryList | null; busy: boolean; error: string | null; notice: string | null; detail: RecoveryAttempt | null;
  onAction: (attemptId?: string, kind?: 'details' | 'recheck' | 'release') => void;
  onPage: (offset: number) => void;
}) {
  const detailRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (detail) detailRef.current?.focus(); }, [detail]);
  const disabled = busy || !state || state.health !== 'ready' || Boolean(state.activeRunId);
  const displayed = detail ? [detail, ...(state?.items.filter((a) => a.attemptId !== detail.attemptId) ?? [])] : state?.items ?? [];
  return (
    <section className="card" aria-labelledby="recovery-heading">
      <h2 id="recovery-heading">Execution Recovery</h2>
      <p>Unfinished and uncertain attempts remain quarantined across restarts. Rechecking only reads Immich; releasing permits a separate new attempt and never runs cleanup.</p>
      <div className="buttonRow tableActions">
        <button type="button" disabled={busy} onClick={() => onAction()}>Refresh recovery</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {state?.error && <p className="error" role="alert">{state.error}</p>}
      {state?.scope && <p className="run-identifier">Connection: {state.scope.apiUrl} · Account: {state.scope.accountId}</p>}
      {state?.activeRunId && <p role="status">Execution or recovery action running: {state.activeRunId}</p>}
      {notice && <p role="status">{notice}</p>}
      {!state && !error && <p>Loading recovery information…</p>}
      {state?.health === 'ready' && state.items.length === 0 && <p>No unresolved attempts on this page.</p>}
      {displayed.map((attempt) => {
        const assessment = attempt.assessments.at(-1);
        const unresolved = !attempt.releasedAt && assessment?.classification !== 'verified-resolved' && (!attempt.result || attempt.result.outcome === 'needs-verification');
        const last = attempt.checkpoints.at(-1)?.event;
        const confirmed = attempt.result?.transferredAlbumIds ?? [...attempt.checkpoints].reverse().find((c) => c.event.kind === 'album-observed')?.event.confirmedAlbumIds ?? [];
        return <article key={attempt.attemptId} className="recovery-attempt">
          <h3>Group {attempt.groupId}</h3>
          <dl>
            <dt>Run / attempt</dt><dd>{attempt.runId} / {attempt.attemptId}</dd>
            <dt>Keep / trash</dt><dd>{attempt.keepAssetId ?? 'Unknown'} / {attempt.trashAssetId ?? 'Unknown'}</dd>
            <dt>Last stage</dt><dd>{last?.kind ?? 'Prepared'}</dd>
            <dt>Confirmed transfers</dt><dd>{confirmed.length ? confirmed.join(', ') : 'None confirmed'}</dd>
            <dt>Quarantine reason</dt><dd>{attempt.result?.message ?? 'Attempt did not finish; its outcome must be verified.'}</dd>
          </dl>
          {assessment && <p>Last recheck: {assessment.classification} — {assessment.message}</p>}
          {!unresolved && <p>This attempt is {attempt.releasedAt ? 'released' : assessment?.classification === 'verified-resolved' ? 'verified resolved' : 'closed'}. Earlier evidence is preserved.</p>}
          <div className="buttonRow">
            <button type="button" disabled={busy} onClick={() => onAction(attempt.attemptId, 'details')}>View evidence</button>
            {unresolved && <button type="button" disabled={disabled} onClick={() => onAction(attempt.attemptId, 'recheck')}>Recheck outcome</button>}
            {unresolved && assessment?.classification === 'pair-intact' && <button type="button" disabled={disabled} onClick={() => onAction(attempt.attemptId, 'release')}>Allow new attempt</button>}
          </div>
        </article>;
      })}
      {state && state.total > 0 && <div className="buttonRow">
        <button type="button" disabled={busy || state.offset === 0} onClick={() => onPage(Math.max(0, state.offset - state.limit))}>Previous</button>
        <span>{state.total} unresolved attempts</span>
        <button type="button" disabled={busy || state.offset + state.limit >= state.total} onClick={() => onPage(state.offset + state.limit)}>Next</button>
      </div>}
      {detail && <details open ref={detailRef} tabIndex={-1}><summary>Evidence for {detail.attemptId}</summary><pre className="recovery-evidence">{JSON.stringify(detail, null, 2)}</pre></details>}
    </section>
  );
}
