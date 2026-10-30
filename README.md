# Immich Dedupe

A local React/Express application for reviewing duplicate groups already identified by Immich and resolving eligible image pairs through the Immich API. It does not scan files or calculate image similarity itself.

## Current Functionality

### Available now

- Review duplicate groups already identified by Immich.
- Preview decisions, run dry-runs, execute eligible batches, and view or export batch logs as JSON or CSV. Dedupe shows a spinner and status message while requests are in progress.
- Check album membership before resolution and verify the result. Failed or uncertain operations stop the batch.
- Recheck group membership, asset details, file sizes, and album memberships before execution rather than relying on the preview cache.
- Single-group and batch execution share safety checks, logging, run/attempt IDs, and processed/quarantine exclusions. Overlapping execution, recovery, or log-clearing requests return HTTP 409 within one API process.
- Persist checkpoints before mutations and quarantine unfinished or uncertain attempts across restarts, including their group and selected asset IDs. Unrelated groups remain usable.
- Inspect recovery evidence in Logs, recheck outcomes without changing Immich, and explicitly allow a new attempt only after another fresh intact-pair check. Release does not run cleanup or override other quarantines.
- Clear display log entries without deleting recovery evidence, processed groups, or legacy exclusions.
- Read outcome summaries with expandable technical details and links to recovery. Dedupe restores the latest saved run for the current account when opened; use Refresh latest to check newer runs, including those from other tabs.

### Automatic cleanup requirements

- The Immich API key needs `user.read` for account identity checks, including dry-runs and recovery actions, in addition to permissions for the requested library operations.
- Exactly two images: keep the larger external-library image over an internal copy with matching filenames and dimensions.
- Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.
- Source classification uses configured-in-code path prefixes. Unknown paths cannot qualify. See `apps/api/src/classifySource.ts` for the current prefixes.
- Album additions must explicitly succeed and keeper memberships must be confirmed before resolution. Resolution must explicitly succeed, the loser must be confirmed trashed with its duplicate association cleared, and the keeper must remain untrashed.

### Current limitations

- Manual review displays decisions only. Manual keeper selection, thumbnails, configurable rules, and the dedicated History view are not available.
- Scans examine the first selected number of groups; resumable full-library scanning is not available.
- Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.
- Use one API instance per data directory. Multi-process locking, automatic retry/resumption, rollback, and restoration are not available. Investigate uncertain outcomes and recheck them before explicitly releasing a pair.
- Corrupt recovery storage disables execution and recovery-changing actions until repaired. The app never silently resets evidence or automatically promotes interrupted temporary files. Display logs are a separate audit view, not the recovery authority.
- Connection changes require an API restart. Test and save writes configuration; Clear form clears only the form. Reset preview cache clears browser scan previews only. Confirmation is a session-only browser preference; backend safety rules are fixed, and configurable performance settings are not implemented.
- This is a trusted local tool: the API has no authentication, allows cross-origin requests, and the connection-settings endpoint returns the saved API key. Do not expose it as a public service.
- Only the latest run is restored; full History and automatic polling are not implemented. Older records show missing request/stop details as unknown. Unsaved partial-response evidence survives screen navigation during this browser session but cannot be restored after reload.
- Packaged deployment and CI are not configured. Narrow screens use a horizontal navigation bar.

## Run locally

Use pnpm `10.33.0` (pinned in `package.json`). The development checks have been run with Node `24.14.1`.

```bash
pnpm install --frozen-lockfile
```

Create `apps/api/.env` with your own values:

```dotenv
PORT=3001
IMMICH_URL=http://localhost:2283/api
IMMICH_API_KEY=replace-with-your-key
```

The backend requires valid initial credentials to start. The API key must permit `GET /users/me` (`user.read`) to scope execution evidence to the server URL and account. A missing permission causes HTTP 503 before execution, including dry-runs. Enable `user.read` on the configured key in Immich; if replacing the key in `apps/api/.env`, restart the API. A successful connection test alone does not verify this permission. Include `/api` in the Immich API base URL where appropriate, without a trailing slash. Keep credentials out of Git.

Optionally set the Dedupe backend URL in `apps/web/.env`:

```dotenv
VITE_API_BASE_URL=http://localhost:3001
```

Never put an Immich key in a `VITE_` variable; those values are exposed in the browser bundle.

```bash
pnpm dev
```

The API defaults to port 3001. Open the Vite URL printed in the terminal, normally `http://localhost:5173`. The servers can also run separately using `pnpm --filter api dev` and `pnpm --filter web dev`.

1. Check the connection in Settings. Restart the API after saving connection changes and reload the browser to refresh the header status.
2. Open Dedupe and choose a scan limit (groups examined) and execution limit (eligible attempts).
3. Refresh the preview and run a dry-run. Proposed album transfers have not been performed.
4. Review selections before choosing Execute. Execution rechecks current data and may stop if it changed.
5. Inspect the outcome and batch logs. Investigate `needs-verification` results before retrying; no mutation is automatically retried.

## Execution API behavior

Both execution POST routes default to dry-run. Send literal JSON `"dryRun": false` to run live operations. Non-boolean modes and limits that are not positive safe integers return HTTP 400.

Batch defaults are `scanLimit: 100` and `executeLimit: 10`; UI defaults are 100 and 5. Legacy `limit` supplies missing limits; explicit values take precedence independently.

Outcomes are `dry-run`, `succeeded`, `failed`, and `needs-verification`. Results include the failure stage, proposed albums, and confirmed transfers. A batch response includes `stoppedEarly` and `stopReason`. HTTP 200 does not mean every group succeeded. Post-resolution verification allows three read rounds one second apart; mutations are submitted at most once per attempt.

```bash
curl -X POST http://localhost:3001/execution/run \
  -H 'Content-Type: application/json' \
  -d '{"scanLimit":10,"executeLimit":1,"dryRun":true}'
```

Display logs live in `apps/api/data/execution-log.json`. Recovery records live separately under `apps/api/data/execution-journal/`, with one versioned JSON file per run. Both are ignored by Git. Preserve this directory: clearing display logs does not reset recovery or successful-history exclusions.

At first execution or log clearing, recorded successful legacy group IDs are copied once into `legacy-exclusions.json` for the current connection. The old log is preserved and those exclusions are labeled legacy evidence, not verified attempts. Changing accounts or server URLs never imports the old log again into another library.

Recovery records are committed using a flushed temporary file, atomic rename and directory flush. The implementation requires an environment supporting directory fsync (validated on Linux). These checks protect application/process failures; they do not make Immich calls transactional or guarantee against hardware/storage failure. Run only one API instance against the directory.

### Recovery workflow

1. Open Logs → Execution Recovery and refresh the unresolved list. Details include original selections, checkpoint progress, partial effects, and assessment history.
2. Choose **Recheck outcome**. Verified resolved attempts become processed exclusions. An intact pair stays quarantined; incomplete or conflicting evidence remains inconclusive.
3. If the pair is intact, **Allow new attempt** asks for explicit confirmation and performs another fresh check. No cleanup runs. Other unresolved attempts involving these assets can still block them.
4. Start a separate dry-run or execution request from Dedupe when appropriate. Mutations are never automatically replayed.

HTTP 503 denotes unavailable identity/journal storage or checkpoint failure. If work already began, the response includes the run ID and partial results, which the WebUI displays. A display-log write failure stops the batch but a committed verified journal result remains authoritative.

Recovery endpoints: `GET /execution/recovery` (offset/limit pagination), `GET /execution/recovery/:attemptId`, `POST /execution/recovery/:attemptId/recheck`, and `POST /execution/recovery/:attemptId/release` with `{ "confirm": true }`. Rechecks and releases only read Immich and write local evidence.

## Architecture

```text
immich-dedupe/
  apps/
    api/              # Express app factory, startup, Immich SDK, execution and tests
    web/              # React/Vite dashboard and plain CSS
  packages/
    shared/           # Shared domain and execution types
    rule-engine/      # Pure deterministic decision rules
    immich-client/    # Reserved placeholder; SDK integration currently lives in apps/api
```

The execution path is: fetch duplicate groups → normalize and enrich → evaluate rules → revalidate selected groups → confirm album preservation → resolve → verify → log batch outcomes.

## Validation and development

```bash
pnpm test
pnpm test:ui
pnpm typecheck
pnpm lint
pnpm build
```

Tests use Node's test runner, the existing `tsx` loader, fake Immich responses, and temporary logs. HTTP tests require permission to open an ephemeral loopback port. No real Immich credentials or live cleanup are needed. Typechecking covers all workspace packages and API test sources. Lint currently covers the frontend only.

Build outputs are `apps/web/dist` and `apps/api/dist`; compilation is not a packaged deployment. There is no API start script or static frontend serving in Express. Standalone workspace package build scripts remain placeholders.

See [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for routes and operational detail, and [AGENTS.md](AGENTS.md) for development instructions. Every functionality change must update the Welcome page's Current Functionality card, this README, and the project guide together.

## Outcome summaries and latest-run reads

Dedupe distinguishes verified completed, simulated, failed, needs-verification, and awaiting-result attempts. Exclusions are grouped as processed, legacy evidence, or quarantined. Request errors and preview refresh errors appear separately. A lost execution response is unknown: the API may still be working. Check the journal and recovery evidence before retrying. Successful rechecks and releases appear as subsequent recovery assessments, preserving the original attempt outcome.

`GET /execution/runs/latest` and `GET /execution/runs/:runId` return compact journal views scoped to the normalized server URL and current account. They do not create migration markers, write evidence, or mutate Immich. Phases are running, finished, or interrupted (no recorded completion and no active coordinator). Details of checkpoints remain in recovery detail. No full-history listing is added.

New runs use journal version 2 with immutable request context and a terminal report (counts, exclusions, stop reason and request errors). Version 1 stays readable without rewriting or inventing missing metadata. **Older application releases cannot read version 2 files: do not downgrade against the same journal directory.** Preserve all evidence when upgrading or troubleshooting.

Browser checks use Chromium and fake API responses only:

```bash
pnpm --filter web exec playwright install --with-deps chromium
pnpm test:ui
```

The test command starts a dedicated frontend server and intercepts backend requests; no real API or Immich server is needed. Settings diagnostics export the current form URL, key-configured flag, connection test result, and session confirmation preference; keys and unimplemented performance settings are omitted.
