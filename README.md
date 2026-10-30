# Immich Dedupe

A local React/Express application for reviewing duplicate groups already identified by Immich and resolving eligible image pairs through the Immich API. It does not scan files or calculate image similarity itself.

## Current Functionality

### Available now

- Review duplicate groups already identified by Immich.
- Preview decisions, run dry-runs, execute eligible batches, and view or export batch logs as JSON or CSV.
- Check album membership before resolution and verify the result. Failed or uncertain operations stop the batch.
- Recheck group membership, asset details, file sizes, and album memberships before execution rather than relying on the preview cache.

### Automatic cleanup requirements

- Exactly two images: keep the larger external-library image over an internal copy with matching filenames and dimensions.
- Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.
- Source classification uses configured-in-code path prefixes. Unknown paths cannot qualify. See `apps/api/src/classifySource.ts` for the current prefixes.
- Album additions must explicitly succeed and keeper memberships must be confirmed before resolution. Resolution must explicitly succeed, the loser must be confirmed trashed with its duplicate association cleared, and the keeper must remain untrashed.

### Current limitations

- Manual review displays decisions only. Manual keeper selection, thumbnails, configurable rules, and the dedicated History view are not available.
- Scans examine the first selected number of groups; resumable full-library scanning is not available.
- Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.
- Run one batch at a time. Automatic recovery, execution locking, and durable retry quarantine are not available; investigate uncertain outcomes before retrying.
- Single-group execution does not yet use batch logging or processed-group tracking. Clearing batch logs also clears that tracking and does not undo Immich changes.
- Connection changes require an API restart. Clear Credentials clears the form only. Performance settings and most safety controls are placeholders; execution safety is enforced by backend code.
- This is a trusted local tool: the API has no authentication, allows cross-origin requests, and the connection-settings endpoint returns the saved API key. Do not expose it as a public service.
- Packaged deployment and CI are not configured. Navigation is currently hidden below 900 px without an alternate mobile menu.

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

The backend requires valid initial credentials to start. Include `/api` in the Immich API base URL where appropriate, without a trailing slash. Keep credentials out of Git.

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

Batch logs live in `apps/api/data/execution-log.json` and are ignored by Git. Existing historical log entries remain readable; newer fields are not retroactively added.

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
pnpm typecheck
pnpm lint
pnpm build
```

Tests use Node's test runner, the existing `tsx` loader, fake Immich responses, and temporary logs. HTTP tests require permission to open an ephemeral loopback port. No real Immich credentials or live cleanup are needed. Typechecking covers all workspace packages and API test sources. Lint currently covers the frontend only.

Build outputs are `apps/web/dist` and `apps/api/dist`; compilation is not a packaged deployment. There is no API start script or static frontend serving in Express. Standalone workspace package build scripts remain placeholders.

See [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for routes and operational detail, and [AGENTS.md](AGENTS.md) for development instructions. Every functionality change must update the Welcome page's Current Functionality card, this README, and the project guide together.
