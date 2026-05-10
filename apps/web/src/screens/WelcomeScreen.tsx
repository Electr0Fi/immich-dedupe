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
    </div>
  );
}
