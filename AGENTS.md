# Agent instructions for Immich Dedupe

Applies to the entire repository. Reviewed against source on 2026-10-30.

## Start here

Read [PROJECT_GUIDE.md](PROJECT_GUIDE.md) for the detailed architecture, HTTP route inventory, operations workflow, and review findings. This file contains the essential instructions for working on the project. Confirm behavior against source before editing; update both documents when relevant behavior changes.

The root README is incomplete and predates the dashboard. `apps/web/README.md` is template documentation. `CLAUDE.md` contains additional conventions. Credential isolation describes intended design, not current implementation; see the known settings limitation below.

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
| `apps/api/src/executePlan.ts` | Sequential batch execution and logging |
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
- Distinguish implemented behavior from UI placeholders and known defects. Do not describe a setting or guard as enforced unless its execution path actually uses it.

## Duplicate rules and execution requirements

Pipeline: fetch Immich duplicate groups -> take the scan window -> normalize -> enrich file sizes -> enrich album memberships -> evaluate rules -> preview/dry-run/execute -> log batch results.

Automatic resolution currently requires exactly two assets, neither edited nor trashed, matching trimmed case-insensitive filenames, known equal width and height, one external and one internal asset, and both file sizes known with the external strictly larger. It keeps external, selects one internal loser, and assigns confidence 100. Confidence is a fixed rule score, not probability. Missing sizes yield uncertain/40 for an otherwise matching pair. Matching names with unequal or missing dimensions yield skip/0. Other groups yield uncertain/10. Rules run in order, first match wins; checksums are stored but not compared.

Preserve these safety requirements when changing execution:

- Never automatically resolve uncertain/skipped decisions or weaken safety conditions as an incidental refactor.
- Require a valid keep asset and one distinct trash asset present in a two-asset external/internal group, with an auto-resolve decision at confidence 100.
- Transfer the kept asset into missing loser albums **before** duplicate resolution.
- Use SDK `resolveDuplicates`, corresponding to Immich `POST /duplicates/resolve`. Never substitute `deleteDuplicate` / `DELETE /duplicates/:id` for asset cleanup.
- Verify the losing asset's trash state; a returned asset can still exist while `isTrashed === true`. Treat the existing exception-to-success behavior below as a defect, not an intended guarantee.
- Keep `scanLimit` separate from `executeLimit`: scan selects the first N groups, with no pagination; execute caps attempted eligible groups, including failures and dry-runs. Backend defaults are 100/10, UI defaults 100/5. Legacy `limit` supplies both defaults when present.
- Both execution POST routes enable simulation only with literal JSON `"dryRun": true`. Missing, false, or string values select live execution. Dry-run must not mutate Immich; batch dry-runs may append local audit entries.
- Do not run live resolution merely to validate a code or documentation edit. Use local checks and explicit dry-runs within the task's authorized scope; execute live changes only when the user requests them.

Main routes: `/health`, `/immich/test`, `/immich/duplicates` and enrichment/debug variants, `/analysis/duplicates`, `/execution/plan`, `/execution/status`, `POST /execution/run`, single-group preview/execution under `/execution/duplicates/:groupId`, `/execution/log` with JSON/CSV exports and clear action, and `/settings/*`. Consult `PROJECT_GUIDE.md` or `app.ts` for precise contracts. Inspect per-group results even when HTTP status and top-level `ok` indicate success. `/health` tests backend liveness, not Immich connectivity.

## Persistence, caches, and current limitations

- The active execution log is **`apps/api/data/execution-log.json`**, derived from `__dirname` in `executionLog.ts`, and ignored by Git. Tracked logs at the repository root and `apps/api/execution-log.json` are unused by the current logger. Do not confuse them or overwrite runtime logs during routine development.
- Only live entries with `executed`, `resolvedDuplicate`, and `trashedAsset` all true count as processed. Clearing logs also clears this tracking and does not undo Immich changes.
- Batch execution skips processed IDs, runs sequentially, and delays 50 ms after non-throwing attempts. Single-group execution bypasses batch logging and processed-ID checks. Plan/status counts do not exclude processed IDs.
- File sizes are cached in an app-scoped map, including nulls, with no expiry. Source flags come from hardcoded path prefixes in `classifySource.ts`, not `libraryId`. Unknown paths cannot qualify. Check these assumptions when diagnosing zero eligible groups.
- Asset enrichment uses unbounded `Promise.all`; album enrichment reads all visible albums and their full assets on every request. Dedupe refresh independently requests status, plan, and analysis concurrently, repeating this work.
- Frontend Dedupe caches survive screen changes but are not keyed by scan limit. Refresh after changing limits. Live execution recalculates decisions, rather than executing a saved immutable preview.
- The logger rewrites the full JSON file synchronously, treats unreadable/invalid JSON as an empty log, and has no schema validation or atomic replacement. There is no execution lock, rollback, transaction, or durable job queue. Failures can follow partial Immich changes.
- `verifyAssetIsTrashed` currently treats any asset-fetch exception as success; it does not verify `duplicateId === null` or keeper state. Album-add responses are awaited without per-item result verification. Account for these defects before relying on success flags.
- The API has no authentication, unrestricted CORS, and no explicit loopback-only binding. `GET /settings/connection` currently returns the raw Immich key to the browser, contrary to the desired credential-isolation convention. Do not expand credential exposure or place secrets in logs/docs/bundles.
- Connection saving checks truthiness and writes unquoted values directly to `.env`; it neither fully validates values nor reinitializes runtime configuration.
- Settings' confirmation toggle works in browser memory only. Other safety controls are disabled placeholders. Performance controls affect component state/diagnostics only, not backend behavior. The displayed cache directory is a placeholder. Reset Local Cache clears only frontend cached scans. Clear Credentials clears only the form, not saved or active credentials.
- History is a placeholder; manual review is a read-only decision table; thumbnails and rule configuration are absent. Logs shows the newest 20 entries, while exports include the full log. Below 900 px the sidebar is hidden without replacement navigation.

## Validation and reporting

Run checks appropriate to the files changed. For backend/rule/contract changes, use the API typecheck; for frontend changes, use its explicit `tsc -b` check or build. Use `pnpm build` for integration/build changes. For behavior changes, verify meaningful success and failure cases without mutating a real library as an incidental check. Tests live in `apps/api/tests`, including rule-engine coverage. The runner uses the API-local `tsx` dependency. HTTP tests listen on an ephemeral loopback port. All Immich/settings dependencies are fakes, and log tests use auto-cleaned temporary directories. Never point tests at production credentials or runtime log files.

PR 1 adds real workspace typechecking and resolves the frontend Hooks/Fast Refresh findings without disabling rules. Root lint deliberately checks the frontend only; backend lint remains unconfigured, and standalone package builds remain placeholders. API `tsconfig.check.json` includes tests, while the build configuration emits only application sources. Three pending safety tests document the verification-fetch and partial SDK-response defects for PR 2; do not treat pending cases as passing guarantees.

Report what changed, which checks actually ran, their results, and any unverified behavior. Do not claim live Immich compatibility or successful trash/album behavior based solely on compilation. Keep this file concise enough for routine loading; keep detailed route descriptions and extended operational explanations in `PROJECT_GUIDE.md`.

App construction must remain free of environment loading, SDK initialization, filesystem access, or listening. Keep those concerns in startup and inject SDK, fetch, log storage, and connection persistence into `createApp`. Keep file-size caches isolated per constructed app.
