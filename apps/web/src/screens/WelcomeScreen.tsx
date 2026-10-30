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
        </ul>
        <h3>Automatic cleanup requirements</h3>
        <ul>
          <li>Exactly two images: keep the larger external-library image over an internal copy with matching filenames and dimensions.</li>
          <li>Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.</li>
        </ul>
        <h3>Current limitations</h3>
        <ul>
          <li>Manual review displays decisions only. Manual keeper selection, thumbnails, configurable rules, and the dedicated History view are not available.</li>
          <li>Scans examine the first selected number of groups; resumable full-library scanning is not available.</li>
          <li>Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.</li>
          <li>Run one batch at a time. Automatic recovery and retry quarantine are not available; investigate uncertain outcomes before retrying.</li>
        </ul>
      </section>
    </div>
  );
}
