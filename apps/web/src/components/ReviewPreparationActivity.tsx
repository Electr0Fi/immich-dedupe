import { useEffect, useState } from 'react';
import type { ReviewPreparationStage } from '@immich-dedupe/shared';
import type { ExecutionState } from '../useExecution';

const labels: Record<ReviewPreparationStage, string> = {
  'checking-history': 'Checking recovery history', 'checking-identity': 'Checking Immich account identity',
  'fetching-groups': 'Fetching duplicate groups', 'checking-membership': 'Checking duplicate group membership',
  'checking-assets': 'Checking fresh asset details and safety rules', 'checking-albums': 'Checking album memberships', finalizing: 'Finalizing review',
};
export function ReviewPreparationActivity({ execution }: { execution: ExecutionState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const p = execution.preparationProgress;
  const elapsed = Math.max(0, Math.floor((now - (execution.preparationStartedAt ?? now)) / 1000));
  const waiting = now - (execution.progressUpdatedAt ?? now) >= 30000;
  return <div className="review-preparation-activity">
    <div className="status-refreshing" role="status" aria-live="polite" aria-atomic="true">
      <span className="spinner" aria-hidden="true" />
      <span>{execution.cancelling ? 'Cancelling review… Waiting for outstanding reads to finish.' : p ? labels[p.stage] : 'Starting review preparation…'}</span>
    </div>
    {execution.cancelling && p && <p>Last check: {labels[p.stage]}</p>}
    {p && <p>{p.checkedGroups} {p.targetGroups === null ? 'groups checked' : `of ${p.targetGroups} groups checked`} · {p.eligibleGroups} eligible · {p.excludedGroups} excluded</p>}
    {p?.targetGroups != null && p.targetGroups > 0 && <progress aria-label="Review groups checked" value={p.checkedGroups} max={p.targetGroups} />}
    <p>Elapsed {elapsed}s. No Immich assets will be changed.</p>
    {waiting && <p>Still waiting for Immich during this check. The last reported stage is shown above.</p>}
  </div>;
}
