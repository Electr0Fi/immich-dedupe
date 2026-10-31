# Immich Dedupe: repository and operations guide

Reviewed on 2026-10-31. This is a working reference for future development sessions, based on the repository's application code, package scripts, configuration, and existing documentation. Recheck the source when changing behavior; this file describes the reviewed snapshot.

## Purpose and current state

Immich Dedupe is a local web application for resolving duplicate groups already identified by an Immich server. It does not scan image files itself or calculate visual similarity. Published comparison rules select a keeper using directory or metadata preferences while preserving album membership before resolving the other copy.

The backend, deterministic rules, batch executor, React dashboard, plan preview, and execution logs are implemented. Manual review currently means displaying uncertain/skipped decisions, with no manual choice or resolution controls. History is a placeholder. Configurable rules, continued scanning and persistent pending proposals are implemented. No database, CI workflow, container setup or packaged deployment is configured.

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
| `packages/rule-engine/src/index.ts`, `configurable.ts` | Pure configured evaluator and frozen historical rules |
| `apps/api/src/rulesStore.ts`, `scanStore.ts` | Scoped immutable rules revisions and advisory scan/pending state |
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

## Immich API key permissions

Settings → Immich Connection includes a static Required API key permissions table. The complete setup and troubleshooting instructions are in [README: Required Immich API key permissions](README.md#required-immich-api-key-permissions). Verified against the official Immich v2.7.5 controllers, matching the installed SDK:

| Scope | App operation |
| --- | --- |
| `server.about` | Settings Test and save and header status use `GET /server/about`; ping alone is public and does not verify credentials/scopes. |
| `user.read` | `GET /users/me` scopes reviews, execution (including dry-runs), saved-run reads, recovery and log clearing. |
| `duplicate.read` | `GET /duplicates` supplies previews and fresh group membership. |
| `asset.read` | `GET /assets/:id` supplies metadata/sizes and verification evidence. |
| `asset.view` | Backend-proxied review thumbnails use `GET /assets/:id/thumbnail?size=thumbnail`. |
| `album.read` | Album listings/details support previews, fresh memberships and preservation verification. |
| `albumAsset.create` | Live execution adds the keeper to missing loser albums using `PUT /albums/assets`. |
| `duplicate.delete` | Live execution uses `POST /duplicates/resolve` to resolve the selected pair and trash the loser. |

The first six scopes support read/review/dry-run workflows; the final two enable live operations. Do not recommend `all`. These are endpoint key permissions, distinct from the account-level asset sharing/deletion and album edit rights enforced by Immich's services. Additional API scopes cannot grant access to another user's assets or read-only shared albums. The permission set cannot compensate for a server missing the required endpoints.

`asset.read` does not authorize thumbnail bytes: enable `asset.view`. Thumbnail-size requests do not require `asset.download`. If the same key's permissions are edited in Immich, prepare a new review to reset failed image placeholders; no backend restart is needed solely for that permission edit. Replacing the saved key still requires an API restart. The placeholder also covers absent/generated-media failures, expired plans, network/proxy failures and unsupported response types; do not diagnose every placeholder as a missing scope. Check that Immich can display the images and has generated thumbnails. Connection tests only establish server.about access, not the full permission set. No live mutations are needed to validate documentation or settings help.

## Data flow

```text
React dashboard -> Express API -> Immich SDK / Immich server
                                  |
                       fetch existing duplicate groups
                                  |
                reconcile scan queue / legacy first-N window
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

Normalization preserves IDs, filenames, paths, timestamps, dimensions, checksums, source flags, edited/trashed flags, and initializes empty album memberships and null file sizes. Dimensions fall back to EXIF values. Missing safety flags remain null (unknown), never false. Records include media type, favorite/archive/offline flags, and Live Photo linkage; the rule engine requires complete negative safety flags and unlinked images. Configured rules can compare checksums, timestamps and selected EXIF metadata; rule dependencies are explicit.

Historical source labels still use the prefixes in `classifySource.ts`, rather than `libraryId`. Active configured rules do not require an external/internal pair: keeper preferences match user-configured directory paths, case-sensitively and at directory boundaries. Default directory priorities are seeded from the previous prefixes. Same-source pairs are supported; unmatched preferences and ties may exclude a pair. Check Rules rather than editing source classification to configure eligibility.

File sizes come from `getAssetInfo().exifInfo.fileSizeInByte`, accepting finite numbers or numeric strings. An app-scoped map caches sizes, including null values, with no expiry. Preview asset/group enrichment uses `Promise.all` without a concurrency limit. Execution bypasses cached sizes and reads both selected assets afresh. Album enrichment processes assets sequentially. For each asset it requests default and shared memberships through paired `getAllAlbums({ assetId })` calls, settles both reads, validates returned IDs/names with Zod and rejects conflicting names. It sets `albumsKnown: true` only after complete successful reads; unknown memberships are not treated as empty. An enrichment failure aborts that request without leaving started reads unsettled.

## Decision rules

The pure evaluator in `packages/rule-engine` separates mandatory guards, ordered user rules and keeper preferences. Configuration is a validated version-1 declarative schema, with bounded AND/OR expressions and no executable scripts. Only exactly two distinct, unlinked images with explicit false edited/trashed/favorite/archive/offline flags can qualify. Existing safety protections cannot be disabled in the rule builder.

**Rules** provides draft save, publish, preset cloning, ordering, conditions and keeper preferences. Each numbered rule heading has an Enabled slide toggle immediately beside it; the left-aligned Name field is 320 px wide and adapts to smaller screens. Supported fields include checksum, filename/stem/extension, path, MIME, file size, width/height, pixel count/aspect ratio, dates, device/library IDs, selected EXIF fields and album IDs/names. Operators are validated for each field type. Missing required values yield deferred decisions, including for negative comparisons; an indeterminate earlier rule does not fall through into a permissive inclusion.

| Preset | Default and behavior |
| --- | --- |
| Identical files | Enabled; requires valid matching stored Immich checksums and consistent available size/dimensions, then applies directory keeper preferences. It does not download originals. |
| Matching name and dimensions | Disabled; requires explicit heuristic acknowledgement, matching normalized names/dimensions and larger preferred copy. |
| Resolution variants | Disabled; requires explicit heuristic acknowledgement, matching normalized names/aspect ratios and differing pixel counts; prefers higher resolution. |

A metadata match can include genuinely different images; filenames are useful filters but do not prove content identity. Reviews distinguish checksum and metadata evidence rather than presenting confidence as a probability. AI/perceptual similarity alone never qualifies. Original-byte downloads, decoded-pixel verification, video execution, linked Live Photos and groups larger than two remain unsupported.

The Rules UI groups each rule into **1. Select candidate groups** (Candidate decision, comparison evidence, acknowledgement and conditions) and **2. Define group resolution** (keeper preferences and the fixed album-add/verification/resolve/outcome-verification sequence). Rule number, Enabled toggle and Name remain above both sections. The workflow overview distinguishes editing/publishing from review, dry-run and explicit execution on Dedupe. Exclusion rules hide resolution controls but preserve their values, including for existing keeper/loser-targeted conditions. This presentation does not change the schema, evaluation order, presets or execution guarantees.

Keeper preferences support ranked directories, file size, pixel count and dates. The keeper need not have an external label and same-source pairs are allowed. A tie excludes the group. Unknown keeper metadata defers it. Rule outcomes include revision, matched rule, evidence class, required/missing fields, observed values and dependency fingerprint.

Saved presets store whole `RuleSetDraft` configurations (all rules, order and contents) in each scoped rules-store entry. Selecting one replaces the editor immediately; saving/deleting presets never publishes or changes the saved draft. New preset names create a copy, while matching names (trimmed, case-insensitive) require overwrite confirmation. Deletes require confirmation and keep current editor contents. The API requires the current preset ID/revision for overwrite or deletion and returns 409 for stale targets; Refresh presets reloads the catalog without discarding edits. Frontend rules responses must contain a `savedPresets` array before replacing current state. Missing/null/non-array catalogs show current-API restart/routing guidance, preserve editor/catalog state and allow explicit retry; they are never treated as empty presets. Existing rules files without `savedPresets` gain initial presets lazily on read, without a file rewrite or active-rule changes. An explicitly empty preset list stays empty across restarts.

Rules are scoped to normalized Immich URL/account. Draft edits do not change active decisions. Publication under the coordinator lock activates an immutable canonical revision and invalidates old Quick/full review and dry-run authorization. Draft tests cover every fully observed group in a prepared snapshot, including excluded groups. They are read-only, make no additional Immich requests, cannot authorize execution and cannot add metadata that the snapshot did not contain. Album data in Quick Review remains unknown.

The original `evaluateDuplicateGroup` remains frozen for historical validation: it required matching names/dimensions, an external/internal pair and a strictly larger external keeper; missing sizes gave uncertain/40, differing dimensions skip/0, and other unsupported data uncertain/10. Production routes use the configured evaluator. The old heuristic is not automatically activated during migration: new scoped configuration starts with the checksum preset and disabled metadata presets.

## Continued scanning and advisory persistence

Immich v2.7.5 `GET /duplicates` returns the complete available duplicate list without page/offset parameters or guaranteed group ordering. `scanLimit` is a local inspection budget, not upstream pagination. Preparation requests with no `scan` field retain the existing first-N local window; the WebUI opts into continued scanning.

Both full and Quick preparation accept `scan: { mode: "groups" }`, or `scan: { mode: "candidates", candidateTarget: N }`. Groups mode checks up to Scan Limit additional queued groups; candidate mode stops at the requested number of new candidates, the inspection budget, snapshot exhaustion or cancellation. Quick targets count provisional candidates; full targets count fully checked candidates. Execute Limit remains separate. Terminal scan metadata includes checked/found counts and the stop reason.

Each preparation/continuation fetches one complete duplicate-list snapshot, normalizes metadata and reconciles the persistent local queue by group identity, membership and observed-field fingerprint. Response reorder and resolved-group disappearance do not reset unseen progress. Existing unseen work stays ahead of new/changed groups. Rules publication invalidates rule classifications. An unchanged exclusion is reusable only if every relevant dependency was available in fresh list data; enriched-only and album-dependent outcomes cannot be trusted from IDs alone. Missing metadata and transient reads are not permanent exclusions. Recheck excluded groups explicitly queues excluded/deferred outcomes again.

Production startup injects lazy JSON stores at `apps/api/data/rules.json` and `apps/api/data/scan-progress.json`. Rule revisions and scan proposals contain no API keys and are separate from execution journal authority. Advisory observations are flushed atomically every 25 completed groups and before a terminal/cancelled response. An API crash may lose recent unflushed read progress. Rules/scan persistence never restores approval, authorizes execution, clears quarantine or reports a successful operation.

Unresolved eligible proposals remain in a pending list across restarts. They contain selected IDs, filenames/paths, comparison explanation and rules revision, not executable approval. Load selected pending details rechecks identity, current rules, authoritative exclusions, membership, assets and albums, then creates a fresh full plan requiring its own exact-selection dry-run. Changed rules or a changed selection rejects the request. A dry-run leaves proposals pending; journal-success/quarantine evidence overrides them. Reset scan progress clears advisory state only. Corrupt advisory files are preserved and reported rather than silently replaced; execution recovery files must never be reset to repair scanning.

## Execution semantics and persistence

`scanLimit` chooses the first N groups for legacy batch requests and acts as an inspection budget for opted-in continued review scans; it is not upstream pagination. `executeLimit` caps attempted eligible groups, including failed attempts and dry-run results. Batch defaults are scan 100 / execute 10; UI defaults are scan 100 / execute 5. Legacy request field `limit` supplies both defaults when provided. Both execution POST bodies are validated with Zod. Supplied limits must be positive safe integers; strings, nulls, zero, negative and fractional limits return HTTP 400. Explicit limits independently override the legacy fallback. Read-only query endpoints retain their existing permissive limit parser.

Both execution routes use one coordinator, with UUID run/attempt IDs and the same logging/exclusion policy. A lock is acquired before scanning/enrichment and retained until work finishes, even after client disconnect. Other execution requests (including dry-runs), rechecks, releases, and log clears return HTTP 409 while busy. The lock is per API process; multiple instances sharing storage are unsupported.

The executor requires exactly two distinct supported images, an eligible active-rule decision (compatibility status `auto-resolve`, confidence 100), one trash ID and both selected assets present. It validates the configured keeper selection and mandatory protections; same-source pairs are allowed. Batch execution reports exclusions from authoritative journal successes, verified-resolved assessments, legacy exclusions, and quarantines. Quarantine matches group IDs or either selected asset ID; unrelated groups remain usable. Single-group requests for excluded groups return HTTP 409. Decisions are matched by group ID.

Dry-run is the default for both execution routes and internal executors. It rechecks group/asset eligibility and current albums but does not mutate Immich. `proposedAlbumIds` reports proposed transfers; `transferredAlbumIds` stays empty. Batch dry-runs still append local audit entries.

Before either dry-run or live execution, the executor refetches duplicate membership and both selected assets, requires the same two IDs and group associations, reads uncached sizes, and re-evaluates the same keeper/loser selection. Asset-filtered default and shared-album queries provide current visible memberships. Missing or malformed required data fails preflight.

Live execution adds the kept asset to missing loser albums once, requires `success === true`, and rereads affected album details to confirm membership. Existing overlapping keeper memberships are checked too. Only then does it call SDK `resolveDuplicates` (Immich `POST /duplicates/resolve`) once. A nonempty response with successful items and no reported error is required. The loser must be confirmed `isTrashed === true` with `duplicateId === null`, and the keeper must be confirmed untrashed. Verification has at most three rounds, one second apart. Exceptions, 404s and missing fields are never success. Mutations are not retried. Preserve this operation ordering. Do not replace duplicate resolution with Immich `DELETE /duplicates/:id`, which is not the intended asset-cleanup operation.

Batch work is sequential with a fixed 50 ms delay after successful or dry-run attempts. The first failed/uncertain attempt stops processing and returns `stoppedEarly: true` with `stopReason`. Failed attempts still count toward `executeLimit`. An audit-write failure also stops further work while retaining returned results. Once journaled, verified success stays authoritative even if the display log fails. Successful live entries require `mode === "execute"` and all of `executed`, `resolvedDuplicate`, and `trashedAsset` true to enter processed tracking.

The active log is **`apps/api/data/execution-log.json`**, selected in startup relative to `src` or `dist` through `__dirname`. It is ignored by Git. Tracked `execution-log.json` files at the repository root and `apps/api/` are not read by the current logger; the older `src/execution-log.json` location is no longer used. Tests inject a temporary log path. Display-log writes remain synchronous and rewrite the file. Missing files read as empty, but malformed/unreadable logs now raise an error without replacement. They are not the recovery authority.

Clearing display logs preserves journal records, completed-history exclusions, quarantines, and legacy exclusions. It does not undo Immich operations. Single-group execution now shares logging and exclusion checks with batch execution. Read-only plan/status counts still describe rule eligibility, while execution returns `excludedGroups` explaining processed/legacy/quarantined candidates.

## Durable recovery evidence

`apps/api/data/execution-journal/` holds one versioned JSON file per run (version 4 for configurable reviewed runs, version 2 for legacy API runs; versions 1–3 remain readable unchanged) and a separate `legacy-exclusions.json`. The store loads lazily so app construction stays side-effect free. Records validate IDs, checkpoint order, album requirements, outcomes and scope. Interrupted temporary files are retained but never promoted. Writes flush a same-directory temporary file, rename it atomically, then flush the directory; directory fsync is required (validated on Linux). Filesystem operations are injectable for fault tests.

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
| GET | `/analysis/duplicates?limit=10` | Active-rule decisions and counts |
| GET | `/rules` | Current scoped active rules, draft, individual rule templates (`presets`) and whole-rule-set `savedPresets` |
| POST | `/rules/presets` | Save `{ name, ruleset }`; overwrites also require `overwriteId` and `expectedRevision` |
| DELETE | `/rules/presets/:presetId` | Delete a preset using `{ expectedRevision }`, without changing active rules or draft |
| PUT | `/rules/draft` | Save validated `{ ruleset }` without activation |
| POST | `/rules/publish` | Activate immutable `{ ruleset }`; old reviews become stale |
| POST | `/rules/test` | Test `{ ruleset, snapshotId }` against all completed observed snapshot groups, read-only |
| GET | `/execution/scan/pending` | Scoped advisory pending proposals and scan summary |
| POST | `/execution/scan/prepare-pending` | Fresh full plan from `{ selectedGroupIds, executeLimit }` |
| POST | `/execution/scan/recheck-excluded` | Queue advisory exclusions for fresh checking |
| POST | `/execution/scan/reset` | Reset scoped advisory progress, preserving recovery |
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

The shell uses React state for navigation, with no router, URL routes, or persistent settings store. Switching screens unmounts them. Dedupe keeps module-level status/plan/analysis caches across navigation, but these are not keyed by scan limit. Changing a limit needs Refresh to update the preview; the WebUI now prepares a fresh immutable review and submits only that plan and its selected IDs. Limits, review and selection live in shell memory across navigation, without persistence after reload. Run state and in-flight requests belong to the shell and survive navigation; Dedupe reads the latest scoped journal run when opened and offers an explicit Refresh latest action.

Each refresh concurrently requests status, plan, and analysis. Each backend route independently repeats the duplicate/enrichment workflow, including per-asset default/shared album membership reads. Cached file sizes can still trigger duplicate fetches when concurrent requests race on an initially empty cache.

Controls includes an explicit Refresh previews action to recover from a failed preview request without rebuilding the review, changing its selection/approval or rerunning execution. GET transport failures explain that the Dedupe API must be running and accessible from the browser; HTTP errors retain their status and server message. Preview errors clear on a successful refresh, and execution results remain visible. There are no automatic retries; a lost execution response still has an unknown outcome. With the default `http://localhost:3001` API URL, a remote browser must instead be configured with a backend URL it can reach; an HTTPS frontend also requires a browser-accessible HTTPS API.

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

Version-2 legacy records retain immutable request context (dry-run, scan/attempt limits, batch/single source and selected group) and a terminal report with scanned/eligible counts, exclusion reasons, stop reason and request error. Version-1 records are read unchanged; missing context/report remains null. A completed run has a report even when scanning or the display-log append failed. Checkpoint-write failures retain prior durable evidence and return partial results; they do not fabricate completion. Historical reviewed runs use version 3. Configurable reviewed runs use version 4, retaining the immutable ruleset and decision evidence alongside the authorizing dry-run ID. Versions 1–3 retain their original validation semantics and remain readable unchanged. Older application versions cannot read newer journal versions: do not downgrade against the same data directory.

Shared `RunView`/`RunViewResponse` contracts expose timestamps, request/report metadata and compact attempts (terminal result, last stage, confirmed albums, latest assessment and quarantine/release status). They omit checkpoint snapshots, which stay in recovery detail. Phase is running for the active coordinator, finished for recorded completion, and interrupted otherwise. A finished run may contain failed or uncertain attempts; it is not a claim that cleanup succeeded.

Dedupe summarizes verified completed, simulated, failed, needs verification and awaiting-result attempts, plus processed/legacy/quarantined exclusions. Each summary tile has an information icon with a definition on hover, focus or tap; Escape dismisses it. Technical IDs, proposed/confirmed albums and failure stages are expandable. Review recovery opens the exact attempt independently of list pagination, focuses the evidence, supports already-closed attempts and offers Back to results. Subsequent assessments do not rewrite historical outcomes.

Dedupe controls show a spinner and accessible status message while dry-run/live requests are pending, with a matching label on the active button. Preview refresh and latest-run loading have separate activity messages. For dry-run/live execution the indicator reflects a pending request, not streamed per-group progress; it clears on completion or error and respects reduced-motion preferences.

The shell retains pending requests/results through navigation. Latest is scoped to the server account, includes other-tab requests and is restored when Dedupe opens after reload; Welcome stays the default page. Refresh latest performs a read with no automatic polling, retries or cleanup. Stale responses cannot replace a newer request. Pending work, rejected requests, lost responses (unknown, possibly still running), and preview-refresh errors are separate. Returned partial-response evidence is retained separately from journal reads during the browser session: unsaved facts cannot be restored after reload. A changed verified scope clears old partial evidence.

## Current Functionality and remaining limitations

The Welcome page includes a static **Current Functionality** card directly after **How it works**, with Available now, Automatic cleanup requirements, and Current limitations lists. Keep it, the README’s matching section, and this guide aligned in every PR that changes user-visible behavior or operational guarantees. Only describe implemented functionality; remove obsolete limitations as they are resolved.

Automatic cleanup is limited to exactly two unlinked images satisfying published rules and directory/metadata keeper preferences. Checksum matching is the default; metadata heuristic presets require explicit activation and acknowledgement. Favorites, archived/offline, edited/trashed, videos and unknown required safety data are excluded. Users can configure rules, continue fixed-budget or candidate-target scans, load persistent pending proposals into fresh reviews, simulate, execute eligible batches and view/export logs. Manual keeper selection and the dedicated History view remain unavailable. Immich still returns its complete duplicate list, without upstream pagination.

Remaining operational limits:

- Album preservation covers memberships visible to the configured account. Separate API calls are not transactional; external changes can occur between checks and partial changes can remain after failures.
- Execution/recovery locking covers one API process only. Durable quarantine and manual recheck/release are implemented; multi-process locking, automatic retry/resumption, rollback, and restoration are not.
- Single-group and batch executions now share logging and exclusions. Display logs can be cleared independently of recovery evidence. JSON journal storage is not a multi-process database.
- Legacy preview caches remain app-scoped and without expiry. Execution uses fresh data, but previews can become stale. Historical source labels remain hardcoded; active keeper preferences are editable in Rules.
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

## Reviewed batch workflow (PR5 foundation and PR6 UI)

The WebUI now uses Prepare review, Dry-run selected, and Execute selected. Backend plan preparation uses the coordinator lock, identity check, legacy migration, authoritative exclusions, and shared uncached fresh preflight reads. It never mutates Immich. Plan responses include immutable keeper/loser metadata, safety fields, available checksums, rule explanation, current album memberships and named proposed actions. Unsafe groups remain unselectable with reasons.

Plans are UUID-addressed, scoped to normalized URL/account, expire after 15 minutes and live in API memory (capacity 20, expired-first cleanup then oldest eviction). The injectable clock supports expiry tests. Each live request consumes its plan; accepted work is not interrupted by expiry. UI limits and selection survive navigation; rebuilding, limit changes, expiry and connection changes clear approval. Reload/restart require a new review. Deselecting does not backfill another group, and selection cannot exceed the current plan’s attempt limit. Select first N uses that effective Execute Limit. Select All includes every eligible candidate already checked in the review and explicitly raises the limit when needed, as described below. Manual keeper selection remains unavailable.

POST /execution/plans accepts positive-safe-integer scanLimit/executeLimit (defaults 100/10) and optional continued-scan configuration. POST /execution/plans/:planId/run accepts unique eligible selectedGroupIds and a boolean dryRun (default true). Ordering is normalized to plan order. A successful, fully journaled, non-stopped dry-run authorizes only that exact selection. All selected groups receive whole-batch fresh validation before mutations, and fresh per-group validation is repeated before each operation. Reviewed fields, safety metadata, checksums and album memberships/names/actions cannot change silently. Whole-batch rejection is HTTP 409 with changed groups/reasons and no mutations; later failures preserve earlier results and stop further work. No mutation retries or replacement candidates are permitted. Invalid inputs return 400, expired/missing/consumed plans 410, and unavailable identity/journal/upstream reads 503. Existing partial-result and recovery behavior applies.

Journal v4 records preserve the immutable configured ruleset, plan ID/timestamps, selected candidates/order and authorizing dry-run ID. The store verifies referenced dry-run evidence, scope, successful completion and matching review metadata. Historical v1–v3 readers retain their original validation semantics; legacy API runs still write v2. Run views include optional planId/selectedCount/authorizingDryRunId. Older releases cannot read v4 files; never downgrade against this directory or reset evidence.

GET /execution/plans/:planId/assets/:assetId/thumbnail verifies current identity, plan lifetime and reviewed asset membership before SDK viewAsset at thumbnail size. Supported raster images are returned with no-store and nosniff; upstream failures are redacted and unsupported content rejected. Thumbnails are lazy-loaded and failures show accessible placeholders without changing eligibility. The proxy accepts no upstream URL, key, original-media or shared-link parameters.

The UI uses the planned endpoint exclusively. Legacy POST /execution/run and single-group execution remain available, including explicit live requests without reviewed-plan authorization, but enforce active configured rules and fresh guards. Do not claim universal reviewed execution. Separate API operations still are not transactional and external races remain possible.

## Review preparation progress and cancellation

`POST /execution/plans` retains its ordinary JSON response and additionally supports `Accept: application/x-ndjson`. The stream emits `progress` events (opaque preparation ID, actual stage, checked count, scan-window target once known, eligible/excluded counts), then a terminal `result` with completed/cancelled status and a plan, or an `error` with sanitized message, code and equivalent HTTP status. HTTP errors before streaming retain JSON error responses. Streamed errors after headers use terminal error events. Responses use no-store and disable proxy buffering where supported. Slow readers may miss intermediate progress updates, but not the terminal result.

`POST /execution/preparations/:preparationId/cancel` sets an in-memory flag without taking the coordinator lock or making Immich calls. It returns cancelling while active, finished after completion, 400 for invalid UUIDs and 404 for unknown/expired IDs. Finished preparation IDs are retained for up to 15 minutes, capacity 20 with oldest eviction. Cancellation is cooperative between read batches. Outstanding asset/album reads settle before the lock is released, including errors; unfinished groups are discarded. Actual upstream/storage/identity failures remain errors. A disconnected observer does not cancel preparation.

Cancelled preparations store a normal immutable, scoped partial plan from fully checked candidates and exclusions. Optional plan `preparation` metadata records status, checkedGroups and targetGroups; fetchedGroups counts completed checks and totalGroups is the library total. If cancellation precedes scope/group information, no plan is returned. Partial reviews use the existing 15-minute expiry/capacity, thumbnail access, exact-selection journaled dry-run authorization and fresh execution checks. Journal formats and mutation safeguards are unchanged.

The shell keeps streamed progress, start time and cancellation state across navigation. Prepare review becomes Cancel review immediately; early cancellation clicks wait locally for the preparation ID, then show Cancelling until the terminal result arrives. Cancellation errors allow another explicit cancellation without discarding progress. Successful cancellation shows a neutral summary and the usable partial review. If completion wins the race, the full review is retained. The UI shows elapsed time outside live announcements, a labeled count-based progress bar when the target is known, and an explanatory waiting message after 30 seconds without progress. It gives no completion-time estimate. A malformed/truncated/lost stream never installs an unconfirmed partial review or automatically retries. Preparation state is not restored after reload/restart.

## Reviewed selection controls

Select first N is tied to the prepared plan's effective executeLimit, synchronized with Controls. Select All selects every eligible candidate in that review (including fully checked candidates in cancelled partial reviews); excluded or unscanned groups are never added. When all candidates fit, selection changes locally and clears dry-run approval. If they exceed the limit, the shell calls `POST /execution/plans/:planId/select-all` with an empty object. It keeps the existing selection visible, disables conflicting actions and retains pending state through navigation. Failure preserves the original review/selection, reports the error and permits explicit retry when the plan remains valid. No automatic retry or re-preparation occurs.

The endpoint shares the coordinator lock, journal availability and verified identity checks. It rejects invalid IDs/bodies (400), busy/scope conflicts (409), missing/expired/consumed plans (410), and unavailable identity/storage (503). It returns `{ ok: true, plan }` with a new immutable plan ID, unchanged snapshot/exclusions/scan and partial-preparation metadata, executeLimit raised to at least the candidate count, and the original createdAt/expiresAt timestamps (preserving the exact 15-minute plan lifetime invariant). It does not refetch/reclassify candidates, extend the review deadline or carry dry-run authorization. The original plan is unchanged, subject to existing expiry/eviction rules. No Immich mutation occurs.

The UI updates its review and Execute Limit together, selects all returned candidates and requires a new exact-selection dry-run. The run route, journal context validation, whole-batch fresh checks and per-group checks continue to enforce the new plan's limit and selection. Stored run/journal formats are unchanged. Manual limit edits still invalidate the review; Select All uses the explicit derived-plan flow instead.

Prepared review disclosure controls: every candidate and excluded group has a keyboard-operable button with aria-expanded and aria-controls linked to a hidden details panel. Candidate selection stays visible outside the panel. All panels default to collapsed. Expand All and Collapse All affect both candidates and exclusions without changing selection, limits, authorization or backend state; empty reviews disable these controls. Expansion is local to the mounted review screen, keyed by plan ID, so a different plan or screen remount starts collapsed. Asset ID/path disclosures remain independent within each panel. Existing metadata and thumbnail browser tests explicitly expand the group before inspecting details.

Missing-route diagnostics: frontend response decoding distinguishes generic/non-JSON 404s from structured API errors. A missing route reports its HTTP method/path and recommends restarting the current API checkout, reloading/preparing a new review, and checking VITE_API_BASE_URL/proxy routing. It never shows raw HTML or the configured upstream URL/credentials. Structured 404/410 responses preserve their domain messages; partial execution evidence, run IDs, codes and changed-group reasons remain intact. No fallback execution, automatic retry or approval bypass is added. For Select All failures, the existing review/selection remains visible. `/health` liveness alone does not demonstrate route availability. Restart only an idle API and preserve all recovery/display-log files; in-memory plans are lost on restart.

Fresh preflight membership diagnostics distinguish absent group IDs, repeated entries for the group, unsupported asset counts, repeated asset IDs and missing selected keeper/loser IDs. Count exclusions include the observed count, e.g. “3 assets in group; current rule definitions only support exactly 2 assets per group.” These remain PreflightSafetyError failures: preparation records an ineligible exclusion, reviewed validation rejects changed candidates before mutation, and execution fails at preflight. No checks were relaxed; static unsupported sizes no longer claim membership changed. Outcome tests verify both specific explanations and mutation prevention.

## Quick Review workflow

The unchecked Quick Review option below Prepare review is shell-owned for the current browser session. It routes preparation to POST /execution/quick-reviews using the existing positive-safe-integer scan/execute limits, instead of the full-plan endpoint. Both paths share the coordinator lock, identity lookup, journal initialization/migration and scoped exclusions. Quick preparation fetches duplicates once, selects the next queued groups (or the first-N window for legacy callers), validates/normalizes rule data already in that response and uses the same active pure evaluator. Full preparation uses a single membership snapshot plus fresh asset/album reads; execution still refetches membership. There are no per-asset, album or thumbnail requests or repeated membership reads during quick scanning. Missing/invalid required data stays unverified/deferred in both full and Quick Review; complete protected/ineligible groups are excluded. Required Live Photo linkage is explicit; its absence is unverified in quick data. Checksum rules require valid checksums; metadata rules may leave optional checksums unknown. No file-size cache is read or populated.

QuickReview, QuickReviewCandidate and QuickReviewExclusion are distinct shared contracts; candidate asset data omits albums and all proposed/confirmed album-action fields. The duplicate response schema discards unrelated metadata. Numeric size strings are parsed conservatively; missing, non-finite and non-positive sizes remain unverified. Explicit negative safety flags remain mandatory; required comparison fields depend on the active rules. Album conditions defer in Quick Review rather than treating missing albums as empty. Quick snapshots use an app-local store with a separate 20-entry capacity and the normal 15-minute lifetime; they are cloned, scoped and never persisted or journaled as executable plans. Quick IDs are rejected by full execution, select-all expansion and thumbnail paths.

The JSON response is { ok, quickReview }. The opt-in NDJSON response reuses the progress/error envelope, adding the evaluating-rules stage and a terminal result with plan:null and quickReview (nullable only for early cancellation). Counts include processed exclusions and missing-data outcomes. Evaluation yields to the event loop every 25 groups so HTTP cancellation can be handled without extra network reads. The existing preparation cancellation registry/endpoint and lock-retention behavior apply; completed results survive cancellation and transport disconnects do not cancel work.

POST /execution/quick-reviews/:reviewId/prepare-plan accepts unique selectedGroupIds and an explicit positive Execute Limit. It validates scope/lifetime/selection/exclusions under the coordinator lock, then uses uncached fresh preflight for selected groups only. All started parallel reads settle before unlocking, including failure paths. The same keeper/loser and rule-relevant snapshot metadata must match; available quick checksums cannot change, while a previously missing checksum can be learned. Albums were unknown in the quick snapshot and are now loaded normally, rather than compared to fabricated empty memberships. Any selected stale group rejects the whole upgrade with 409 and per-group reasons. Upstream failures are sanitized 503 responses. Invalid requests return 400; missing/expired snapshots 410; scope/busy conflicts 409.

Successful loading returns a normal full ReviewedPlanResponse containing exactly the selected candidates, current album actions, requested execution cap and a new 15-minute lifetime. It carries no authorization. Configurable v4 journaling, successful exact-selection dry-run authorization, whole-batch and per-group fresh checks, album preservation and mutation guards remain mandatory. Quick-to-full loading rejects changed active revisions; no live cleanup bypass is added.

The UI keeps quick results compact and provisional, without image elements or invented album counts. It supports individual/bulk disclosure and local first-N/all selection (Select All raises the quick selection limit). Load selected details transitions to the full review; failures preserve quick results/selection. Pending quick/detail requests survive navigation. Mode/limit edits invalidate review and approval. While enabled, Quick Review suppresses new automatic legacy status/plan/analysis requests and post-preparation/execution refreshes; Refresh previews is disabled. Older in-flight reads may finish, but their responses are ignored and they do not block quick preparation. Quick counts replace stale detailed-preview counts, and the manual table points to quick exclusions. The option remains enabled after detail loading for subsequent preparations; switching it off invalidates the displayed review.
