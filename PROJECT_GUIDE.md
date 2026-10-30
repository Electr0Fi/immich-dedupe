# Immich Dedupe: repository and operations guide

Reviewed on 2026-10-30. This is a working reference for future development sessions, based on the repository's application code, package scripts, configuration, and existing documentation. Recheck the source when changing behavior; this file describes the reviewed snapshot.

## Purpose and current state

Immich Dedupe is a local web application for resolving duplicate groups already identified by an Immich server. It does not scan image files itself or calculate visual similarity. Its main use case is keeping a larger external-library original and trashing a smaller internal-library copy while preserving album membership.

The backend, deterministic rules, batch executor, React dashboard, plan preview, and execution logs are implemented. Manual review currently means displaying uncertain/skipped decisions, with no manual choice or resolution controls. History is a placeholder. There are no thumbnails, configurable rules, database, CI workflow, container setup, or packaged deployment in the tracked repository.

The root README is unfinished and predates the current dashboard. `apps/web/README.md` is Vite template documentation. `CLAUDE.md` provides project conventions; credential isolation remains a desired property rather than the current settings behavior.

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
| `apps/api/src/executePlan.ts` | Sequential batch processing, processed-group exclusion, audit logging |
| `apps/api/src/executionLog.ts` | JSON persistence and successful-execution tracking |
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

Normalization preserves IDs, filenames, paths, timestamps, dimensions, checksums, source flags, edited/trashed flags, and initializes empty album memberships and null file sizes. Dimensions fall back to EXIF values. Missing edited/trashed flags default to false. Checksums and timestamps are stored but are not compared by the rules.

Source classification uses hardcoded prefixes in `classifySource.ts`, not `libraryId` or a server-provided external flag. Recognized external paths include `/external/`, `/mnt/external/`, and `/photos/external/`. Internal paths include `/usr/src/app/upload/`, `/photos/internal/`, `/data/internal/`, and `/data/library/admin/`. Unknown paths produce both flags false and cannot qualify for automatic resolution. Paths are lowercased before matching; an extra mixed-case external prefix is redundant. Check actual Immich paths when troubleshooting zero eligible groups.

File sizes come from `getAssetInfo().exifInfo.fileSizeInByte`, accepting finite numbers or numeric strings. An app-scoped map caches sizes, including null values, with no expiry. Asset/group enrichment uses `Promise.all` without a concurrency limit. Album enrichment fetches every visible album and then its full assets sequentially, rebuilding the index for each request. An enrichment request failure aborts that request.

## Decision rules

Rules run in order; the first match wins. Confidence is a fixed rule score, not a statistical probability.

| Rule | Conditions and result |
| --- | --- |
| External larger, same name/resolution | Exactly two assets; neither edited nor trashed; trimmed case-insensitive filenames match; both width and height are known and equal; one external and one internal; both sizes known; external strictly larger. Keep external, trash internal, `auto-resolve`, confidence 100. |
| Missing size | Same pair/name/resolution/safety conditions, but either size absent. `uncertain`, confidence 40, no asset selections. |
| Different resolution | Exactly two assets with matching filenames for which the equal-known-dimensions check fails. `skip`, confidence 0. Missing dimensions also land here, despite the displayed reason saying resolution differs. |
| Default | Everything else, including larger groups and equal-sized pairs. `uncertain`, confidence 10. |

The engine is pure and makes no network calls. New rules belong in `packages/rule-engine`, with data contracts in `packages/shared`. The web package currently duplicates response types rather than importing shared contracts.

## Execution semantics and persistence

`scanLimit` chooses the first N groups from the server response; it is not pagination. `executeLimit` caps attempted eligible groups, including failed attempts and dry-run results. Batch defaults are scan 100 / execute 10; UI defaults are scan 100 / execute 5. Legacy request field `limit` supplies both defaults when provided. Limit parsing accepts positive finite numbers but does not enforce integers or a maximum.

The executor requires exactly two assets, one external and one internal, an `auto-resolve` decision with confidence 100, one trash ID, distinct keep/trash IDs, and both selected assets present. Batch execution skips group IDs recorded as successful live executions. Decisions and groups are paired by array index.

Dry-run performs reads and safety checks but does not mutate Immich. It reports missing album memberships in `transferredAlbumIds` as proposed transfers; those have not actually occurred. Batch dry-runs still append local audit entries.

Live execution adds the kept asset to albums held only by the loser, calls SDK `resolveDuplicates` (Immich `POST /duplicates/resolve`), then checks the losing asset. Preserve this operation ordering. Do not replace duplicate resolution with Immich `DELETE /duplicates/:id`, which is not the intended asset-cleanup operation.

Batch work is sequential with a fixed 50 ms delay after non-throwing attempts. Per-group exceptions become failure results and processing continues. Successful live entries require `mode === "execute"` and all of `executed`, `resolvedDuplicate`, and `trashedAsset` true to enter processed tracking.

The active log is **`apps/api/data/execution-log.json`**, selected in startup relative to `src` or `dist` through `__dirname`. It is ignored by Git. Tracked `execution-log.json` files at the repository root and `apps/api/` are not read by the current logger; the older `src/execution-log.json` location is no longer used. Tests inject a temporary log path. JSON reads/writes are synchronous and rewrite the entire file. Missing or invalid JSON reads as an empty log; there is no schema validation, database, rotation, or atomic replacement.

Clearing logs also clears processed-group tracking; it does not undo Immich operations. The single-group execution route calls the decision executor directly and neither appends batch logs nor checks processed history. Plan and status endpoints count executable rules without excluding processed IDs, whereas batch eligibility excludes them.

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
| GET | `/execution/log` | Full log, count, filesystem path |
| GET | `/execution/log/export.json`, `/execution/log/export.csv` | Download full log; CSV includes BOM and escaped fields |
| POST | `/execution/log/clear` | Clear audit and processed tracking |
| GET | `/settings/status` | Ping/about-based connection status |
| GET | `/settings/connection` | Current startup URL and API key |
| POST | `/settings/connection` | Write `{ immichUrl, apiKey }` to backend `.env` |
| POST | `/settings/test-connection` | Test supplied URL/key against `/server/about` |

For both execution POST routes, **only literal JSON `true` enables dry-run**. Missing `dryRun`, false, or the string `"true"` selects live execution.

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

The shell uses React state for navigation, with no router, URL routes, or persistent settings store. Switching screens unmounts them. Dedupe keeps module-level status/plan/analysis caches across navigation, but these are not keyed by scan limit. Changing a limit needs Refresh to update the preview; execution always sends the current inputs and the server recalculates decisions rather than executing an immutable preview. Local limits and last-run results reset on remount.

Each refresh concurrently requests status, plan, and analysis. Each backend route independently repeats the duplicate/enrichment workflow, including album indexing. Cached file sizes can still trigger duplicate fetches when concurrent requests race on an initially empty cache.

Logs displays the newest 20 entries, with exports covering the full log. History is a static placeholder. The app uses plain CSS; at widths below 900 px, the sidebar disappears with no replacement navigation.

Settings implementation details:

- Test Connection tests and then saves the credentials. It does not reinitialize the running SDK, and does not inspect a save response's `ok` flag before showing success.
- Require confirmation is the only enabled safety toggle, held in shell memory. It gates the browser confirm dialog, not backend authorization.
- Other safety toggles are disabled placeholders. The checked dry-run default does not enforce a backend default; the explicit Execute button sends `dryRun: false`.
- Performance inputs only change component state and diagnostic exports. They do not configure batch size, API concurrency, delay, or caches, and reset when Settings unmounts.
- The displayed `~/.immich-dedupe/cache` path is a placeholder. Actual caches are in browser-module memory and the app-scoped backend file-size map.
- Reset Local Cache clears the frontend module cache only. It does not clear backend file sizes.
- Clear Credentials only clears the current form state. It does not erase `.env` or active SDK credentials.
- Diagnostics exports the current form/preferences and omits the API key.

## Review findings to account for before execution changes

These are observations of existing code, not fixes made by this review:

1. **Trash verification treats every fetch exception as success.** `verifyAssetIsTrashed` returns true on any `getAssetInfo` error, including network/auth/server errors. It checks `isTrashed === true` on a returned asset but does not verify `duplicateId === null`, keeper state, or duplicate-group removal. Success flags therefore provide weaker evidence than their names suggest.
2. **Album transfer success is not inspected per item.** The code awaits `addAssetsToAlbums` but does not validate its returned individual results or reread album membership before resolving. Album preservation depends on the server's response semantics and available album permissions.
3. **The API has no authentication and returns the Immich key.** `GET /settings/connection` sends the raw key into browser state. CORS is unrestricted and `app.listen(PORT)` does not restrict binding to loopback. This contradicts `CLAUDE.md`'s desired key isolation; treat the current server as a trusted local tool when operating it.
4. **Connection persistence is basic.** Settings POST checks only truthiness, writes unquoted values directly to `.env`, and leaves runtime configuration unchanged. Validation/escaping and live reinitialization are absent.
5. **Execution and logging are not transactional.** There is no request-level execution lock, durable job queue, rollback, or atomic log replacement. Concurrent batches can work from the same history snapshot. A later failure may leave album transfers or other Immich changes already applied; reported failure does not imply nothing changed.
6. **Safety relies on normalized data and rule output.** The executor does not re-fetch fresh complete safety metadata immediately before mutation or independently repeat filename/resolution/size comparisons. Path assumptions, default false flags, and indefinitely cached sizes matter.

## Build, validation, and maintenance

Run these checks from the repository root:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

`pnpm test` runs `apps/api/tests/*.test.ts` with Node’s built-in runner and the existing API-local `tsx` loader. Coverage includes rules, execution ordering and guards, batch attempts and history, isolated log storage, and representative HTTP/settings/export paths. HTTP tests use an ephemeral loopback server and fake Immich/fetch/settings dependencies; no real credentials are needed. Three TODO tests reserve verification-fetch and unsuccessful SDK-response handling for PR 2 without asserting the defects as intended behavior.

`pnpm build` compiles the frontend into `apps/web/dist` and the API into `apps/api/dist`. Build success does not establish a production runtime: there is no API `start` script or frontend static serving in Express, and the shared packages expose `.ts` source. Plain `node apps/api/dist/index.js` deployment was not validated. `pnpm --filter web preview` previews the built frontend only and still needs the API.

`pnpm lint` runs frontend ESLint only; backend lint remains unconfigured. The existing Hooks/Fast Refresh findings have been fixed without disabling lint rules. Root `typecheck` now covers all workspace packages, the web app, and API tests. API build excludes tests; `tsconfig.check.json` includes them for typechecking. Standalone package build scripts remain placeholders. The web app has separate compiler configuration and does not inherit the root strict setting.

PR 1 preserves execution semantics, including known safety defects and default live execution when `dryRun` is omitted. Tests do not contact a live Immich server or prove compatibility with a particular server deployment. A browser-based interaction smoke test still needs to be performed in an environment with a browser.

For future edits, start with the relevant source files in the map above. Keep rule evaluation deterministic, preserve album-transfer-before-resolution ordering, explicitly use `dryRun: true` for execution verification, and inspect per-group outcomes. Update this guide when paths, API contracts, settings behavior, or execution guarantees change.
