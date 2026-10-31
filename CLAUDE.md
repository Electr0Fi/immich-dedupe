# Immich Dedupe

A local TypeScript monorepo for safely analyzing and resolving Immich duplicate groups using deterministic rules and the Immich API.

## Tech Layers
- **Framework**: Express API + React/Vite frontend
- **Language**: TypeScript
- **Database**: JSON file logging (future DB planned)
- **Styling**: Plain CSS
- **Testing**: Node test runner with tsx, fake Immich dependencies, TypeScript typechecking

## Project Structure
```text
apps/
├── api/                 # Express backend, Immich SDK integration, execution engine
├── web/                 # React/Vite frontend dashboard
packages/
├── shared/              # Shared TypeScript types
├── rule-engine/         # Pure duplicate decision logic
└── immich-client/       # Reserved for future Immich abstractions
```

## Development
```bash
pnpm install                     # Install dependencies
pnpm --filter api dev           # Run backend API
pnpm --filter web dev           # Run frontend dashboard
pnpm --filter api typecheck     # Typecheck backend
pnpm --filter web typecheck     # Typecheck frontend
pnpm typecheck                  # Typecheck workspace and API test sources
pnpm test                       # Run isolated regression tests
pnpm lint                       # Frontend ESLint only
```

## Code Standards
- TypeScript strict mode
- Keep `packages/rule-engine` pure and side-effect free
- No direct Immich calls from the frontend
- Prefer explicit types over `any`
- Preserve working execution behavior when refactoring
- Use small, focused edits instead of rewriting large files
- Validate execution changes with dry-runs before real execution

## Project-Specific Rules
- All Immich SDK calls must happen inside `apps/api`
- Use `POST /duplicates/resolve` for duplicate cleanup
- Never use `DELETE /duplicates/:id` to trash assets
- Keep credentials out of frontend bundles and logs; the existing settings endpoint still returns the saved key and needs correction in a later change
- Album memberships must be transferred before resolving duplicates
- Duplicate execution must verify `isTrashed === true`
- Dry-runs must never modify Immich state
- Use separate `scanLimit` and `executeLimit` values

## Important Notes
- Backend environment variables live in `apps/api/.env`
- Frontend environment variables live in `apps/web/.env`
- Current execution log path is `apps/api/data/execution-log.json`
- Trashed assets may still be returned from `GET /assets/:id`
- Successful duplicate resolution results in:
  - `"isTrashed": true`
  - `"duplicateId": null`
- Automatic cleanup supports exactly two unlinked images under active published rules. Matching stored Immich checksums is the default; metadata inclusion needs explicit heuristic opt-in. Directory keeper preferences support same-source pairs; unknown required evidence and ties prevent automatic selection. Protected/unknown safety metadata, videos and Live Photos remain excluded.
- Execution defaults to dry-run, rechecks fresh data, verifies album preservation and resolution, and stops batches on failed or uncertain outcomes. Never retry mutations automatically.
- Keep the Welcome Current Functionality card, README.md, and PROJECT_GUIDE.md aligned whenever behavior changes.

## Common Mistakes to Avoid
- DON'T: Use `deleteDuplicate` or `DELETE /duplicates/:id` for asset cleanup
- DON'T: Expose the Immich API key to the frontend
- DON'T: Put Immich SDK logic inside React components
- DON'T: Treat `scanLimit` as execution count
- DON'T: Auto-resolve groups that fail any safety condition
- ALWAYS: Run dry-runs before real execution batches
- ALWAYS: Verify trashed asset state after execution
- ALWAYS: Preserve album memberships before resolving duplicates
- ALWAYS: Keep rule evaluation deterministic and side-effect free

## Changelog
- 2026-05-11: Condensed file contents

<!-- Template taken from https://www.gradually.ai/en/claude-md/ -->
- App factory: `apps/api/src/app.ts`; production startup: `apps/api/src/index.ts`. Inject dependencies for tests; never initialize the real SDK or touch production logs in tests.

- Both execution routes use `executionService.ts`; persist checkpoints before mutations. Recovery authority lives under `apps/api/data/execution-journal/` and is never cleared with display logs. Recheck/release only read Immich. Locking supports one API process per data directory; automatic retries/restoration remain unsupported.

- Rules drafts and immutable revisions live in the scoped lazy `rulesStore`; publishing invalidates old reviews/dry-runs. Preserve the frozen historical evaluator for journal v1–v3 validation; AND/OR reviewed runs write v5, with v4 semantics frozen. Every production execution route enforces active rules, although legacy live routes remain available without reviewed-plan authorization.
- Continued scans use a persistent advisory ID/fingerprint queue, not upstream offsets: Immich returns the complete duplicate list without pagination. Keep inspection budget, candidate target and Execute Limit distinct. Pending proposals require fresh full preparation and a new exact-selection dry-run; advisory reset never clears journal exclusions/quarantines.
- Startup persists rules and advisory scan state as `apps/api/data/rules.json` and `scan-progress.json`. Keep IO injected/lazy and API keys out of both. Full preparation may reuse its one membership snapshot; execution must still refetch current membership/assets/albums.

- Current resolution uses schema/engine 2 AND/OR requirements with exactly one keeper. No-match/ambiguity is excluded and flagged; unknown evidence defers. Convert old drafts/presets preserving priorities, then require publication; keep active revisions and historical v1–v4 journal semantics intact. New reviewed runs use v5.
