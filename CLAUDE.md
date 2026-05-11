# Immich Dedupe

A local TypeScript monorepo for safely analyzing and resolving Immich duplicate groups using deterministic rules and the Immich API.

## Tech Layers
- **Framework**: Express API + React/Vite frontend
- **Language**: TypeScript
- **Database**: JSON file logging (future DB planned)
- **Styling**: Plain CSS
- **Testing**: Manual curl/API verification + TypeScript typechecking

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
pnpm -r typecheck               # Typecheck entire monorepo
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
- Frontend must never contain Immich API keys
- Album memberships must be transferred before resolving duplicates
- Duplicate execution must verify `isTrashed === true`
- Dry-runs must never modify Immich state
- Use separate `scanLimit` and `executeLimit` values

## Important Notes
- Backend environment variables live in `apps/api/.env`
- Frontend environment variables live in `apps/web/.env`
- Current execution log path is `apps/api/src/execution-log.json`
- Trashed assets may still be returned from `GET /assets/:id`
- Successful duplicate resolution results in:
  - `"isTrashed": true`
  - `"duplicateId": null`
- External assets are preferred over internal/imported copies

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