# Immich Dedupe: repository and operations guide

Reviewed on 2026-10-30. This is a working reference for future development sessions, based on the repository's application code, package scripts, configuration, and existing documentation. Recheck the source when changing behavior; this file describes the reviewed snapshot.

## Purpose and current state

Immich Dedupe is a local web application for resolving duplicate groups already identified by an Immich server. It does not scan image files itself or calculate visual similarity. Its main use case is keeping a larger external-library original and trashing a smaller internal-library copy while preserving album membership.

The backend, deterministic rules, batch executor, React dashboard, plan preview, and execution logs are implemented. Manual review currently means displaying uncertain/skipped decisions, with no manual choice or resolution controls. History is a placeholder. There are no thumbnails, configurable rules, database, CI workflow, container setup, or packaged deployment in the tracked repository.

The root README and Welcome page’s Current Functionality card describe the current release together. `apps/web/README.md` is Vite template documentation. `CLAUDE.md` provides project conventions; credential isolation remains a desired property rather than the current settings behavior.

## Repository map

| Path | Responsibility |
| --- | --- |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | pnpm workspace, orchestration scripts, resolved dependencies |
| `tsconfig.base.json` | Shared strict TypeScript configuration for backend/packages |
| `apps/api/src/index.ts` | Production composition root: environment, SDK, log path, settings writer, listener |
| `apps/api/src/app.ts` | Side-effect-free `createApp`: injected SDK/config/fetch/log/settings writer, routes and response helpers |
| `apps/api/src/immichClient.ts` | Typed subset of SDK operations used by the backend |
| `apps/api/src/settingsPersistence.ts` | Settings writer taking an explicit `.env` path |
| `apps/api/tests/` | Node test-runner regression tests and fake SDK fixtures |
| `apps/api/src/config.ts` | dotenv loading and Zod environment validation |
| `apps/api/src/immich.ts` | Global Immich SDK initialization |
| `apps/api/src/normalizeDuplicates.ts` | Convert SDK duplicate groups to shared records |
| `apps/api/src/classifySource.ts` | Infer external/internal source from path prefixes |
| `apps/api/src/enrichWithAssetInfo.ts` | Fetch and cache file sizes |
| `apps/api/src/enrichWithAlbums.ts` | Build asset-to-album membership index |
| `apps/api/src/executeDecision.ts` | Safety guards, album transfer, duplicate resolution, verification |
| `apps/api/src/executePlan.ts` | Pure executable-decision predicate |
| `apps/api/src/executionService.ts` | Shared coordinator, lock, identity, exclusions, logging, recovery actions |
| `apps/api/src/executionJournal.ts`, `atomicJson.ts` | Validated, atomic versioned run files and one-time legacy exclusions |
| `apps/api/src/reconcileAttempt.ts` | Bounded read-only reconciliation |
| `apps/api/src/executionLog.ts` | Separate display-log persistence; malformed files are preserved and reported |
| `apps/web/index.html`, `src/main.tsx`, `src/App.tsx` | Browser entry and React root |
| `apps/web/src/components/` | Shell, header, sidebar, screen selection |
| `apps/web/src/screens/` | Welcome, Dedupe, History, Logs, Settings |
| `apps/web/src/api.ts` | Backend fetch wrappers and locally declared response types |
| `apps/web/src/index.css`, `src/App.css` | Template globals and application styles |
| `apps/web/vite.config.ts` | Vite with React plugin; no API proxy or custom port |
| `packages/shared/src/types.ts` | Domain types: assets, groups, decisions, plans, results |
| `packages/rule-engine/src/index.ts` | Pure, ordered decision rules |
| `packages/immich-client/src/index.ts` | Unused placeholder, not the actual SDK integration |

`apps/web/src/index.ts` is also a placeholder; the browser starts at `main.tsx`. Template image assets remain in the tree. Package entry points in the shared packages point directly to TypeScript source.

## Stack and local setup

This is a TypeScript pnpm monorepo using Express 5, `@immich/sdk` 2.7.x, Zod 4, React 19, Vite 8, and plain CSS. The package manager is pinned to `pnpm@10.33.0`. The review environment used Node `v24.14.1` and pnpm `10.33.0`; the root package does not declare a Node engine requirement.

From the repository root:

```bash
pnpm install --frozen-lockfile
```

Create `apps/api/.env` with your own values (never commit real credentials):

```dotenv
PORT=3001
IMMICH_URL=http://localhost:2283/api
IMMICH_API_KEY=replace-with-your-key
```

`IMMICH_URL` is the Immich API base URL, including `/api` where applicable. Use no trailing slash for the direct settings fetches. The API must be able to reach that address. `IMMICH_URL` and `IMMICH_API_KEY` are mandatory at startup; a missing/invalid environment aborts startup before the Settings screen can configure a working backend.

Optionally create `apps/web/.env`:

```dotenv
VITE_API_BASE_URL=http://localhost:3001
```

This is the Dedupe backend URL, not the Immich URL. It defaults to the value above. Vite exposes `VITE_` variables to the browser; never place an Immich key there. For a browser on another machine, `localhost` means that browser's machine. Restart Vite after changing its environment; production bundles need rebuilding.

Run both development servers:

```bash
pnpm dev
```

Or run them separately in two terminals:

```bash
pnpm --filter api dev
pnpm --filter web dev
```

The API uses `tsx watch src/index.ts`, on port 3001 unless overridden. Vite uses its default development port, normally 5173; follow its printed URL if occupied. The frontend calls the API directly with cross-origin fetches. Express enables permissive CORS. Running through the package scripts ensures dotenv and settings writes use the API package working directory.

Connection Settings can test supplied credentials and write them to `apps/api/.env`. The parsed `env` object and SDK configuration are initialized once, so restart the API after saving. The watcher is not explicitly configured to restart for `.env` changes. The header checks server status only when the shell mounts, so reload the browser to refresh it.

The configured Immich key must permit `GET /users/me` (`user.read`) in addition to permissions for the requested library operations. Execution (including dry-runs), recovery changes, and log clearing fail closed with HTTP 503 if account identity cannot be verified. A successful connection test does not establish this permission. Identity errors distinguish missing `user.read`, denied access, and rejected credentials without exposing raw SDK errors. Enable the permission on the key in Immich, or replace the configured key and restart the API. Do not bypass the lookup or change recovery evidence to resolve a permissions error.

## Data flow

```text
React dashboard -> Express API -> Immich SDK / Immich server
                                  |
                       fetch existing duplicate groups
                                  |
                       take first N groups (scanLimit)
                                  |
                      normalize -> file sizes -> albums
                                  |
                          pure rule evaluation
                                  |
                    preview / dry-run / live batch
                                  |
                 transfer albums -> resolve -> verify
                                  |
                    apps/api/data/execution-log.json
```

Normalization preserves IDs, filenames, paths, timestamps, dimensions, checksums, source flags, edited/trashed flags, and initializes empty album memberships and null file sizes. Dimensions fall back to EXIF values. Missing safety flags remain null (unknown), never false. Records include media type, favorite/archive/offline flags, and Live Photo linkage; the rule engine requires complete negative safety flags and unlinked images. Checksums and timestamps are stored but are not compared by the rules.

Source classification uses hardcoded prefixes in `classifySource.ts`, not `libraryId` or a server-provided external flag. Recognized external paths include `/external/`, `/mnt/external/`, and `/photos/external/`. Internal paths include `/usr/src/app/upload/`, `/photos/internal/`, `/data/internal/`, and `/data/library/admin/`. Unknown paths produce both flags false and cannot qualify for automatic resolution. Paths are lowercased before matching; an extra mixed-case external prefix is redundant. Check actual Immich paths when troubleshooting zero eligible groups.

File sizes come from `getAssetInfo().exifInfo.fileSizeInByte`, accepting finite numbers or numeric strings. An app-scoped map caches sizes, including null values, with no expiry. Preview asset/group enrichment uses `Promise.all` without a concurrency limit. Execution bypasses cached sizes and reads both selected assets afresh. Album enrichment fetches every visible album and then its full assets sequentially, rebuilding the index for each request. An enrichment request failure aborts that request.

## Decision rules

Rules run in order; the first match wins. Confidence is a fixed rule score, not a statistical probability.

| Rule | Conditions and result |
| --- | --- |
| External larger, same name/resolution | Exactly two unlinked images; edited/trashed/favorite/archive/offline flags are explicitly false; trimmed case-insensitive filenames match; both width and height are known and equal; one external and one internal; both sizes known; external strictly larger. Keep external, trash internal, `auto-resolve`, confidence 100. |
| Missing size | Same pair/name/resolution/safety conditions, but either size absent. `uncertain`, confidence 40, no asset selections. |
| Different resolution | Exactly two assets with matching filenames for which the equal-known-dimensions check fails. `skip`, confidence 0. Missing dimensions also land here, despite the displayed reason saying resolution differs. |
| Protected or unknown metadata | Non-images, Live Photo links, any protected safety flag, or unknown required flags yield `uncertain`, confidence 10; evaluated before other rules. |
| Default | Everything else, including larger groups and equal-sized pairs. `uncertain`, confidence 10. |

The engine is pure and makes no network calls. New rules belong in `packages/rule-engine`, with data contracts in `packages/shared`. The web package currently duplicates response types rather than importing shared contracts.

## Execution semantics and persistence

`scanLimit` chooses the first N groups from the server response; it is not pagination. `executeLimit` caps attempted eligible groups, including failed attempts and dry-run results. Batch defaults are scan 100 / execute 10; UI defaults are scan 100 / execute 5. Legacy request field `limit` supplies both defaults when provided. Both execution POST bodies are validated with Zod. Supplied limits must be positive safe integers; strings, nulls, zero, negative and fractional limits return HTTP 400. Explicit limits independently override the legacy fallback. Read-only query endpoints retain their existing permissive limit parser.

Both execution routes use one coordinator, with UUID run/attempt IDs and the same logging/exclusion policy. A lock is acquired before scanning/enrichment and retained until work finishes, even after client disconnect. Other execution requests (including dry-runs), rechecks, releases, and log clears return HTTP 409 while busy. The lock is per API process; multiple instances sharing storage are unsupported.

The executor requires exactly two assets, one external and one internal, an `auto-resolve` decision with confidence 100, one trash ID, distinct keep/trash IDs, and both selected assets present. Batch execution reports exclusions from authoritative journal successes, verified-resolved assessments, legacy exclusions, and quarantines. Quarantine matches group IDs or either selected asset ID; unrelated groups remain usable. Single-group requests for excluded groups return HTTP 409. Decisions are matched by group ID.

Dry-run is the default for both execution routes and internal executors. It rechecks group/asset eligibility and current albums but does not mutate Immich. `proposedAlbumIds` reports proposed transfers; `transferredAlbumIds` stays empty. Batch dry-runs still append local audit entries.

Before either dry-run or live execution, the executor refetches duplicate membership and both selected assets, requires the same two IDs and group associations, reads uncached sizes, and re-evaluates the same keeper/loser selection. Asset-filtered default and shared-album queries provide current visible memberships. Missing or malformed required data fails preflight.

Live execution adds the kept asset to missing loser albums once, requires `success === true`, and rereads affected album details to confirm membership. Existing overlapping keeper memberships are checked too. Only then does it call SDK `resolveDuplicates` (Immich `POST /duplicates/resolve`) once. A nonempty response with successful items and no reported error is required. The loser must be confirmed `isTrashed === true` with `duplicateId === null`, and the keeper must be confirmed untrashed. Verification has at most three rounds, one second apart. Exceptions, 404s and missing fields are never success. Mutations are not retried. Preserve this operation ordering. Do not replace duplicate resolution with Immich `DELETE /duplicates/:id`, which is not the intended asset-cleanup operation.

Batch work is sequential with a fixed 50 ms delay after successful or dry-run attempts. The first failed/uncertain attempt stops processing and returns `stoppedEarly: true` with `stopReason`. Failed attempts still count toward `executeLimit`. An audit-write failure also stops further work while retaining returned results. Once journaled, verified success stays authoritative even if the display log fails. Successful live entries require `mode === "execute"` and all of `executed`, `resolvedDuplicate`, and `trashedAsset` true to enter processed tracking.

The active log is **`apps/api/data/execution-log.json`**, selected in startup relative to `src` or `dist` through `__dirname`. It is ignored by Git. Tracked `execution-log.json` files at the repository root and `apps/api/` are not read by the current logger; the older `src/execution-log.json` location is no longer used. Tests inject a temporary log path. Display-log writes remain synchronous and rewrite the file. Missing files read as empty, but malformed/unreadable logs now raise an error without replacement. They are not the recovery authority.

Clearing display logs preserves journal records, completed-history exclusions, quarantines, and legacy exclusions. It does not undo Immich operations. Single-group execution now shares logging and exclusion checks with batch execution. Read-only plan/status counts still describe rule eligibility, while execution returns `excludedGroups` explaining processed/legacy/quarantined candidates.

## Durable recovery evidence

`apps/api/data/execution-journal/` holds one versioned JSON file per run (version 2 for new runs; version 1 remains readable) and a separate `legacy-exclusions.json`. The store loads lazily so app construction stays side-effect free. Records validate IDs, checkpoint order, album requirements, outcomes and scope. Interrupted temporary files are retained but never promoted. Writes flush a same-directory temporary file, rename it atomically, then flush the directory; directory fsync is required (validated on Linux). Filesystem operations are injectable for fault tests.

An attempt is saved before processing. Fresh preflight records include original selections, safety details and loser album requirements. A durable intent must complete before each album-add or resolution call. Subsequent checkpoints capture sanitized responses, confirmed album additions, and each verification round. Terminal results are saved before the separate display-log append. Run completion follows all attempts. No API keys are stored.

The scope is the normalized API origin/path and authenticated current-user ID. Identity lookup must succeed before execution/recovery changes. The first initialization before execution or log clearing copies recorded-success legacy group IDs into a one-time scoped exclusion record without changing the original log. These are labeled legacy exclusions rather than verified attempts; dry-runs are not imported. Changing connections does not repeat migration into a different library. Malformed legacy data prevents migration/clearing rather than silently losing history.

Unfinished or `needs-verification` attempts stay quarantined across restarts. Reconciliation performs bounded reads only: verified resolved requires a trashed/unlinked loser, untrashed keeper, absent original group, and every recorded required album containing the keeper. An intact assessment requires the same eligible pair and original album requirements accounted for on the keeper or loser. All other observations remain inconclusive. Assessments append without rewriting original uncertainty.

An intact assessment does not unblock anything. Explicit release requires `{ "confirm": true }` and another fresh intact check; it appends a release event, never performs cleanup, and cannot override other unresolved attempts sharing assets. A new execution is a separate request. Corrupt/unsupported/inconsistent journals or failed writes disable execution/recovery changes with HTTP 503. A failed checkpoint after work began returns the run ID and partial results. Preserve evidence and repair storage rather than deleting/resetting it. Application/process-failure safeguards do not provide transactional Immich changes or protection from hardware failure/external races.

## HTTP interface

All routes are defined in `apps/api/src/app.ts`. Importing it does not load environment variables, initialize the SDK, access storage, or start a listener. Most failures return HTTP 500 with `{ ok: false, error }`; some settings failures return HTTP 200 with `ok: false`. A successful batch HTTP response can contain failed per-group results.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/`, `/health` | Route hints and backend liveness; health does not test Immich |
| GET | `/immich/test` | SDK server ping |
| GET | `/immich/duplicates` | Raw groups |
| GET | `/immich/duplicates/normalized` | All groups normalized |
| GET | `/immich/duplicates/enriched?limit=10` | Limited groups plus file sizes |
| GET | `/immich/duplicates/enriched-albums?limit=10` | Limited groups plus sizes/albums |
| GET | `/immich/duplicates/:groupId` | Raw group lookup and `exists` flag |
| GET | `/immich/assets/:id` | Asset details |
| GET | `/immich/albums`, `/immich/albums/:id` | Albums / full album details |
| GET | `/analysis/duplicates?limit=10` | Decisions and counts |
| GET | `/execution/plan?scanLimit=100` | Eligible selections, reasons, album-transfer counts |
| GET | `/execution/status?scanLimit=100` | Duplicate/executable counts and latest log entry |
| GET | `/execution/duplicates/:groupId/preview` | Single-group decision and proposed albums |
| POST | `/execution/duplicates/:groupId` | Single-group run with `{ "dryRun": true }` for simulation |
| POST | `/execution/run` | Batch `{ scanLimit, executeLimit, dryRun }` |
| GET | `/execution/log` | Display log, count, filesystem path |
| GET | `/execution/recovery?offset=0&limit=25` | Journal health, active run, scope and paginated unresolved attempts (limit 1–100) |
| GET | `/execution/recovery/:attemptId` | Full current-scope attempt evidence |
| POST | `/execution/recovery/:attemptId/recheck` | Read-only Immich reconciliation and local assessment |
| POST | `/execution/recovery/:attemptId/release` | Explicit confirmed fresh-check release; never cleanup |
| GET | `/execution/log/export.json`, `/execution/log/export.csv` | Download full log; CSV includes BOM and escaped fields |
| POST | `/execution/log/clear` | Clear display entries only; preserve recovery and exclusions |
| GET | `/settings/status` | Ping/about-based connection status |
| GET | `/settings/connection` | Current startup URL and API key |
| POST | `/settings/connection` | Write `{ immichUrl, apiKey }` to backend `.env` |
| POST | `/settings/test-connection` | Test supplied URL/key against `/server/about` |

For both execution POST routes, **omitted `dryRun` defaults to true**. Only literal JSON `false` opts into live execution; strings, nulls and other non-boolean modes return HTTP 400.

`ExecutionResult` adds `outcome` (`dry-run`, `succeeded`, `failed`, `needs-verification`), `failureStage` (preflight, album-transfer, album-verification, resolution, verification), and `proposedAlbumIds`. `executed` is true only on fully verified success. Other booleans represent positive evidence, not inferred success. A submitted mutation followed by ambiguity yields `needs-verification`; confirmed partial transfers remain in `transferredAlbumIds`. Results and new audit entries include `runId` and `attemptId`. Batch logs and JSON/CSV exports include these details. HTTP 409 represents busy/excluded/release-conflict states, and HTTP 503 can include `partialExecution` for UI display when journal persistence fails. Historical records retain their original shape and display as legacy entries.

Example checks after starting the API:

```bash
curl http://localhost:3001/health
curl http://localhost:3001/immich/test
curl 'http://localhost:3001/execution/plan?scanLimit=10'
curl -X POST http://localhost:3001/execution/run \
  -H 'Content-Type: application/json' \
  -d '{"scanLimit":10,"executeLimit":1,"dryRun":true}'
```

## Frontend behavior and unfinished settings

The shell uses React state for navigation, with no router, URL routes, or persistent settings store. Switching screens unmounts them. Dedupe keeps module-level status/plan/analysis caches across navigation, but these are not keyed by scan limit. Changing a limit needs Refresh to update the preview; execution always sends the current inputs and the server recalculates decisions rather than executing an immutable preview. Local limits reset on remount. Run state and in-flight requests belong to the shell and survive navigation; Dedupe reads the latest scoped journal run when opened and offers an explicit Refresh latest action.

Each refresh concurrently requests status, plan, and analysis. Each backend route independently repeats the duplicate/enrichment workflow, including album indexing. Cached file sizes can still trigger duplicate fetches when concurrent requests race on an initially empty cache.

Logs includes a paginated Execution Recovery panel with evidence, recheck, and confirmed release actions. Unavailable storage/identity and active-run states are explicit, and HTTP error partial results remain visible. The display-log table shows the newest 20 entries, with exports covering the full log. History is a static placeholder. The app uses plain CSS; at widths below 900 px, navigation becomes a horizontal scrolling bar.

Settings implementation details:

- Test and save tests the supplied connection and writes configuration. Restart the API to apply it and reload to refresh header status. This test does not verify identity/cleanup permissions.
- Confirm before live execution is the only safety preference, held in shell memory and reset on reload. Backend safety requirements are fixed explanatory text, not editable switches.
- Performance and cache configuration is explicitly not implemented. No editable performance fields or fictional disk cache directory are shown.
- Reset preview cache clears browser scan previews only; backend sizes, logs and recovery records remain.
- Clear form clears only the current form; saved and active credentials remain.
- Diagnostics includes the current form URL, key-configured flag, connection test status/version and session confirmation preference. No key or unimplemented performance preferences are exported.

## Latest-run read model and outcome explanations

`GET /execution/runs/latest` returns `{ ok, scope, run }`, with null run when no journal run exists for the current normalized API URL/account. `GET /execution/runs/:runId` returns the same compact shape or 404 for unknown/other-scope IDs (400 for invalid UUIDs). Identity/storage failure returns 503. Reads neither migrate legacy logs nor write files or call Immich mutations. They can run during execution. No history-list endpoint is added.

New version-2 records retain immutable request context (dry-run, scan/attempt limits, batch/single source and selected group) and a terminal report with scanned/eligible counts, exclusion reasons, stop reason and request error. Version-1 records are read unchanged; missing context/report remains null. A completed run has a report even when scanning or the display-log append failed. Checkpoint-write failures retain prior durable evidence and return partial results; they do not fabricate completion. Older application versions cannot read version 2: do not downgrade against the same data directory.

Shared `RunView`/`RunViewResponse` contracts expose timestamps, request/report metadata and compact attempts (terminal result, last stage, confirmed albums, latest assessment and quarantine/release status). They omit checkpoint snapshots, which stay in recovery detail. Phase is running for the active coordinator, finished for recorded completion, and interrupted otherwise. A finished run may contain failed or uncertain attempts; it is not a claim that cleanup succeeded.

Dedupe summarizes verified completed, simulated, failed, needs verification and awaiting-result attempts, plus processed/legacy/quarantined exclusions. Technical IDs, proposed/confirmed albums and failure stages are expandable. Review recovery opens the exact attempt independently of list pagination, focuses the evidence, supports already-closed attempts and offers Back to results. Subsequent assessments do not rewrite historical outcomes.

The shell retains pending requests/results through navigation. Latest is scoped to the server account, includes other-tab requests and is restored when Dedupe opens after reload; Welcome stays the default page. Refresh latest performs a read with no automatic polling, retries or cleanup. Stale responses cannot replace a newer request. Pending work, rejected requests, lost responses (unknown, possibly still running), and preview-refresh errors are separate. Returned partial-response evidence is retained separately from journal reads during the browser session: unsaved facts cannot be restored after reload. A changed verified scope clears old partial evidence.

## Current Functionality and remaining limitations

The Welcome page includes a static **Current Functionality** card directly after **How it works**, with Available now, Automatic cleanup requirements, and Current limitations lists. Keep it, the README’s matching section, and this guide aligned in every PR that changes user-visible behavior or operational guarantees. Only describe implemented functionality; remove obsolete limitations as they are resolved.

Automatic cleanup is limited to exactly two unlinked images: keep a larger external image over an internal copy with matching filenames and dimensions. Favorites, archived/offline, edited/trashed, videos and unknown required safety data are excluded. Users can preview, simulate, execute eligible batches, inspect outcomes, and view/export batch logs. Manual review remains read-only; thumbnails, configurable rules, manual keeper selection, and the dedicated History view are not implemented. Scanning still examines the first N groups rather than providing resumable full-library scans.

Remaining operational limits:

- Album preservation covers memberships visible to the configured account. Separate API calls are not transactional; external changes can occur between checks and partial changes can remain after failures.
- Execution/recovery locking covers one API process only. Durable quarantine and manual recheck/release are implemented; multi-process locking, automatic retry/resumption, rollback, and restoration are not.
- Single-group and batch executions now share logging and exclusions. Display logs can be cleared independently of recovery evidence. JSON journal storage is not a multi-process database.
- Preview caches remain app-scoped and without expiry. Execution uses fresh data, but previews can become stale. Path classification is still hardcoded.
- The local API is unauthenticated, permits cross-origin requests, does not explicitly bind only to loopback, and returns the saved key through connection settings. Keep it within a trusted local environment.
- Connection saving checks truthiness, writes unquoted `.env` values, and requires an API restart. Clear form clears the form only. Performance configuration remains unimplemented and is explained in static text.

## Build, validation, and maintenance

Run these checks from the repository root:

```bash
pnpm test
pnpm test:ui
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm test` runs `apps/api/tests/*.test.ts` with Node’s built-in runner and the existing API-local `tsx` loader. Coverage includes rules, execution ordering and guards, batch attempts and history, isolated log storage, and representative HTTP/settings/export paths. HTTP tests use an ephemeral loopback server and fake Immich/fetch/settings dependencies; no real credentials are needed. The previous TODO safety cases are now executable regression tests. PR 3 adds interruption/restart checks at every checkpoint boundary, injected write/flush failures, legacy migration, scope isolation, quarantine/release, and client-disconnect coverage using temporary state. Tests cover protected/unknown metadata, stale selections, fresh albums, malformed/unsuccessful responses, partial results, bounded verification, safe defaults and batch stopping.

`pnpm build` compiles the frontend into `apps/web/dist` and the API into `apps/api/dist`. Build success does not establish a production runtime: there is no API `start` script or frontend static serving in Express, and the shared packages expose `.ts` source. Plain `node apps/api/dist/index.js` deployment was not validated. `pnpm --filter web preview` previews the built frontend only and still needs the API.

`pnpm lint` runs frontend ESLint only; backend lint remains unconfigured. The existing Hooks/Fast Refresh findings have been fixed without disabling lint rules. Root `typecheck` now covers all workspace packages, the web app, and API tests. API build excludes tests; `tsconfig.check.json` includes them for typechecking. Standalone package build scripts remain placeholders. The web app has separate compiler configuration and does not inherit the root strict setting.

PR 2 deliberately changes execution defaults and eligibility: omitted modes simulate, non-images/protected/unknown assets cannot auto-resolve, and failed/uncertain attempts stop batches. Tests do not contact a live Immich server or prove compatibility with a particular server deployment. A browser-based interaction smoke test still needs to be performed in an environment with a browser.

For future edits, start with the relevant source files in the map above. Keep rule evaluation deterministic, preserve album-transfer-before-resolution ordering, explicitly use `dryRun: true` for execution verification, and inspect per-group outcomes. Update this guide when paths, API contracts, settings behavior, or execution guarantees change.

Browser tests in `apps/web/tests` use Playwright Chromium, a dedicated Vite server, and intercepted fake backend responses. Install prerequisites with `pnpm --filter web exec playwright install --with-deps chromium`; run `pnpm test:ui`. They never require a real API or Immich server. Keep reload/navigation, HTTP 409/503, unknown/partial outcomes, recovery links/confirmation, keyboard details and narrow-layout coverage when modifying outcome UI.
