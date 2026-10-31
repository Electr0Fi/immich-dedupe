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
          Configure your Immich connection in <strong>Settings</strong>, check your directory preferences in <strong>Rules</strong>, then head to{' '}
          <strong>Dedupe</strong> to review and execute safe duplicate resolutions.
        </p>
      </section>

      <section className="card">
        <h2>How it works</h2>
        <ol className="welcome-steps">
          <li>Connect to your Immich instance via Settings.</li>
          <li>Configure and publish comparison rules and directory keeper preferences in Rules.</li>
          <li>Prepare a review in Dedupe, expand group details to compare thumbnails and album changes, and include the groups you want.</li>
          <li>Dry-run the exact selection, then explicitly execute the reviewed batch.</li>
          <li>Monitor results in the Logs screen.</li>
        </ol>
      </section>

      <section className="card current-functionality" aria-labelledby="current-functionality-title">
        <h2 id="current-functionality-title">Current Functionality</h2>
        <h3>Available now</h3>
        <ul>
          <li>Configure comparison rules and directory keeper preferences in Rules, with Enabled toggles beside each rule heading and wider name fields. Create, edit, save and delete named presets containing all rules; selecting a preset updates the editor, and saving prompts to overwrite an existing name or create a new one. Preset saves do not publish rules. Retained legacy drafts upgrade before saving; validation errors identify the affected rule and preserve edits. Failed preset refreshes preserve edits and show API compatibility guidance. Checksum matching is enabled by default. Metadata presets require explicit acknowledgement because matching names, sizes or dimensions cannot prove identical image content.</li>
          <li>Each rule separates candidate selection (include/exclude comparisons and conditions) from resolution (AND/OR keeper requirements and mandatory album preservation). Included groups still require review, a successful dry-run and explicit execution on Dedupe; saving or publishing rules never resolves duplicates.</li>
          <li>Choose a keeper using nested AND/OR requirements, such as preferred directory and greater file size. Neither or both images matching is a visible resolution conflict, excluded from execution. Conflicts retain last-checked observations across scans; old presets convert automatically and require review and publication before new reviews.</li>
          <li>Continue scanning additional groups with persistent progress: inspect a fixed number of groups or find a candidate target within an inspection budget. Unresolved candidates remain in a pending list across restarts; load their details to create a fresh review and complete a new dry-run.</li>
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
          <li>Exactly two unlinked images must satisfy the active published rules. Keep the copy in a preferred directory or use ordered metadata preferences; ties are excluded. Copies may come from the same source type.</li>
          <li>Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.</li>
        </ul>
        <h3>Current limitations</h3>
        <ul>
          <li>Manual keeper selection and the dedicated History view are not available. Pixel comparison, videos and groups larger than two are unsupported. AI similarity alone cannot include a group.</li>
          <li>Reviews expire after 15 minutes, are consumed by live requests, and require rebuilding after page reload, API restart or publishing changed rules. Saved scan progress does not restore execution approval. Legacy live API routes remain available and enforce active rules.</li>
          <li>Immich returns its complete duplicate list without pagination. Continuing scans avoids repeatedly checking unchanged exclusions but still downloads that list. Metadata heuristics can include genuinely different images; enable them only if you accept that risk.</li>
          <li>Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.</li>
          <li>Use one API instance per data directory. Multi-process locking, automatic retry/resumption, rollback, and asset restoration are not available. Other unresolved attempts can still block an explicitly released pair.</li>
          <li>Only the latest run is restored, with no automatic polling or full History view. Missing details in older records remain unknown. Partial results that could not be saved survive navigation in this browser session, but cannot be restored after reload.</li>
        </ul>
      </section>
    </div>
  );
}
