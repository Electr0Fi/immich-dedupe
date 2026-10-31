import { useEffect, useState } from 'react';
import type { ExecutionState } from '../useExecution';
import { quickDetailLabels } from '../quickDetailStream';

export function QuickDetailActivity({ execution }: { execution: ExecutionState }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const p = execution.detailProgress;
  const elapsed = Math.max(0, Math.floor((now - (execution.detailStartedAt ?? now)) / 1000));
  const waiting = now - (execution.detailProgressUpdatedAt ?? execution.detailStartedAt ?? now) >= 30000;
  return <div className="review-preparation-activity quick-detail-activity">
    <div role="status" aria-live="polite" aria-atomic="true">
      <p>{p ? quickDetailLabels[p.stage] : 'Waiting for the API to report detail-loading progress…'}</p>
      {p?.groupId && <p>Group {p.groupIndex} of {p.totalGroups} · {p.groupId}</p>}
      {p && <p>{p.checkedGroups} of {p.totalGroups} selected groups checked</p>}
    </div>
    {p && p.totalGroups > 0 && <progress aria-label="Selected details checked" value={p.checkedGroups} max={p.totalGroups} />}
    <p>Elapsed {elapsed}s. No Immich assets will be changed.</p>
    {waiting && <p>Still waiting for the API or Immich. The last reported stage is shown above; detail loading may still be active.</p>}
  </div>;
}
