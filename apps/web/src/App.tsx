import { useEffect, useState } from "react";
import {
  clearExecutionLog,
  getDuplicateAnalysis,
  getExecutionLog,
  getExecutionLogExportUrl,
  getExecutionPlan,
  getExecutionStatus,
  runExecution,
  type DuplicateAnalysisResponse,
  type ExecutionLogEntry,
  type ExecutionPlanResponse,
  type ExecutionRunResponse,
  type ExecutionStatusResponse,
} from "./api";
import "./App.css";

function App() {
  const [scanLimit, setScanLimit] = useState(100);
  const [executeLimit, setExecuteLimit] = useState(5);

  const [status, setStatus] = useState<ExecutionStatusResponse | null>(null);
  const [log, setLog] = useState<ExecutionLogEntry[]>([]);
  const [plan, setPlan] = useState<ExecutionPlanResponse | null>(null);
  const [analysis, setAnalysis] = useState<DuplicateAnalysisResponse | null>(null);
  const [lastRun, setLastRun] = useState<ExecutionRunResponse | null>(null);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    const [statusResult, logResult, planResult, analysisResult] = await Promise.all([
      getExecutionStatus(scanLimit),
      getExecutionLog(),
      getExecutionPlan(scanLimit),
      getDuplicateAnalysis(scanLimit),
    ]);

    setStatus(statusResult);
    setLog(logResult.data);
    setPlan(planResult);
    setAnalysis(analysisResult);
  }

  async function handleDryRun() {
    setLoading(true);
    setError(null);

    try {
      const result = await runExecution({
        scanLimit,
        executeLimit,
        dryRun: true,
      });

      setLastRun(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  async function handleExecute() {
    const confirmed = window.confirm(
      `Execute up to ${executeLimit} duplicate resolutions from the first ${scanLimit} scanned groups?`
    );

    if (!confirmed) return;

    setLoading(true);
    setError(null);

    try {
      const result = await runExecution({
        scanLimit,
        executeLimit,
        dryRun: false,
      });

      setLastRun(result);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh().catch((err) =>
      setError(err instanceof Error ? err.message : "Unknown error")
    );
  }, []);

  const manualReviewItems =
    analysis?.results.filter(
      (decision) => decision.status === "uncertain" || decision.status === "skip"
    ) ?? [];

  function exportExecutionLog(format: "json" | "csv") {
    window.location.href = getExecutionLogExportUrl(format);
  }

  async function handleClearLog() {
    const confirmed = window.confirm(
      "Clear the execution log? This removes audit entries and processed-history tracking from the app."
    );

    if (!confirmed) return;

    setLoading(true);
    setError(null);

    try {
      await clearExecutionLog();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="page">
      <header className="header">
        <h1>Immich Dedupe</h1>
        <p>Review, dry-run, and execute safe duplicate resolutions.</p>
      </header>

      <section className="card">
        <h2>Controls</h2>

        <div className="controls">
          <label>
            Scan Limit
            <input
              type="number"
              min={1}
              value={scanLimit}
              onChange={(event) => setScanLimit(Number(event.target.value))}
            />
          </label>

          <label>
            Execute Limit
            <input
              type="number"
              min={1}
              value={executeLimit}
              onChange={(event) => setExecuteLimit(Number(event.target.value))}
            />
          </label>
        </div>

        <div className="buttonRow">
          <button disabled={loading} onClick={() => refresh()}>
            Refresh
          </button>

          <button disabled={loading} onClick={handleDryRun}>
            Dry run
          </button>

          <button
            disabled={loading}
            className="danger"
            onClick={handleExecute}
          >
            Execute
          </button>
        </div>

        {error && <p className="error">{error}</p>}
      </section>

      <section className="grid">
        <div className="card">
          <h2>Status</h2>

          {status ? (
            <dl className="stats">
              <div>
                <dt>Total Duplicates</dt>
                <dd>{status.duplicateCount}</dd>
              </div>
              <div>
                <dt>Scanned</dt>
                <dd>{status.scannedDuplicateCount}</dd>
              </div>
              <div>
                <dt>Executable</dt>
                <dd>{status.executableCount}</dd>
              </div>
              <div>
                <dt>Log Entries</dt>
                <dd>{status.logCount}</dd>
              </div>
            </dl>
          ) : (
            <p>No status loaded.</p>
          )}
        </div>

        <div className="card">
          <h2>Last Run</h2>

          {lastRun ? (
            <dl className="stats">
              <div>
                <dt>Dry run</dt>
                <dd>{String(lastRun.dryRun)}</dd>
              </div>
              <div>
                <dt>Eligible</dt>
                <dd>{lastRun.eligibleCount}</dd>
              </div>
              <div>
                <dt>Executed</dt>
                <dd>{lastRun.actuallyExecutedCount}</dd>
              </div>
              <div>
                <dt>Trashed</dt>
                <dd>{lastRun.trashedCount}</dd>
              </div>
            </dl>
          ) : (
            <p>No run yet.</p>
          )}
        </div>
      </section>

      <section className="card">
        <h2>Execution Plan Preview</h2>

        {plan && plan.items.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Keep</th>
                <th>Trash</th>
                <th>Confidence</th>
                <th>Rule</th>
                <th>Reasons</th>
                <th>Albums</th>
              </tr>
            </thead>
            <tbody>
              {plan.items.map((item) => (
                <tr key={item.groupId}>
                  <td>{item.groupId}</td>
                  <td>{item.keepAssetId}</td>
                  <td>{item.trashAssetId}</td>
                  <td>{item.confidence}</td>
                  <td>{item.ruleName ?? "Unknown"}</td>
                  <td>{item.reasons.join("; ")}</td>
                  <td>{item.albumTransferCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No executable plan items found.</p>
        )}
      </section>

      <section className="card">
        <h2>Manual Review</h2>

        {manualReviewItems.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Status</th>
                <th>Confidence</th>
                <th>Rule</th>
                <th>Reasons</th>
              </tr>
            </thead>
            <tbody>
              {manualReviewItems.map((decision) => (
                <tr key={decision.groupId}>
                  <td>{decision.groupId}</td>
                  <td>{decision.status}</td>
                  <td>{decision.confidence}</td>
                  <td>{decision.matchedRuleName ?? "None"}</td>
                  <td>{decision.reasons.join("; ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No uncertain or skipped duplicates in this scan window.</p>
        )}
      </section>

      <section className="card">
        <h2>Last Run Results</h2>

        {lastRun && lastRun.results.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Group</th>
                <th>Mode</th>
                <th>Executed</th>
                <th>Keep</th>
                <th>Trash</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {lastRun.results.map((result) => (
                <tr key={`${result.groupId}-${result.mode}`}>
                  <td>{result.groupId}</td>
                  <td>{result.mode}</td>
                  <td>{String(result.executed)}</td>
                  <td>{result.keepAssetId}</td>
                  <td>{result.trashAssetId}</td>
                  <td>{result.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p>No run results yet.</p>
        )}
      </section>

      <section className="card">
        <h2>Execution Log</h2>

        <div className="buttonRow tableActions">
          <button type="button" onClick={() => exportExecutionLog("json")}>
            Export JSON
          </button>

          <button type="button" onClick={() => exportExecutionLog("csv")}>
            Export CSV
          </button>

          <button
            type="button"
            disabled={loading}
            className="danger"
            onClick={handleClearLog}
          >
            Clear Log
          </button>
        </div>

        {log.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Group</th>
                <th>Mode</th>
                <th>Executed</th>
                <th>Resolved</th>
                <th>Trashed</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {log
                .slice()
                .reverse()
                .slice(0, 20)
                .map((entry, index) => (
                  <tr key={`${entry.timestamp}-${entry.groupId}-${index}`}>
                    <td>{entry.timestamp}</td>
                    <td>{entry.groupId}</td>
                    <td>{entry.mode}</td>
                    <td>{String(entry.executed)}</td>
                    <td>{String(entry.resolvedDuplicate)}</td>
                    <td>{String(entry.trashedAsset)}</td>
                    <td>{entry.message}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        ) : (
          <p>No log entries yet.</p>
        )}
      </section>
    </main>
  );
}

export default App;
