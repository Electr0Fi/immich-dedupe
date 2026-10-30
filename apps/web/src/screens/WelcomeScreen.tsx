export function WelcomeScreen() {
  return (
    <div>
      <header className="screen-header">
        <h1>Welcome</h1>
        <p>Immich Dedupe helps you safely review and resolve duplicate photos in your Immich library.</p>
      </header>

      <section className="card">
        <h2>Getting Started</h2>
        <p>
          Configure your Immich connection in <strong>Settings</strong>, then head to{' '}
          <strong>Dedupe</strong> to review and execute safe duplicate resolutions.
        </p>
      </section>

      <section className="card">
        <h2>How it works</h2>
        <ol className="welcome-steps">
          <li>Connect to your Immich instance via Settings.</li>
          <li>Run a dry-run in the Dedupe screen to preview what would be resolved.</li>
          <li>Review the execution plan carefully before running a live execution.</li>
          <li>Monitor results in the Logs screen.</li>
        </ol>
      </section>

      <section className="card current-functionality" aria-labelledby="current-functionality-title">
        <h2 id="current-functionality-title">Current Functionality</h2>
        <h3>Available now</h3>
        <ul>
          <li>Review duplicate groups already identified by Immich.</li>
          <li>Preview decisions, run dry-runs, execute eligible batches, and view or export batch logs.</li>
          <li>Check album membership before resolution and verify the result. Failed or uncertain operations stop the batch.</li>
          <li>Single-group and batch execution share safety checks, logging, and run/attempt IDs. Overlapping execution or recovery actions are rejected within one API process.</li>
          <li>Unfinished and uncertain attempts stay quarantined across restarts. In Logs, recheck outcomes and explicitly allow a new attempt only when the pair is still intact and eligible; neither action runs cleanup.</li>
          <li>Clearing display logs preserves recovery evidence, processed groups, and legacy exclusions.</li>
          <li>Dedupe explains verified, simulated, failed, and uncertain outcomes with expandable details and links to recovery. The latest saved run for the current account is restored when Dedupe opens; refresh to see newer evidence.</li>
        </ul>
        <h3>Automatic cleanup requirements</h3>
        <ul>
          <li>The Immich API key needs user.read for account identity checks, including dry-runs and recovery actions, alongside permissions for the requested library operations.</li>
          <li>Exactly two images: keep the larger external-library image over an internal copy with matching filenames and dimensions.</li>
          <li>Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.</li>
        </ul>
        <h3>Current limitations</h3>
        <ul>
          <li>Manual review displays decisions only. Manual keeper selection, thumbnails, configurable rules, and the dedicated History view are not available.</li>
          <li>Scans examine the first selected number of groups; resumable full-library scanning is not available.</li>
          <li>Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.</li>
          <li>Use one API instance per data directory. Multi-process locking, automatic retry/resumption, rollback, and asset restoration are not available. Other unresolved attempts can still block an explicitly released pair.</li>
          <li>Only the latest run is restored, with no automatic polling or full History view. Missing details in older records remain unknown. Partial results that could not be saved survive navigation in this browser session, but cannot be restored after reload.</li>
        </ul>
      </section>
    </div>
  );
}
