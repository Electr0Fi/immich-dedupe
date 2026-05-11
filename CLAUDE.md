````md
# CLAUDE.md

## Project

Immich Dedupe is a local TypeScript monorepo for safely resolving Immich duplicate groups.

The app connects to Immich through the backend, analyzes duplicate groups, applies conservative rules, preserves album memberships, and resolves safe duplicates using Immich's `POST /duplicates/resolve` endpoint.

Never call Immich directly from the frontend. Never expose the Immich API key outside `apps/api`.

---

## Repository layout

```text
apps/api              Express API backend; owns all Immich SDK calls and write actions
apps/web              React/Vite frontend dashboard
packages/shared       Shared TypeScript types
packages/rule-engine  Pure duplicate-decision logic; no network or filesystem side effects
packages/immich-client Reserved for future Immich abstractions
````

---

## Development environment

Use WSL repo path:

```bash
/home/mike/dev/immich-dedupe
```

Do not work from the old Windows filesystem copy.

Use pnpm workspaces.

```bash
pnpm install
pnpm --filter api dev
pnpm --filter web dev
pnpm --filter api typecheck
pnpm --filter web typecheck
pnpm -r typecheck
```

Backend runs on:

```text
http://localhost:3001
```

Frontend runs on:

```text
http://localhost:5173
```

---

## Environment files

Backend:

```text
apps/api/.env
```

Required:

```env
PORT=3001
IMMICH_URL=http://<immich-host>:2283/api
IMMICH_API_KEY=<api-key>
```

Frontend:

```text
apps/web/.env
```

Required:

```env
VITE_API_BASE_URL=http://localhost:3001
```

Do not put Immich secrets in `apps/web/.env`.

---

## Immich API rules

Use `resolveDuplicates` for duplicate cleanup.

Correct SDK call:

```ts
await resolveDuplicates({
  duplicateResolveDto: {
    groups: [
      {
        duplicateId: group.groupId,
        keepAssetIds: [keepAsset.id],
        trashAssetIds: [trashAsset.id],
      },
    ],
  },
});
```

Do not use `deleteDuplicate` or `deleteDuplicates` for trashing duplicate assets. Those endpoints dismiss/ungroup duplicates; they do not trash assets.

Current required Immich API key permissions:

```text
asset.read
album.read
albumAsset.create
duplicate.read
duplicate.delete
```

`asset.delete` is not required for the current resolve-based workflow.

---

## Safety model

Only auto-resolve a duplicate group when all are true:

* exactly 2 assets
* one external and one internal asset
* same filename
* same resolution
* neither asset is edited
* neither asset is already trashed
* both file sizes are known
* external asset file size is larger
* decision confidence is 100

If any condition fails, return `uncertain` or `skip`.

---

## Rule engine boundaries

`packages/rule-engine` must stay pure.

Allowed:

* deterministic comparisons
* decision objects
* reason strings

Forbidden:

* Immich SDK imports
* fetch/network calls
* filesystem writes
* mutation of assets
* execution/logging logic

---

## Execution flow

Backend execution order:

1. fetch duplicate groups
2. normalize
3. enrich with file size from `asset.exifInfo.fileSizeInByte`
4. enrich with album memberships
5. evaluate rules
6. transfer missing album memberships to keep asset
7. call `resolveDuplicates`
8. verify trash asset state
9. write execution log

Successful resolve verification:

```json
{
  "isTrashed": true,
  "duplicateId": null
}
```

Trashed assets may still be readable through `GET /assets/:id`.

---

## Batch execution

Use separate limits:

```json
{
  "scanLimit": 100,
  "executeLimit": 5,
  "dryRun": true
}
```

Definitions:

* `scanLimit`: number of duplicate groups to inspect
* `executeLimit`: maximum eligible groups to dry-run or execute

Dry runs must not modify Immich and must not block later real execution.

Only real verified executions count as processed:

```ts
mode === "execute" &&
executed === true &&
resolvedDuplicate === true &&
trashedAsset === true
```

---

## Important backend routes

```http
GET  /health
GET  /execution/status?scanLimit=100
GET  /execution/plan?scanLimit=100
GET  /execution/log
POST /execution/run
GET  /execution/duplicates/:groupId/preview
POST /execution/duplicates/:groupId
```

`POST /execution/run` body:

```json
{
  "scanLimit": 100,
  "executeLimit": 5,
  "dryRun": true
}
```

---

## Frontend rules

The frontend is a control dashboard only.

It may call:

* `/execution/status`
* `/execution/plan`
* `/execution/log`
* `/execution/run`

It must not:

* call Immich directly
* contain the Immich API key
* duplicate backend rule logic
* execute without explicit confirmation
* default to large real execution batches

---

## Logging

Current execution log path:

```text
apps/api/src/execution-log.json
```

Preferred future path:

```text
apps/api/data/execution-log.json
```

Keep logs out of git.

Recommended `.gitignore` entries:

```gitignore
apps/api/.env
apps/web/.env
apps/api/src/execution-log.json
apps/api/src/execution-log.*.json
apps/api/data/
```

---

## Before changing code

1. Inspect existing files before editing.
2. Make the smallest safe change.
3. Do not rewrite unrelated files.
4. Preserve working backend behavior.
5. After edits, run relevant typechecks.
6. For execution logic changes, test with dry-run before real execution.

---

## Verification commands

Backend health:

```bash
curl http://localhost:3001/health
```

Execution status:

```bash
curl "http://localhost:3001/execution/status?scanLimit=100"
```

Execution plan:

```bash
curl "http://localhost:3001/execution/plan?scanLimit=100"
```

Dry run:

```bash
curl -X POST http://localhost:3001/execution/run \
  -H "Content-Type: application/json" \
  -d '{"scanLimit": 100, "executeLimit": 10, "dryRun": true}'
```

Small real run:

```bash
curl -X POST http://localhost:3001/execution/run \
  -H "Content-Type: application/json" \
  -d '{"scanLimit": 100, "executeLimit": 3}'
```

Check log:

```bash
curl http://localhost:3001/execution/log
```

Verify trashed asset:

```bash
curl http://localhost:3001/immich/assets/<TRASH_ASSET_ID>
```

Expected:

```json
"isTrashed": true,
"duplicateId": null
```

---

## Current development priorities

1. Finish Phase 6 hardening.
2. Verify `scanLimit` / `executeLimit` behavior.
3. Confirm `/execution/status` works.
4. Remove debug logs.
5. Build React/Vite dashboard in `apps/web`.
6. Add execution plan preview.
7. Add log filtering/export.
8. Add manual review later.

---

## Do not reintroduce

* `DELETE /duplicates/:id` as a trash/delete mechanism
* frontend Immich API calls
* frontend API keys
* broad asset deletion
* unsafe bulk execution defaults

```
```
