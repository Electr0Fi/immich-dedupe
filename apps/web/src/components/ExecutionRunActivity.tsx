import { useEffect, useState } from 'react';
import { executionRunStageLabels } from '../executionRunProgress';
import type { ExecutionState } from '../useExecution';

export function ExecutionRunActivity({ execution }: { execution: ExecutionState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const p = execution.runProgress;
  const elapsed = Math.max(0, Math.floor((now - (execution.runStartedAt ?? now)) / 1000));
  const waiting = now - (execution.runProgressUpdatedAt ?? execution.runStartedAt ?? now) >= 30000;
  return <div className="review-preparation-activity execution-run-activity">
    <div role="status" aria-live="polite" aria-atomic="true">
      <p>{p ? executionRunStageLabels[p.stage] : 'Waiting for the API to report run progress…'}</p>
      {p && <>
        {p.groupId && <p>{p.phase === 'validating' ? 'Validating selection' : 'Processing selection'} · Group {p.groupIndex} of {p.totalGroups} · {p.groupId}</p>}
        <p>{p.completedGroups} of {p.totalGroups} group attempts completed</p>
      </>}
    </div>
    {p && p.totalGroups > 0 && <progress aria-label="Run group attempts completed" value={p.completedGroups} max={p.totalGroups} />}
    <p>Elapsed {elapsed}s. {execution.request?.dryRun ? 'No Immich assets will be changed.' : 'Changes are confirmed only by verified run results.'}</p>
    {waiting && <p>Still waiting for the API or Immich. The last reported stage is shown above; the run may still be active.</p>}
  </div>;
}
