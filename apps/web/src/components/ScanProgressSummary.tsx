import type { ScanSnapshot, ScanStopReason } from '@immich-dedupe/shared';

const stopMessages: Record<ScanStopReason, string> = {
  'target-reached': 'Candidate target reached.',
  'inspection-budget': 'Inspection budget reached. Continue scanning to check more groups.',
  'snapshot-exhausted': 'All currently available groups have been considered. Refresh or recheck excluded groups to look for changes.',
  'cancelled': 'Scan cancelled. Completed checks and candidates were retained.',
  'read-failure': 'Scan stopped after a read failure. Completed checks were retained; unfinished work can be checked again.',
};
export function ScanProgressSummary({ scan, quick }: { scan: ScanSnapshot; quick: boolean }) {
  return <section className="card" aria-label="Scan progress"><h2>Scan progress</h2>
    {scan.preparation && <><p role="status">{stopMessages[scan.preparation.stopReason]}</p><p>Checked {scan.preparation.checkedThisRequest} groups this scan · found {scan.preparation.foundThisRequest} {quick ? 'provisional' : 'fully checked'} candidates.</p></>}
    <p>{scan.summary.visitedGroups} groups checked overall · {scan.summary.remainingGroups} remaining · {scan.summary.excludedGroups} excluded · {scan.summary.deferredGroups} deferred · {scan.summary.blockedGroups} protected by execution history or recovery.</p>
  </section>;
}
