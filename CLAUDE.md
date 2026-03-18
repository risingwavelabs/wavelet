# Wavelet

Real-time computed results for app developers. Built on RisingWave.

## Project Structure

Monorepo using npm workspaces (`packages/*`, `examples/*`). Node >= 20.

| Package | Published name | Purpose |
|---------|---------------|---------|
| `packages/config` | `wavelet` | `defineConfig`, `sql` tag, shared types |
| `packages/server` | `@wavelet/server` | WebSocket fanout, subscription cursor polling, JWT auth, HTTP API |
| `packages/sdk` | `@wavelet/sdk` | TypeScript client + React hooks (`@wavelet/sdk/react`) |
| `packages/cli` | `@wavelet/cli` | CLI binary (`wavelet push`, `wavelet dev`, codegen) |

Dependency graph: `config` is the leaf. `server` and `sdk` depend on `config`. `cli` depends on `server` and `config`.

## Build & Development

```bash
npm install                # install all deps
npm run build              # build all packages
npm run typecheck          # type-check all packages
npm run lint               # eslint across packages/

# Single package
npx tsc --build packages/config/tsconfig.json

# Dev server (tsx watch)
npx tsx packages/server/src/index.ts
# or
npm run dev                # runs server dev mode
```

Build order matters: **config -> server/sdk -> cli** (cli depends on server and config).

## Architecture

- Wavelet server wraps RisingWave's native Subscription cursor mechanism.
- One cursor per materialized view; server fans out diffs to WebSocket clients.
- JWT claims are matched against view `filterBy` columns for per-client row filtering.
- HTTP API: POST for event writes, GET for view reads.
- All persistent state lives in RisingWave. Wavelet server is stateless -- cursor positions are in memory and recover from RisingWave's subscription retention window on restart.

## Key Design Decisions

- **Single-tenant process**: One Wavelet server = one RisingWave connection = one user's views. Multi-tenancy is handled externally (by Wavelet Cloud), not inside this codebase.
- **Config-driven DDL**: `wavelet.config.ts` is the source of truth. `DdlManager.sync()` diffs config against RisingWave state and applies minimal changes (create/update/delete tables, MVs, subscriptions). `wavelet push` and `wavelet dev` both use this.
- **Agent-native DX**: Types over docs. Codegen output (`.wavelet/client.ts`) is the primary interface for app developers and AI agents. All view/stream names are literal types, not strings.
- **Idempotent operations**: All CLI commands and DDL operations are safe to run multiple times.
- **Stateless server**: No local SQLite, no state files.

## Documentation Requirements

Every major change must have a corresponding spec or design document in `docs/specs/`. This includes:

- New features
- Major refactors
- Architectural changes
- API changes (breaking or significant additions)
- New integrations

Each spec should include: motivation, design overview, key decisions, and any trade-offs. File naming: `YYYY-MM-DD-short-description.md` (e.g. `2026-03-17-ddl-manager.md`).

This is mandatory, not optional. Code without documentation for significant changes should not be considered complete.

## Coding Conventions

- TypeScript strict mode, ES2022 target, NodeNext module resolution.
- Imports use `.js` extension for NodeNext resolution: `import { foo } from './bar.js'`
- Use default import for pg: `import pg from 'pg'`
- No `console.log` in library code (server, sdk, config). Only allowed in CLI entry points and server startup.
- Error messages must be actionable -- include what went wrong AND how to fix it.
- License: Apache-2.0.

## RisingWave SQL Patterns

```sql
-- Create subscription from a materialized view
CREATE SUBSCRIPTION wavelet_sub_{viewName} FROM {viewName} WITH (retention = '24h');

-- Declare and fetch from subscription cursor
DECLARE cursor_name SUBSCRIPTION CURSOR FOR wavelet_sub_{viewName} SINCE {rw_timestamp};
FETCH 1000 FROM cursor_name;
CLOSE cursor_name;

-- op column in subscription rows indicates change type:
-- op=1: insert, op=2: delete, op=3: update (old value), op=4: update (new value)
```

## Upstream RisingWave Changes

Wavelet depends on RisingWave as its compute backend. When Wavelet needs a feature, bug fix, or behavior change in RisingWave that does not exist yet, file an issue directly at https://github.com/risingwavelabs/risingwave.

The issue should include:
- What Wavelet needs and why
- The specific RisingWave behavior that is missing or insufficient
- Suggested approach if known

This is the standard workflow - Wavelet is a first-party project in the RisingWave ecosystem and can request upstream changes.

## Testing

Not yet set up. Tests needed for: DDL manager, cursor parsing, JWT filtering, HTTP routes.
