# Immich Dedupe

A local React/Express application for reviewing duplicate groups already identified by Immich and resolving eligible image pairs through the Immich API. It does not scan files or calculate image similarity itself.

## Current Functionality

### Available now

- Configure ordered comparison rules, presets and directory keeper preferences in **Rules**. Matching Immich checksums is enabled by default; metadata presets require explicit acknowledgement and activation. Each rule has an Enabled toggle beside its heading and a wider, left-aligned Name field. Draft edits take effect only after publication.
- Continue scanning additional groups in fixed-count or candidate-target mode, with an inspection budget separate from Execute Limit. Scan progress and unresolved pending candidates survive API restarts. Loading pending details creates a fresh review requiring a new dry-run.
- Optional **Quick Review** evaluates the duplicate-list response without per-image, album or thumbnail reads. Missing rule data remains unverified. Select provisional candidates and **Load selected details**, then dry-run and execute through the existing safety checks.

- Review duplicate groups already identified by Immich. Excluded review groups explain unsupported asset counts, missing groups and inconsistent membership separately. Each prepared group starts with its details collapsed; expand groups individually or use Expand All and Collapse All. Selection checkboxes stay visible.
- Compare keeper/loser thumbnails and metadata, include or exclude eligible groups, dry-run the exact selection, execute reviewed batches, and view or export batch logs as JSON or CSV. Select first N uses the review’s Execute Limit; Select All includes every eligible group in the prepared review and raises Execute Limit when needed, requiring a new dry-run. Review preparation shows live stages, checked/eligible/excluded counts and elapsed time. Cancel review stops early and retains fully checked groups as a usable partial review. Other pending requests show a spinner and status message.
- Check album membership before resolution and verify the result. Failed or uncertain operations stop the batch.
- Recheck group membership, asset details, file sizes, and album memberships before execution rather than relying on the preview cache.
- Single-group and batch execution share safety checks, logging, run/attempt IDs, and processed/quarantine exclusions. Overlapping execution, recovery, or log-clearing requests return HTTP 409 within one API process.
- Persist checkpoints before mutations and quarantine unfinished or uncertain attempts across restarts, including their group and selected asset IDs. Unrelated groups remain usable.
- Inspect recovery evidence in Logs, recheck outcomes without changing Immich, and explicitly allow a new attempt only after another fresh intact-pair check. Release does not run cleanup or override other quarantines.
- Clear display log entries without deleting recovery evidence, processed groups, or legacy exclusions.
- Read outcome summaries with hover/focus definitions, expandable technical details, and links to recovery. Dedupe restores the latest saved run for the current account when opened; use Refresh latest to check newer runs, including those from other tabs.
- Refresh duplicate previews independently of the reviewed selection and execution results. Connection failures explain how to check API access; use Refresh previews to retry after restoring connectivity. Missing API routes identify the failing endpoint and explain restart and routing checks.

### Automatic cleanup requirements

- Settings lists the API key permissions for connection checks, reviews, thumbnails and live cleanup. Thumbnails need `asset.view`; metadata access through `asset.read` alone is insufficient. See [Required Immich API key permissions](#required-immich-api-key-permissions).
- Exactly two unlinked images must satisfy the active published rules. Directory preferences choose which copy to keep; same-source pairs are supported. Unresolved keeper ties are excluded.
- Favorites, archived/offline assets, edited/trashed assets, linked Live Photo images, videos, and assets with incomplete safety information are excluded.
- Configure directory preferences in Rules, for example keep `/photos/originals` over `/photos/copies`. Matching is case-sensitive and respects directory boundaries; the current internal/external labels do not determine eligibility.
- Album additions must explicitly succeed and keeper memberships must be confirmed before resolution. Resolution must explicitly succeed, the loser must be confirmed trashed with its duplicate association cleared, and the keeper must remain untrashed.

### Current limitations

- Manual keeper selection and the dedicated History view are not available. Videos, Live Photos, groups larger than two, original downloads and decoded-pixel comparisons are unsupported.
- Reviews expire after 15 minutes and require rebuilding after reload/restart, publishing changed rules or an accepted live request. Legacy live API routes remain available and enforce active rules; they do not require a reviewed plan.
- Immich returns its complete duplicate list without pagination. Continued scanning avoids repeated checks of unchanged exclusions but does not reduce that list response. Metadata heuristics cannot guarantee identical content; AI similarity alone never qualifies.
- Album protection covers memberships visible to your configured Immich account. Operations are not transactional and may leave partial changes.
- Use one API instance per data directory. Multi-process locking, automatic retry/resumption, rollback, and restoration are not available. Investigate uncertain outcomes and recheck them before explicitly releasing a pair.
- Corrupt recovery storage disables execution and recovery-changing actions until repaired. The app never silently resets evidence or automatically promotes interrupted temporary files. Display logs are a separate audit view, not the recovery authority.
- Connection changes require an API restart. Test and save writes configuration; Clear form clears only the form. Reset preview cache clears browser scan previews only. Confirmation is a session-only browser preference; mandatory safety protections remain fixed, while comparison rules are edited in Rules. Configurable performance settings are not implemented.
- This is a trusted local tool: the API has no authentication, allows cross-origin requests, and the connection-settings endpoint returns the saved API key. Do not expose it as a public service.
- Only the latest run is restored; full History and automatic polling are not implemented. Older records show missing request/stop details as unknown. Unsaved partial-response evidence survives screen navigation during this browser session but cannot be restored after reload.
- Packaged deployment and CI are not configured. Narrow screens use a horizontal navigation bar.

## Configurable rules

Use **Rules** to edit a draft, enable or disable rules, change their order and choose keeper preferences. Conditions support filenames/stems/extensions, checksums, paths, MIME, sizes, dimensions, pixel count/aspect ratio, dates, selected EXIF fields and albums, with AND/OR groups. Operators are restricted to appropriate field types. Missing values stay unverified/deferred in both full and Quick Review; they cannot satisfy negative conditions or bypass mandatory protections. The first matching rule determines the outcome, and indeterminate earlier conditions defer the group.

The default **Identical files** preset compares valid stored Immich checksums and consistent metadata. It does not download or independently hash originals. Its directory preferences are seeded from the previous path configuration; adjust them to your actual paths. Ranking ties exclude the group instead of choosing arbitrarily.

**Matching name and dimensions** and **Resolution variants** presets are disabled initially, including on existing installations. Enable heuristic acknowledgement before activating metadata inclusion. These comparisons can include genuinely different images even when filenames match; the review distinguishes **Metadata match** from **Checksum match**. Similarity scores or thumbnails never establish content equality. Videos and groups larger than two remain excluded.

**Saved presets** contain the complete ordered rule set, including conditions, enabled states and keeper preferences. Select a preset to immediately replace all rules shown in the editor. **New preset** starts an empty editor; use **Add rule from template** or clone rules to build it. Enter a preset name and click **Save preset**: an existing name prompts to overwrite, while a new name prompts to create a separate preset. Names are trimmed and matched case-insensitively. Cancel leaves the editor and saved presets unchanged. **Delete preset** asks for confirmation and keeps the current editor and published rules. Presets persist in the scoped rules store across API restarts. Save changes before switching presets; loading another preset replaces unsaved editor contents. If another tab changes a preset, refresh the preset list and confirm again; refreshing preserves the editor.

If refreshing presets reports that saved preset data is missing, restart the API from the current checkout and retry **Refresh presets** (or **Retry loading rules** on initial load). This indicates an older or incompatible API response, not an empty preset list. Existing editor changes and loaded presets are preserved on failed refreshes. Check `VITE_API_BASE_URL` and reverse-proxy routing if the message persists.

Save draft preserves work without changing active decisions. Publish rules activates an immutable account/server-scoped revision and makes previous reviews and dry-run approval stale. Testing a draft against a prepared review includes all completed observed groups, including exclusions, without additional Immich reads or execution authorization. Mandatory protected-asset restrictions remain enforced for every rule and every execution route.

## Continued scanning

The WebUI offers **Inspect groups** (check up to the inspection budget) and **Find candidates** (stop at a candidate target or the inspection budget). Quick targets count provisional candidates; full targets count fully checked candidates. Execute Limit caps attempted eligible groups independently.

Each preparation or continuation fetches Immich's complete duplicate list once. The local queue tracks IDs, membership and observed metadata rather than offsets in an unstable server order. New and changed groups are queued behind existing unseen work. Unchanged exclusions can be reused only when all rule dependencies are available in fresh list metadata. Missing data and transient read failures remain reconsiderable, and **Recheck excluded groups** explicitly queues exclusions again.

Unresolved candidates stay in the visible pending list. Select pending groups and load their details to create a fresh full plan with current rules and safety checks; the saved proposal cannot execute or restore old approval. Dry-runs leave candidates pending. Successful execution and recovery quarantines remain authoritative. **Reset scan progress** clears advisory scan state, not logs, processed history or recovery evidence.

Production startup stores rules in `apps/api/data/rules.json` and advisory progress in `apps/api/data/scan-progress.json`, scoped by normalized Immich URL and account. Completed observations are flushed every 25 groups and before a terminal/cancelled response; a crash may lose recent read-only progress. Reviews and approvals themselves remain in memory for 15 minutes. Never confuse scan persistence with execution resumption.

API preparation requests optionally include `scan: { mode: "groups" }` or `scan: { mode: "candidates", candidateTarget: 100 }`, alongside `scanLimit` and `executeLimit`. Omit `scan` to retain the existing local first-N behavior. New rules/scan endpoints require the updated API: restart an idle API checkout and reload if a newer frontend reports a missing route, preserving all recovery files.

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
2. Open Rules, check directory preferences and publish any changes. Then open Dedupe, choose a scan mode and inspection budget, and set Execute Limit separately.
3. Click **Prepare review**. Follow live stages and counts, or click **Cancel review** to stop after outstanding reads settle and keep fully checked results. Compare the keeper/loser images, filenames, sources, dimensions, sizes, and named album changes. Group details start collapsed; use each group’s toggle or **Expand All** / **Collapse All** to inspect thumbnails, metadata, rule explanations and album actions. Use **Select first N** to select up to the review’s Execute Limit, or **Select All** to include all eligible groups in this prepared review. Select All raises Execute Limit when needed and requires a new dry-run; excluded groups remain unselectable.
4. Click **Dry-run selected**. Changing the selection clears approval. Proposed album transfers have not been performed.
5. Choose **Execute selected** after the dry-run passes. Confirm the selected group and album-addition counts. Execution rechecks current data and may stop if it changed.
6. Inspect the outcome and batch logs. Investigate `needs-verification` results before retrying; no mutation is automatically retried.

## Quick Review

Under Prepare review in Dedupe, enable **Quick Review** to scan more groups without fetching full details for every image. It is off by default and remembered across screen navigation for this browser session. Changing mode or manually editing limits clears the current review and approval.

Quick preparation makes one Immich duplicate-list request, selects the next groups in the continuing scan queue, checks processed/quarantined exclusions and evaluates the active rules using metadata already in that response. It skips additional group refetches, per-image requests, album reads and thumbnails. Counts come from the prepared result. Detailed Refresh previews and automatic detailed preview enrichment are disabled while this option is enabled. Reads already started before switching modes may finish; their late results are ignored.

Groups enter **Provisional candidates** only if available metadata satisfies every automatic rule. Missing/invalid safety information or data required by the active rule is listed as unverified, without fallback requests or assumptions that unknown states are safe. Album-dependent conditions remain unverified until full details are loaded. Unsupported group sizes and other exclusions retain specific reasons. Quick Review may identify fewer candidates than a full review when the duplicate response omits required data. The inspection budget bounds newly checked groups, and candidate mode may stop sooner when its target is reached; Immich's duplicate-list response itself may remain large.

1. Select candidates with their checkboxes, Select first N or Select All. In quick results, Select All locally raises Execute Limit if necessary.
2. Click **Load selected details**. The API verifies only this exact selection with fresh membership, image and album reads. Changed selections/metadata or new exclusions reject the entire upgrade, preserving quick results and explaining why. There are no replacement candidates or automatic retries.
3. Inspect the resulting full review, including proposed album changes, and perform **Dry-run selected**. Live execution still requires that exact selection's successful journaled dry-run and fresh checks.

Quick snapshots are scoped to the server/account, stored only in API memory for 15 minutes, with capacity 20 separately from full plans. They cannot be executed directly or used for image access. Successful detail loading creates a normal immutable full plan with its own 15-minute lifetime, containing exactly the selected groups and no inherited dry-run authorization. Keep/loser metadata and available checksums shown by the quick scan must still match; previously unfetched albums are treated as unknown until loaded. Reload/restart requires new preparation. Cancellation preserves completed quick results, which can still be selected for detail loading.

API: `POST /execution/quick-reviews` accepts the same validated limits as full preparation and returns `{ ok, quickReview }`; with `Accept: application/x-ndjson` it streams progress and a terminal `{ status, plan: null, quickReview }` result. It shares the existing preparation cancellation endpoint. `POST /execution/quick-reviews/:reviewId/prepare-plan` accepts `{ selectedGroupIds, executeLimit }` and returns `{ ok, plan }`. Invalid selection is 400, busy/scope/stale-selection conflicts are 409, expired/missing quick snapshots are 410, and unavailable identity/storage/upstream reads are 503. Quick preparation and detail loading share the coordinator lock. Full plans pin their rules revision, and configurable reviewed runs use journal v4; historical v1–v3 records remain readable. If an updated frontend reports a missing quick endpoint, restart the current API checkout, reload and prepare again.

## Required Immich API key permissions

In Immich, open **Account Settings → API Keys** and edit or create the key configured for this app. Enable these specific scopes for the full workflow; granting `all` is unnecessary. The mapping below is checked against Immich v2.7.5, matching this project's installed SDK. Your server must also support the endpoints used by the app.

| Permission | Purpose | Needed for |
| --- | --- | --- |
| `server.about` | Connection test, version information and header status (`GET /server/about`) | Connection |
| `user.read` | Account identity (`GET /users/me`) for scoped reviews, execution evidence and recovery | Read/review |
| `duplicate.read` | Duplicate previews and fresh membership checks (`GET /duplicates`) | Read/review |
| `asset.read` | Metadata, sizes, safety checks and result verification (`GET /assets/:id`) | Read/review |
| `asset.view` | Keeper/loser thumbnail images (`GET /assets/:id/thumbnail?size=thumbnail`) | Review images |
| `album.read` | List albums, read memberships and verify preservation (`GET /albums`, `GET /albums/:id`) | Read/review |
| `albumAsset.create` | Add the keeper to missing loser albums (`PUT /albums/assets`) | Live cleanup |
| `duplicate.delete` | Resolve the reviewed group and trash selected losers (`POST /duplicates/resolve`) | Live cleanup |

Previews, preparation, dry-runs and recovery reads need the first six permissions. Live cleanup additionally needs the last two. The `duplicate.delete` permission name does not change the cleanup endpoint: this app uses `POST /duplicates/resolve`. Immich also enforces the account's rights to the assets and albums: the account must be able to view the images, share/add the keeper to required albums and delete the selected loser. API scopes do not override those rights, including shared-album editor access.

**If thumbnails are unavailable:** enable **`asset.view`**. `asset.read` permits metadata, not thumbnail bytes. This app requests thumbnail size, so `asset.download` is not needed. After changing permissions, click **Prepare review** again; failed image placeholders do not retry automatically. If thumbnails still fail, verify that the account can view the images in Immich and that their thumbnails have been generated. Expired plans, unavailable servers and unsupported image responses can also cause the placeholder; it is not proof of a missing permission.

Permission edits on the same key are applied by Immich; no backend restart is needed solely for that edit. If you replace the configured key, use **Test and save** and restart this app's API (or update `apps/api/.env` and restart), then prepare a new review. The connection test checks `server.about`, not the complete permission set. Do not run live cleanup merely to test permissions.

Sources: Immich v2.7.5 [thumbnail endpoint](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/asset-media.controller.ts), [server](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/server.controller.ts), [user](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/user.controller.ts), [asset](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/asset.controller.ts), [album](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/album.controller.ts) and [duplicate](https://github.com/immich-app/immich/blob/v2.7.5/server/src/controllers/duplicate.controller.ts) controllers; [account access checks](https://github.com/immich-app/immich/blob/v2.7.5/server/src/utils/access.ts).

## Execution API behavior

Both execution POST routes default to dry-run. Send literal JSON `"dryRun": false` to run live operations. Non-boolean modes and limits that are not positive safe integers return HTTP 400.

Batch defaults are `scanLimit: 100` and `executeLimit: 10`; UI defaults are 100 and 5. Legacy `limit` supplies missing limits; explicit values take precedence independently.

Outcomes are `dry-run`, `succeeded`, `failed`, and `needs-verification`. Results include the failure stage, proposed albums, and confirmed transfers. A batch response includes `stoppedEarly` and `stopReason`. HTTP 200 does not mean every group succeeded. Post-resolution verification allows three read rounds one second apart; mutations are submitted at most once per attempt.

```bash
curl -X POST http://localhost:3001/execution/run \
  -H 'Content-Type: application/json' \
  -d '{"scanLimit":10,"executeLimit":1,"dryRun":true}'
```

Display logs live in `apps/api/data/execution-log.json`. Recovery records live separately under `apps/api/data/execution-journal/`, with journal v4 for configurable reviewed runs, v2 for legacy API runs and unchanged v1–v3 read support. Do not downgrade against a data directory containing newer journal versions. Both are ignored by Git. Preserve this directory: clearing display logs does not reset recovery or successful-history exclusions.

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

Legacy API runs use journal version 2; configurable reviewed runs use version 4, retaining immutable rules, plan evidence, selection order and the authorizing dry-run ID, plus request context and terminal report. Historical versions 1–3 remain readable with their original semantics. **Older application releases cannot read version 4 files: do not downgrade against the same journal directory.** Preserve all evidence when upgrading or troubleshooting.

Browser checks use Chromium and fake API responses only:

```bash
pnpm --filter web exec playwright install --with-deps chromium
pnpm test:ui
```

The test command starts a dedicated frontend server and intercepts backend requests; no real API or Immich server is needed. Settings diagnostics export the current form URL, key-configured flag, connection test result, and session confirmation preference; keys and unimplemented performance settings are omitted.

## Review exactly what will run

The WebUI uses **Prepare review → Dry-run selected → Execute selected**. Plans are scoped to the configured server/account and expire after 15 minutes. The API retains at most 20 plans in memory, evicting the oldest after expired entries. Reviews and selection survive screen navigation, but not browser reload or API restart. Changing limits requires rebuilding; changing selection clears dry-run approval. Live requests consume their plan, including accepted requests that later fail.

**Select first N** uses the effective Execute Limit shown in Controls. **Select All** selects all eligible candidates already checked in this review (including a cancelled partial review), not the whole library. If the candidate count exceeds the limit, the API returns a new immutable review with the larger limit, identical candidates/exclusions and the original preparation timestamps/expiry; the UI updates Execute Limit and clears dry-run approval. A failed expansion preserves the existing review and selection. Selecting all within the current limit is local and also clears approval.

Only the selected groups run, in review order, with no replacement groups, manual keeper changes, or automatic retries. All selected groups are revalidated before the first mutation, then checked again individually. Changed metadata, checksums, memberships, album names/actions, or exclusions require a new review. Separate Immich API calls remain nontransactional and external races remain possible.

`POST /execution/plans` accepts `scanLimit` and `executeLimit` (defaults 100/10), plus the optional continued `scan` configuration described above. `POST /execution/plans/:planId/run` accepts `selectedGroupIds` and `dryRun` (default true). Live execution requires a fully recorded successful dry-run of that exact selection. Invalid input returns 400, busy/stale/unauthorized selections 409, unavailable/expired/consumed plans 410, and unavailable evidence or upstream reads 503.

`GET /execution/plans/:planId/assets/:assetId/thumbnail` proxies only reviewed assets for the current connection, using backend credentials and no-store responses. Missing image permissions or unavailable thumbnails show placeholders without changing eligibility. No original images are requested.

The WebUI uses planned execution exclusively. Legacy batch/single-group API routes remain available without reviewed-plan authorization, but now enforce the active configured rules. Universal reviewed live execution remains deferred.

Review preparation supports streamed progress through `POST /execution/plans` with `Accept: application/x-ndjson`; other callers retain the JSON response. Events report progress and one terminal result (completed/cancelled with a plan, or cancelled without a plan before scanning) or sanitized error. `POST /execution/preparations/:preparationId/cancel` requests cancellation without competing for the coordinator lock. The lock stays held until outstanding read batches settle and the partial plan is finalized; unfinished groups are omitted. Partial reviews retain the usual expiry, scope, dry-run authorization and fresh execution checks. Cancellation is confirmed only by the terminal preparation result, not by closing the connection. Reload/restart restoration, automatic reconnection, mutation cancellation and time-remaining estimates are not implemented.

`POST /execution/plans/:planId/select-all` accepts an empty body and returns the existing `{ ok, plan }` response shape with a new plan ID and `executeLimit = max(original limit, eligible candidate count)`. It shares the coordinator lock and checks identity, scope and plan availability. It preserves the reviewed snapshot and expiry, carries no dry-run authorization and makes no Immich mutations. Errors use 400 for invalid input, 409 for busy/scope conflicts, 410 for unavailable plans and 503 for identity/storage unavailability. The existing run endpoint continues to enforce each plan's limit and exact-selection dry-run approval.

Prepared review rows, including excluded groups, hide their details by default. Each details toggle works with mouse or keyboard and exposes its expanded state to assistive technology. Expand All / Collapse All only affect visibility; they preserve selection, Execute Limit and dry-run approval. A different plan or reopening Dedupe starts collapsed again. Optional asset ID/path disclosures remain independently expandable inside group details.

If Select All or another Dedupe action returns a generic HTTP 404, check for a stale API process or incorrect API/proxy routing. The UI identifies the missing method/path. Stop and restart the backend from the current checkout with `pnpm --filter api dev`, reload the browser and prepare a new review; restarting clears in-memory reviews. A successful `/health` response only establishes liveness, not that the running API includes the latest routes. Confirm the browser's `VITE_API_BASE_URL` points to the intended Dedupe API and any reverse proxy forwards the full `/execution/plans/:planId/select-all` path. Do not bypass the plan limit or use legacy live execution as a workaround. A structured not-found or expired-plan response retains its own explanation and is not automatically diagnosed as a missing route.

Review exclusion messages distinguish unsupported group sizes from changed or inconsistent membership. For example: “3 assets in group; current rule definitions only support exactly 2 assets per group.” A stable group of three or more assets is excluded because of the two-asset rule, not reported as having changed. Missing groups, repeated group entries, repeated asset IDs and a keeper/loser no longer present each receive a specific explanation. These messages do not change eligibility or execution safeguards.
