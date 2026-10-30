# Agent instructions for Immich Dedupe

Applies to the entire repository. Reviewed against source on 2026-10-30.

## Start here

Read [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for the detailed architecture, HTTP route inventory, operations workflow, and review findings. This file contains the essential instructions for working on the project. Confirm behavior against source before editing; update both documents when relevant behavior changes.

The root README and Welcome Current Functionality card describe the current release. `apps/web/README.md` is template documentation. `CLAUDE.md` contains additional conventions. Credential isolation describes intended design, not current implementation; see the known settings limitation below.

## Purpose and architecture

This local application consumes duplicate groups already identified by Immich. It does not discover duplicates by scanning files or calculating similarity. The primary automatic operation keeps a larger external-library original and trashes a smaller internal-library copy, preserving album memberships first.

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
| `packages/rule-engine/src/index.ts` | Pure ordered decision rules |
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

Pipeline: fetch Immich duplicate groups -> take the scan window -> normalize -> enrich file sizes -> enrich album memberships -> evaluate rules -> preview/dry-run/execute -> log batch results.

Automatic resolution currently requires exactly two unlinked images, with edited/trashed/favorite/archive/offline flags explicitly false, matching trimmed case-insensitive filenames, known equal width and height, one external and one internal asset, and both file sizes known with the external strictly larger. It keeps external, selects one internal loser, and assigns confidence 100. Confidence is a fixed rule score, not probability. Missing sizes yield uncertain/40 for an otherwise matching pair. Matching names with unequal or missing dimensions yield skip/0. Other groups yield uncertain/10. Rules run in order, first match wins; the automatic rule does not compare checksums, while reviewed execution detects changes to available checksums.

Preserve these safety requirements when changing execution:

- Never automatically resolve uncertain/skipped decisions or weaken safety conditions as an incidental refactor.
- Require a valid keep asset and one distinct trash asset present in a two-asset external/internal group, with an auto-resolve decision at confidence 100.
- Transfer the kept asset into missing loser albums **before** duplicate resolution.
- Use SDK `resolveDuplicates`, corresponding to Immich `POST /duplicates/resolve`. Never substitute `deleteDuplicate` / `DELETE /duplicates/:id` for asset cleanup.
- Require explicit album-add and resolution success, confirmed keeper membership in required albums, and verification of loser `isTrashed === true` / `duplicateId === null` plus an untrashed keeper. Read failures or missing fields are never success. Verify at most three times with one-second intervals; never automatically retry mutations.
- Keep `scanLimit` separate from `executeLimit`: scan selects the first N groups, with no pagination; execute caps attempted eligible groups, including failures and dry-runs. Backend defaults are 100/10, UI defaults 100/5. Legacy `limit` supplies both defaults when present.
- Both execution POST routes and internal executors default to dry-run. Only literal JSON `"dryRun": false` opts into live execution. Reject non-boolean modes and supplied limits that are not positive safe integers with HTTP 400. Dry-run must not mutate Immich; batch dry-runs may append local audit entries.
- Refetch group membership, both assets and current albums before execution, bypass cached sizes, and re-evaluate the same selection. Stop batches on failed or uncertain attempts. Return proposed albums separately from confirmed transfers, retain partial evidence, and never report `executed: true` without fully verified success.
- Do not run live resolution merely to validate a code or documentation edit. Use local checks and explicit dry-runs within the task's authorized scope; execute live changes only when the user requests them.

Main routes: `/health`, `/immich/test`, `/immich/duplicates` and enrichment/debug variants, `/analysis/duplicates`, `/execution/plan`, `/execution/status`, `POST /execution/run`, single-group preview/execution under `/execution/duplicates/:groupId`, `/execution/log` with JSON/CSV exports and clear action, and `/settings/*`. Consult `PROJECT_GUIDE.md` or `app.ts` for precise contracts. Inspect per-group results even when HTTP status and top-level `ok` indicate success. `/health` tests backend liveness, not Immich connectivity.

## Persistence, caches, and current limitations

- The active execution log is **`apps/api/data/execution-log.json`**, selected from `__dirname` in the startup entry point, and ignored by Git. Tracked logs at the repository root and `apps/api/execution-log.json` are unused by the current logger. Do not confuse them or overwrite runtime logs during routine development.
- Recovery authority is `apps/api/data/execution-journal/`, not the display log. Successful journal attempts, verified-resolved assessments, and one-time scoped legacy exclusions protect processed groups. Clearing display logs never clears these or quarantines. Never delete/reset recovery files as a routine fix.
- Batch execution skips processed IDs, runs sequentially, delays 50 ms after successful/dry-run attempts, and stops after the first failure or uncertainty. Single-group execution uses the same coordinator, logging and exclusion checks. Plan/status counts do not exclude processed IDs.
- File sizes are cached in an app-scoped map, including nulls, with no expiry. Source flags come from hardcoded path prefixes in `classifySource.ts`, not `libraryId`. Unknown paths cannot qualify. Check these assumptions when diagnosing zero eligible groups.
- Asset enrichment uses unbounded `Promise.all`; album enrichment reads all visible albums and their full assets on every request. Dedupe refresh independently requests status, plan, and analysis concurrently, repeating this work.
- Frontend Dedupe caches survive screen changes but are not keyed by scan limit. Refresh after changing limits. The WebUI executes an immutable reviewed plan with fresh checks; legacy API execution still recalculates candidates until PR7.
- Display-log reads reject malformed/unreadable files without replacing them. Journal writes validate records, flush a temporary file, atomically rename it and flush the directory (directory fsync required). Invalid/inconsistent/unsupported journals or failed writes disable execution and recovery changes; never treat them as empty history. Failures can follow partial Immich changes; there is still no transaction, rollback or durable background job queue.
- Outcomes distinguish `dry-run`, `succeeded`, `failed` and `needs-verification`, with a failure stage and proposed/confirmed albums. New batch logs/exports include these fields; historical entries remain unchanged. Unfinished/uncertain attempts remain quarantined by group and selected asset IDs across restarts. Unrelated groups remain usable. Rechecks read Immich and append local evidence only; an intact assessment needs an explicit freshly verified release before a separate new attempt. There is no automatic mutation replay, retry/resumption or restoration.
- The API has no authentication, unrestricted CORS, and no explicit loopback-only binding. `GET /settings/connection` currently returns the raw Immich key to the browser, contrary to the desired credential-isolation convention. Do not expand credential exposure or place secrets in logs/docs/bundles.
- Connection saving checks truthiness and writes unquoted values directly to `.env`; it neither fully validates values nor reinitializes runtime configuration.
- Settings' confirmation toggle works in browser memory only. Backend safeguards are fixed explanatory text; performance configuration is explicitly unimplemented. Test and save requires an API restart; Reset preview cache clears frontend previews only, and Clear form changes no saved/active credentials. Diagnostics omit keys and unimplemented performance settings.
- History is a placeholder; manual review is a read-only decision table; reviewed candidates have thumbnails and fixed keeper selection; rule configuration is absent. Logs shows the newest 20 entries, while exports include the full log. Below 900 px navigation uses a horizontal scrolling bar.

## Validation and reporting

Run checks appropriate to the files changed. For backend/rule/contract changes, use the API typecheck; for frontend changes, use its explicit `tsc -b` check or build. Use `pnpm build` for integration/build changes. For behavior changes, verify meaningful success and failure cases without mutating a real library as an incidental check. Tests live in `apps/api/tests`, including rule-engine coverage. The runner uses the API-local `tsx` dependency. HTTP tests listen on an ephemeral loopback port. All Immich/settings dependencies are fakes, and log tests use auto-cleaned temporary directories. Never point tests at production credentials or runtime log files.

PR 1 adds real workspace typechecking and resolves the frontend Hooks/Fast Refresh findings without disabling rules. Root lint deliberately checks the frontend only; backend lint remains unconfigured, and standalone package builds remain placeholders. API `tsconfig.check.json` includes tests, while the build configuration emits only application sources. PR 2 replaces the pending safety tests with executable failure-path tests, including metadata protections, stale data, album confirmation, response validation, bounded verification and batch stopping.

Report what changed, which checks actually ran, their results, and any unverified behavior. Do not claim live Immich compatibility or successful trash/album behavior based solely on compilation. Keep this file concise enough for routine loading; keep detailed route descriptions and extended operational explanations in `PROJECT_GUIDE.md`.

App construction must remain free of environment loading, SDK initialization, filesystem access, or listening. Keep those concerns in startup and inject SDK, fetch, log storage, and connection persistence into `createApp`. Keep file-size caches isolated per constructed app.

PR 3 invariants: both production execution routes must use the coordinator. Hold its lock before loading/enrichment and through completion, including after client disconnect. Rechecks, releases and log clearing share this lock; overlapping requests return 409. Only one API instance may use a data directory. Await the durable checkpoint before every mutation; journal failures return 503 with run IDs/available partial results. Keep checkpoint and crash/fault regression coverage when changing execution. App construction remains lazy and side-effect free.

Recovery scope is normalized Immich URL plus current-user ID; identity lookup must succeed, API keys must never be persisted, and legacy import runs once for its original scope. Manual recovery cannot override another unresolved attempt or perform any Immich mutation. Keep the Welcome Current Functionality card, README and project guide aligned with these actual guarantees and remaining limits.

The Immich API key requires `user.read` for `GET /users/me`, including dry-run identity checks. A successful connection test does not establish this permission. Diagnose 403/missing permission without bypassing identity or altering journal evidence; keep user-facing diagnostics free of credentials and raw SDK errors.

PR 4 invariants: legacy runs use journal version 2 with immutable request context and a terminal report; version 1 remains readable unchanged, with unknown metadata left null. Older releases cannot read v2: do not downgrade against the same data directory. Scoped latest/specific run GETs must remain read-only, including no migration. Keep compact run contracts in shared; raw checkpoint evidence remains in recovery detail. Shell-owned requests survive navigation; never label a lost response as stopped or discard returned partial evidence when a journal refresh fails. Restore only the latest current-account run, with explicit refresh and no automatic polling/retry. Preserve original attempt outcomes when showing later recovery assessments. UI tests use fake API responses, never production credentials. Maintain Welcome, README and guide descriptions together, including unknown older data and unsaved partial-results limitations.

PR5/PR6 invariants: plan preparation and planned execution share the coordinator lock and fresh preflight helper with legacy execution. Plans are scoped, immutable, in memory (15 minutes, capacity 20). Require exact-selection successful journaled dry-run authorization on planned live requests. Reject changed batches before mutation, then validate each group again; never substitute candidates. Accepted live requests consume plans. Reviewed journal v3 evidence and its referenced dry-run are immutable and validated; retain v1/v2 reading and legacy v2 writing. UI reviews live in shell memory, changing selection clears approval, changing limits invalidates review, and thumbnails are backend-proxied only for assets in the current scoped plan. No credentials in image URLs/responses. Legacy live API routes remain available until PR7; do not claim universal reviewed execution yet. Keep documentation and fake-backend browser tests aligned.
