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
          <li>Prepare a review in Dedupe, expand group details to compare thumbnails and album changes, and include the groups you want.</li>
          <li>Dry-run the exact selection, then explicitly execute the reviewed batch.</li>
          <li>Monitor results in the Logs screen.</li>
        </ol>
      </section>

      <section className="card current-functionality" aria-labelledby="current-functionality-title">
        <h2 id="current-functionality-title">Current Functionality</h2>
        <h3>Available now</h3>
        <ul>
          <li>Enable Quick Review for faster duplicate-list-only rule checks without per-image, album or thumbnail requests. Missing data remains unverified. Load selected details to build a full review before dry-run and execution.</li>
          <li>Prepared group details start collapsed. Expand individual groups or use Expand All and Collapse All; selection checkboxes stay visible and disclosure changes preserve dry-run approval.</li>
          <li>Review duplicate groups already identified by Immich. Excluded groups explain unsupported asset counts, missing groups and inconsistent membership separately.</li>
          <li>Compare image thumbnails and metadata, include or exclude eligible groups, dry-run the exact selection, execute the reviewed batch, and view or export logs. Select first N uses Execute Limit. Select All includes every eligible group checked in the review and raises the limit when needed; a new dry-run is required. Review preparation shows live stages, counts and elapsed time. Cancel review stops early and keeps fully checked results available for review, dry-run and execution. Other pending requests show a spinner and status message.</li>
          <li>Check album membership before resolution and verify the result. Failed or uncertain operations stop the batch.</li>
          <li>Single-group and batch execution share safety checks, logging, and run/attempt IDs. Overlapping execution or recovery actions are rejected within one API process.</li>
          <li>Unfinished and uncertain attempts stay quarantined across restarts. In Logs, recheck outcomes and explicitly allow a new attempt only when the pair is still intact and eligible; neither action runs cleanup.</li>
          <li>Clearing display logs preserves recovery evidence, processed groups, and legacy exclusions.</li>
          <li>Dedupe explains verified, simulated, failed, and uncertain outcomes with hover/focus definitions, expandable details, and links to recovery. The latest saved run for the current account is restored when Dedupe opens; refresh to see newer evidence.</li>
          <li>Refresh previews independently of the reviewed selection and execution results. Connection failures include API access guidance and can be retried with Refresh previews. Missing API routes identify the failing endpoint and explain restart and routing checks.</li>
        </ul>
        <h3>Automatic cleanup requirements</h3>
        <ul>
          <li>Settings lists the API key permissions for connection checks, reviews, thumbnails and live cleanup. Thumbnails need asset.view; asset.read alone only permits metadata. Account identity checks, including dry-runs and recovery, require user.read.</li>
          <li>Exactly two images: keep the larger external-library image over an internal copy with matching filenames and dimensions.</li>
          <li>Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.</li>
        </ul>
        <h3>Current limitations</h3>
        <ul>
          <li>Manual review displays decisions only. Manual keeper selection, configurable rules, and the dedicated History view are not available.</li>
          <li>Reviews expire after 15 minutes, are consumed by live requests, and require rebuilding after page reload or API restart. Legacy API live routes still use the older workflow until a later release.</li>
          <li>Scans examine the first selected number of groups; resumable full-library scanning is not available.</li>
          <li>Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.</li>
          <li>Use one API instance per data directory. Multi-process locking, automatic retry/resumption, rollback, and asset restoration are not available. Other unresolved attempts can still block an explicitly released pair.</li>
          <li>Only the latest run is restored, with no automatic polling or full History view. Missing details in older records remain unknown. Partial results that could not be saved survive navigation in this browser session, but cannot be restored after reload.</li>
        </ul>
      </section>
    </div>
  );
}
