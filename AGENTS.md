# Agent instructions for Immich Dedupe

Applies to the entire repository. Reviewed against source on 2026-10-31.

## Start here

Read [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for the detailed architecture, HTTP route inventory, operations workflow, and review findings. This file contains the essential instructions for working on the project. Confirm behavior against source before editing; update both documents when relevant behavior changes.

The root README and Welcome Current Functionality card describe the current release. `apps/web/README.md` is template documentation. `CLAUDE.md` contains additional conventions. Credential isolation describes intended design, not current implementation; see the known settings limitation below.

## Purpose and architecture

This local application consumes duplicate groups already identified by Immich. It does not discover duplicates by scanning files or calculating similarity. Published rules select an eligible image pair and keeper using directory/metadata preferences; album memberships are preserved before resolving the loser.

Stack: pnpm workspace, TypeScript, Express 5, `@immich/sdk` 2.7.x, Zod 4, React 19, Vite 8, plain CSS, and JSON execution logs. Regression tests use Node’s test runner and `tsx` with fake Immich dependencies. No database, CI workflow, Docker setup, or packaged production deployment is configured.

| Location | Responsibility |
| --- | --- |
| `apps/api/src/index.ts`, `app.ts` | Startup/composition root and dependency-injected Express app/routes |
| `apps/api/src/immichClient.ts`, `settingsPersistence.ts` | Typed SDK boundary and explicit-path settings writer |
| `apps/api/src/config.ts`, `immich.ts` | Environment validation and SDK initialization |
| `apps/api/src/normalizeDuplicates.ts`, `classifySource.ts` | Shared asset records and source classification |
| `apps/api/src/enrichWithAssetInfo.ts`, `enrichWithAlbums.ts` | File-size and album enrichment |
| `apps/api/src/executeDecision.ts` | Single-group guards, album transfer, resolution, verification |
| `apps/api/src/executionService.ts` | Sole production coordinator: locking, scopes, journaling, exclusions, audit, reconciliation |
| `apps/api/src/executionJournal.ts`, `atomicJson.ts` | Validated versioned run records and durable atomic writes |
| `apps/api/src/reconcileAttempt.ts` | Read-only recovery assessments |
| `apps/api/src/executePlan.ts` | Pure executable-decision predicate |
| `apps/api/src/executionLog.ts` | JSON persistence and processed-group tracking |
| `apps/web/src/main.tsx`, `App.tsx` | Browser entry point and root component |
| `apps/web/src/components/` | Application shell, navigation, header, screen selection |
| `apps/web/src/screens/` | Welcome, Dedupe, History, Logs, Settings |
| `apps/web/src/api.ts` | Frontend backend-client wrappers and response types |
| `apps/web/src/index.css`, `App.css` | Global and application styling |
| `apps/web/vite.config.ts` | React plugin only; no API proxy or explicit port |
| `packages/shared/src/types.ts` | Asset, group, decision, plan, and execution contracts |
| `packages/rule-engine/src/index.ts`, `configurable.ts` | Pure configured evaluator and frozen historical rules |
| `apps/api/src/rulesStore.ts`, `scanStore.ts` | Scoped immutable rules revisions and advisory scan/pending storage |
| `packages/immich-client/` | Unused placeholder; actual SDK calls are in `apps/api` |

`apps/web/src/index.ts` is a placeholder, not the browser entry. Workspace packages expose TypeScript source directly through their package entry points.

## Setup and commands

Use pnpm; the root package pins `pnpm@10.33.0`. Node `v24.14.1` was used successfully for the repository review; no root Node engine constraint is declared. Run these commands from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm dev                                  # API and web concurrently
pnpm --filter api dev                     # Backend only, tsx watch
pnpm --filter web dev                     # Frontend only, Vite
pnpm --filter api typecheck                # Backend and imported workspace types
pnpm --filter web typecheck               # Frontend TypeScript check
pnpm typecheck                            # All workspace packages and API test sources
pnpm test                                 # Rules, execution, logging, and HTTP regression tests
pnpm test:ui                              # Playwright Chromium with mocked backend; requires browser prerequisites
pnpm lint                                 # Frontend ESLint only; backend lint is not configured
pnpm build                                # Web build, then API compilation
pnpm --filter web preview                 # Built frontend preview; API still required
```

Backend configuration lives in `apps/api/.env`: required `IMMICH_URL` and `IMMICH_API_KEY`, optional `PORT` (default 3001). `IMMICH_URL` is the Immich API base, e.g. `http://localhost:2283/api`; avoid a trailing slash. Zod validates it at startup, so valid initial configuration is required before the Settings UI can connect to the backend. Preserve existing `.env` values and never print or commit credentials.

Optional frontend configuration lives in `apps/web/.env`: `VITE_API_BASE_URL` defaults to `http://localhost:3001` and points to this project's API. Never put an Immich key in a `VITE_` variable. Vite normally serves on 5173; use the URL it prints. There is no Vite proxy. Package scripts provide the working directories expected by dotenv and settings writes.

Settings writes backend `.env` but does not update the running parsed configuration or SDK. Restart the API after saving. The header checks connection status only on shell mount; reload to refresh it. Frontend environment changes require restarting Vite or rebuilding its bundle.

Build output goes to `apps/web/dist` and `apps/api/dist`. There is no API `start` script or Express static frontend serving. Do not equate compilation with verified deployment; plain Node execution of the emitted API with source-exporting workspace dependencies has not been validated.

## Development conventions

- Keep changes focused and preserve existing behavior outside the requested scope.
- Keep the rule engine deterministic and free of network, filesystem, or UI side effects.
- Keep Immich SDK calls inside `apps/api`; frontend operations go through `src/api.ts` and the Express API.
- Put shared domain contracts in `packages/shared`. Frontend response types currently duplicate contracts; keep both sides consistent when changing an endpoint.
- Prefer explicit TypeScript types over `any`. Backend/packages inherit strict mode; the frontend has separate compiler configuration and does not inherit the root strict option.
- Use the existing React components and plain CSS unless the task requires an architectural change. Navigation uses component state, without a router or persistent preferences store.
- Any PR changing user-visible functionality or operational guarantees must review and update the Welcome page’s Current Functionality card, README.md’s matching section, and PROJECT_GUIDE.md together. Describe implemented behavior only and remove obsolete limitations as improvements land.
- Distinguish implemented behavior from UI placeholders and known defects. Do not describe a setting or guard as enforced unless its execution path actually uses it.

## Duplicate rules and execution requirements

Pipeline: fetch Immich duplicate groups -> reconcile continued scan queue or legacy first-N window -> normalize -> optional full asset/album reads -> evaluate published rules -> preview/dry-run/execute -> log batch results.

Automatic resolution requires exactly two distinct unlinked images with edited/trashed/favorite/archive/offline flags explicitly false and an eligible published-rule decision. Checksum matching is enabled by default; metadata inclusion presets require explicit heuristic acknowledgement and activation, including on existing installations. Metadata agreement does not prove identical content. Directory-based keeper preferences support same-source pairs; ties exclude, missing required evidence defers. Rules run in visible order with typed bounded AND/OR conditions, and unknown earlier conditions cannot fall through to a permissive include. Videos, larger groups, pixel comparisons and similarity-only inclusion remain unsupported. Compatibility confidence 100 is a fixed eligibility score, never probability. Keep the original hardcoded evaluator frozen for historical v1–v3 validation; production routes use configured rules.

Preserve these safety requirements when changing execution:

- Never automatically resolve uncertain/skipped decisions or weaken safety conditions as an incidental refactor.
- Require one valid keeper and one distinct loser present in a two-image group, with an eligible active-rule decision (`auto-resolve`, compatibility confidence 100). Source labels do not replace directory preferences or content/metadata comparisons.
- Transfer the kept asset into missing loser albums **before** duplicate resolution.
- Use SDK `resolveDuplicates`, corresponding to Immich `POST /duplicates/resolve`. Never substitute `deleteDuplicate` / `DELETE /duplicates/:id` for asset cleanup.
- Require explicit album-add and resolution success, confirmed keeper membership in required albums, and verification of loser `isTrashed === true` / `duplicateId === null` plus an untrashed keeper. Read failures or missing fields are never success. Verify at most three times with one-second intervals; never automatically retry mutations.
- Keep `scanLimit` separate from `executeLimit`: legacy requests use a local first-N scan window; opted-in continued reviews use it as an inspection budget, with optional candidate target. Immich has no duplicate-list pagination. Execute caps attempted eligible groups, including failures and dry-runs. Backend defaults are 100/10, UI defaults 100/5. Legacy `limit` supplies both defaults when present.
- Both execution POST routes and internal executors default to dry-run. Only literal JSON `"dryRun": false` opts into live execution. Reject non-boolean modes and supplied limits that are not positive safe integers with HTTP 400. Dry-run must not mutate Immich; batch dry-runs may append local audit entries.
- Refetch group membership, both assets and current albums before execution, bypass cached sizes, and re-evaluate the same selection. Stop batches on failed or uncertain attempts. Return proposed albums separately from confirmed transfers, retain partial evidence, and never report `executed: true` without fully verified success.
- Do not run live resolution merely to validate a code or documentation edit. Use local checks and explicit dry-runs within the task's authorized scope; execute live changes only when the user requests them.

Main routes: `/health`, `/immich/test`, `/immich/duplicates` and enrichment/debug variants, `/analysis/duplicates`, `/execution/plan`, `/execution/status`, `POST /execution/run`, single-group preview/execution under `/execution/duplicates/:groupId`, `/execution/log` with JSON/CSV exports and clear action, and `/settings/*`. Consult `PROJECT_GUIDE.md` or `app.ts` for precise contracts. Inspect per-group results even when HTTP status and top-level `ok` indicate success. `/health` tests backend liveness, not Immich connectivity.

## Persistence, caches, and current limitations

- The active execution log is **`apps/api/data/execution-log.json`**, selected from `__dirname` in the startup entry point, and ignored by Git. Tracked logs at the repository root and `apps/api/execution-log.json` are unused by the current logger. Do not confuse them or overwrite runtime logs during routine development.
- Recovery authority is `apps/api/data/execution-journal/`, not the display log. Successful journal attempts, verified-resolved assessments, and one-time scoped legacy exclusions protect processed groups. Clearing display logs never clears these or quarantines. Never delete/reset recovery files as a routine fix.
- Batch execution skips processed IDs, runs sequentially, delays 50 ms after successful/dry-run attempts, and stops after the first failure or uncertainty. Single-group execution uses the same coordinator, logging and exclusion checks. Plan/status counts do not exclude processed IDs.
- Legacy preview sizes are cached per app, including nulls, without expiry; fresh preparation/execution bypasses them. Internal/external labels still come from `classifySource.ts`, but configured eligibility/keepers use editable Rules directory preferences. Unknown labels alone do not exclude same-source or custom-path pairs.
- Legacy size enrichment uses unbounded `Promise.all`. Album enrichment processes assets sequentially and reads default/shared memberships with paired `getAllAlbums({ assetId })` requests, settling both before returning; validate lists and mark `albumsKnown` only after successful reads. Dedupe detailed preview refresh independently requests status, plan and analysis concurrently, repeating enrichment.
- Frontend Dedupe caches survive screen changes but are not keyed by scan limit. Refresh after changing limits. The WebUI executes an immutable reviewed plan with fresh checks; legacy API execution still recalculates candidates until PR7.
- Refresh previews retries read-only preview loading without rebuilding the review or rerunning execution. Transport errors include API access guidance; failed refreshes preserve execution results and review approval.
- Display-log reads reject malformed/unreadable files without replacing them. Journal writes validate records, flush a temporary file, atomically rename it and flush the directory (directory fsync required). Invalid/inconsistent/unsupported journals or failed writes disable execution and recovery changes; never treat them as empty history. Failures can follow partial Immich changes; there is still no transaction, rollback or durable background job queue.
- Outcomes distinguish `dry-run`, `succeeded`, `failed` and `needs-verification`, with a failure stage and proposed/confirmed albums. New batch logs/exports include these fields; historical entries remain unchanged. Unfinished/uncertain attempts remain quarantined by group and selected asset IDs across restarts. Unrelated groups remain usable. Rechecks read Immich and append local evidence only; an intact assessment needs an explicit freshly verified release before a separate new attempt. There is no automatic mutation replay, retry/resumption or restoration.
- The API has no authentication, unrestricted CORS, and no explicit loopback-only binding. `GET /settings/connection` currently returns the raw Immich key to the browser, contrary to the desired credential-isolation convention. Do not expand credential exposure or place secrets in logs/docs/bundles.
- Connection saving checks truthiness and writes unquoted values directly to `.env`; it neither fully validates values nor reinitializes runtime configuration.
- Settings' confirmation toggle works in browser memory only. Backend safeguards are fixed explanatory text; performance configuration is explicitly unimplemented. Test and save requires an API restart; Reset preview cache clears frontend previews only, and Clear form changes no saved/active credentials. Diagnostics omit keys and unimplemented performance settings.
- History is a placeholder; manual review is a read-only decision table; reviewed candidates have thumbnails and rule-selected keepers. Rules configuration is implemented, but direct manual keeper selection is absent. Logs shows the newest 20 entries, while exports include the full log. Below 900 px navigation uses a horizontal scrolling bar.

## Validation and reporting

Run checks appropriate to the files changed. For backend/rule/contract changes, use the API typecheck; for frontend changes, use its explicit `tsc -b` check or build. Use `pnpm build` for integration/build changes. For behavior changes, verify meaningful success and failure cases without mutating a real library as an incidental check. Tests live in `apps/api/tests`, including rule-engine coverage. The runner uses the API-local `tsx` dependency. HTTP tests listen on an ephemeral loopback port. All Immich/settings dependencies are fakes, and log tests use auto-cleaned temporary directories. Never point tests at production credentials or runtime log files.

PR 1 adds real workspace typechecking and resolves the frontend Hooks/Fast Refresh findings without disabling rules. Root lint deliberately checks the frontend only; backend lint remains unconfigured, and standalone package builds remain placeholders. API `tsconfig.check.json` includes tests, while the build configuration emits only application sources. PR 2 replaces the pending safety tests with executable failure-path tests, including metadata protections, stale data, album confirmation, response validation, bounded verification and batch stopping.

Report what changed, which checks actually ran, their results, and any unverified behavior. Do not claim live Immich compatibility or successful trash/album behavior based solely on compilation. Keep this file concise enough for routine loading; keep detailed route descriptions and extended operational explanations in `PROJECT_GUIDE.md`.

App construction must remain free of environment loading, SDK initialization, filesystem access, or listening. Keep those concerns in startup and inject SDK, fetch, log storage, and connection persistence into `createApp`. Keep file-size caches isolated per constructed app.

PR 3 invariants: both production execution routes must use the coordinator. Hold its lock before loading/enrichment and through completion, including after client disconnect. Rechecks, releases and log clearing share this lock; overlapping requests return 409. Only one API instance may use a data directory. Await the durable checkpoint before every mutation; journal failures return 503 with run IDs/available partial results. Keep checkpoint and crash/fault regression coverage when changing execution. App construction remains lazy and side-effect free.

Recovery scope is normalized Immich URL plus current-user ID; identity lookup must succeed, API keys must never be persisted, and legacy import runs once for its original scope. Manual recovery cannot override another unresolved attempt or perform any Immich mutation. Keep the Welcome Current Functionality card, README and project guide aligned with these actual guarantees and remaining limits.

Required endpoint API-key scopes (Immich v2.7.5): `server.about`, `user.read`, `duplicate.read`, `asset.read`, `asset.view`, `album.read`; live cleanup also uses `albumAsset.create` and `duplicate.delete`. Settings and README document purposes and account access requirements. Thumbnail size needs `asset.view`, not `asset.download`; after changing scopes prepare a new review to retry failed placeholders. The Immich API key requires `user.read` for `GET /users/me`, including dry-run identity checks. A successful connection test does not establish this permission. Diagnose 403/missing permission without bypassing identity or altering journal evidence; keep user-facing diagnostics free of credentials and raw SDK errors.

PR 4 invariants: legacy runs use journal version 2 with immutable request context and a terminal report; version 1 remains readable unchanged, with unknown metadata left null. Older releases cannot read v2: do not downgrade against the same data directory. Scoped latest/specific run GETs must remain read-only, including no migration. Keep compact run contracts in shared; raw checkpoint evidence remains in recovery detail. Shell-owned requests survive navigation; never label a lost response as stopped or discard returned partial evidence when a journal refresh fails. Restore only the latest current-account run, with explicit refresh and no automatic polling/retry. Preserve original attempt outcomes when showing later recovery assessments. UI tests use fake API responses, never production credentials. Maintain Welcome, README and guide descriptions together, including unknown older data and unsaved partial-results limitations.

Historical PR5/PR6 invariants (v3 remains readable; configured reviewed runs now use v4): plan preparation and planned execution share the coordinator lock and fresh preflight helper with legacy execution. Plans are scoped, immutable, in memory (15 minutes, capacity 20). Require exact-selection successful journaled dry-run authorization on planned live requests. Reject changed batches before mutation, then validate each group again; never substitute candidates. Accepted live requests consume plans. Reviewed journal v3 evidence and its referenced dry-run are immutable and validated; retain v1/v2 reading and legacy v2 writing. UI reviews live in shell memory, changing selection clears approval, changing limits invalidates review, and thumbnails are backend-proxied only for assets in the current scoped plan. No credentials in image URLs/responses. Legacy live API routes remain available until PR7; do not claim universal reviewed execution yet. Keep documentation and fake-backend browser tests aligned.

Review preparation progress/cancellation: POST /execution/plans supports opt-in NDJSON progress with a terminal completed/cancelled result or sanitized error; ordinary JSON callers are unchanged. POST /execution/preparations/:preparationId/cancel only flags cancellation and does not acquire the coordinator lock or mutate Immich. Keep the lock until all started read batches settle and partial-plan finalization finishes. Retain only fully checked candidates/exclusions; partial reviews remain scoped immutable plans requiring exact-selection journaled dry-run authorization and fresh execution checks. Shell-owned progress/cancellation survives navigation, with no automatic retry/reconnection or reload restoration. Cancellation is confirmed by the terminal result, never by a transport disconnect. Keep fake HTTP/browser tests and the three user-facing documents aligned.

Reviewed selection controls: Select first N follows the effective plan executeLimit, synchronized to Controls. Select All may explicitly raise it through POST /execution/plans/:planId/select-all (empty body): under the coordinator lock and verified identity, derive a new immutable scoped plan preserving candidates, exclusions, partial-review metadata and the original expiry. Never extend TTL or carry dry-run authorization. UI updates Execute Limit and clears approval; failures preserve the prior review/selection. Selecting all within the existing limit is local and clears approval too. Run/journal caps, exact-selection dry-run authorization and fresh checks remain enforced. This only includes eligible groups already checked in the current review, never excluded/unscanned groups.

Prepared review rows (eligible and excluded) are collapsed by default, with visible selection checkboxes for candidates. Individual accessible toggles and Expand All/Collapse All only change local display state; never clear dry-run approval or alter selection/limits for disclosure changes. A new plan or screen remount resets expansion.

For generic/non-JSON API 404s, frontend diagnostics identify method/path and explain restarting the current API checkout, reloading/repreparing, and checking frontend API-base/proxy routing. Preserve structured domain 404/410 errors and partial execution evidence. Never work around a missing Select All route by bypassing plan limits or using legacy live execution. Health liveness does not establish route compatibility; restart only an idle API and retain all recovery files.

Fresh preflight membership errors report unsupported asset counts (exactly two distinct assets are still required) separately from missing groups, repeated group entries/asset IDs and missing selected assets. Do not describe a static three-asset group as “membership changed” or relax eligibility when improving exclusion text.

Quick Review: POST /execution/quick-reviews evaluates a single duplicate-list response with active published rules and authoritative exclusions; never enrich missing data or infer safe flags. Compact provisional snapshots have separate shared contracts/store (15 minutes, capacity 20) and no album/action fields. They cannot authorize execution or thumbnails. POST /execution/quick-reviews/:reviewId/prepare-plan verifies the exact selected candidates via fresh preflight, rejects any stale selection as a whole and creates a normal full plan requiring a new journaled dry-run. Unknown albums are learned at upgrade, not assumed empty; available checksums remain protected. Quick scan progress/cancellation uses the existing lock/registry and yields every 25 groups. UI mode survives navigation, suppresses new automatic detailed preview reads and ignores late older results, but cannot stop already-started upstream reads. Keep full preparation/execution and journal guarantees unchanged, and cover request counts, missing metadata, selected-only hydration, cancellation, scope/expiry and unsafe changes with fakes.


## Configurable rules and continued scanning

Rules drafts/revisions are scoped by verified Immich URL/account and persisted through the injected lazy `rulesStore`. Publishing shares the coordinator lock, activates an immutable revision and invalidates prior full/Quick reviews and dry-run authorization. Every production decision/execution path, including legacy routes, enforces active rules. Directory preferences match case-sensitively at path boundaries. Preserve all fixed protected-asset guards. Quick Review never enriches rule data; album-dependent conditions defer rather than assuming empty membership. Full and Quick missing required metadata is unverified/deferred, not a definitive rule exclusion. Draft tests include every fully observed group in the prepared snapshot, including exclusions, without extra Immich reads.

New configurable reviewed journals write v4 with immutable rules/evidence and matching referenced dry-run; retain frozen v1–v3 readers and legacy v2 writing. Never validate historical records using newly edited active rules. Do not downgrade against newer journal storage. Full preparation uses one duplicate membership snapshot plus fresh assets/albums; execution still refetches current membership for whole-batch and per-group checks.

The WebUI opts into `scan: { mode: "groups" }` or `{ mode: "candidates", candidateTarget }` on preparation. `scanLimit` bounds inspected queued groups; candidate targets count provisional/full candidates according to review mode. Persistent advisory queue reconciliation uses identity, membership and fresh dependency fingerprints, not refreshed numeric offsets. Preserve unseen progress across list reorder/shrink; queue changed/new entries behind unseen work. Cache an exclusion only when all dependencies are available in fresh list data; enriched-only/album data needs new reads. Missing data/transient errors are not permanent exclusions.

Startup injects `apps/api/data/rules.json` and `scan-progress.json`, separate from journals/logs. Advisory observations flush every 25 completed groups and before terminal/cancelled responses; crash loss can only repeat read-only work. Pending proposals survive restarts but never restore executable plans/approval. Load pending details requires fresh rules/scope/identity/exclusion/membership/assets/albums and creates a new 15-minute full plan plus new dry-run requirement. Journal success/quarantine always overrides advisory state. Reset scan progress affects no recovery evidence. Malformed advisory state must be preserved and reported, never silently treated as empty. Keep request-count, restart/invalidation and cancellation tests alongside engine/execution regression tests.

Saved presets are scoped whole-rule-set snapshots, separate from the active immutable rules revision and saved draft. Preserve lazy compatibility for older rules files without `savedPresets`; never reseed an explicitly empty list. Preset saves/deletes share the coordinator lock, require current ID/revision for overwrite/delete, and never publish rules or invalidate review approval on their own. UI loading replaces all editor rules, saving confirms overwrite versus a new name, and failed/cancelled saves retain edits. Keep rule templates (`presets`) distinct from saved whole-set presets (`savedPresets`).
