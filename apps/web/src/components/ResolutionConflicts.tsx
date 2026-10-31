import { useState } from 'react';
import type { ExecutionState } from '../useExecution';
import type { ResolutionConflict } from '@immich-dedupe/shared';
import { isResolutionConflict } from '../resolutionUtils';
import { ResolutionConflictDetails } from './ResolutionConflictDetails';
export function ResolutionConflicts({ execution }: { execution: ExecutionState }) {
  const [open,setOpen] = useState(false);
  const groups = new Map(execution.resolutionConflicts.map((item) => [item.groupId,item]));
  const snapshot = execution.quickSnapshot ?? execution.review;
  for (const group of snapshot?.excludedGroups ?? []) if (group.resolution && isResolutionConflict(group.resolution)) {
    groups.set(group.groupId, { groupId: group.groupId, ruleName: group.ruleName ?? null, rulesetRevision: snapshot!.ruleset?.revision ?? 'unknown', observedAt: snapshot!.createdAt, assessment: group.resolution } satisfies ResolutionConflict);
  }
  if (!groups.size) return null;
  return <section className="card resolution-notice" aria-labelledby="resolution-conflicts-title"><h2 id="resolution-conflicts-title">Resolution conflicts ({groups.size})</h2><p>These groups cannot be selected for execution. Saved observations remain visible across continued scans; they are not fresh execution approvals.</p>
    <button type="button" aria-expanded={open} aria-controls="resolution-conflicts-list" onClick={() => setOpen(!open)}>{open ? 'Hide resolution conflicts' : 'View resolution conflicts'}</button>
    {open && <div id="resolution-conflicts-list">{[...groups.values()].map((group) => <details key={group.groupId}><summary>Group {group.groupId}: Resolution conflict</summary><p>Last checked: {new Date(group.observedAt).toLocaleString()} · Rules: {group.rulesetRevision}</p><ResolutionConflictDetails assessment={group.assessment} ruleName={group.ruleName} /></details>)}</div>}
  </section>;
}
