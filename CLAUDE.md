# Wavelet

Real-time computed results for app developers. Built on RisingWave.

## Project Structure

Monorepo using npm workspaces (`packages/*`, `examples/*`). Node >= 20.

| Package | Published name | Purpose |
|---------|---------------|---------|
| `packages/config` | `@risingwave/wavelet` | `defineConfig`, `sql` tag, shared types |
| `packages/server` | `@risingwave/wavelet-server` | WebSocket fanout, subscription cursor polling, JWT auth, HTTP API |
| `packages/sdk` | `@risingwave/wavelet-sdk` | TypeScript client + React hooks (`@wavelet/sdk/react`) |
| `packages/cli` | `@risingwave/wavelet-cli` | CLI binary (`wavelet push`, `wavelet dev`, codegen) |
| `packages/mcp` | `@risingwave/wavelet-mcp` | MCP server - exposes views and streams as AI agent tools |

Dependency graph: `config` is the leaf. `server` and `sdk` depend on `config`. `cli` depends on `server` and `config`. `mcp` depends on `config` and `pg`.

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

## Wavelet Cloud Integration

The closed-source **wavelet-cloud** project (`risingwavelabs/wavelet-cloud`)
uses this codebase as a library. It imports `WaveletServer` and `DdlManager`
to run a managed multi-tenant service. Changes to the interfaces below will
break wavelet-cloud.

### Stable interfaces (do not change without filing an issue on wavelet-cloud)

| Import | Used for |
|--------|----------|
| `WaveletServer` from `@risingwave/wavelet-server` | Create per-project server instances |
| `WaveletServer.attachTo(server, { pathPrefix })` | Attach to shared HTTP server with path prefix like `/p/{projectId}` |
| `WaveletServer.stop()` | Clean shutdown |
| `DdlManager` from `@risingwave/wavelet-server` | `connect()` → `sync(config)` → `close()` per-user DDL sync |
| `DdlAction` type from `@risingwave/wavelet-server` | Track DDL changes |
| `WaveletConfig` type from `@risingwave/wavelet` | Config serialization between CLI and cloud API |

### What wavelet-cloud does with these

1. User runs `wavelet-cloud deploy` with a `wavelet.config.ts`
2. Cloud creates a RisingWave database per user
3. Cloud calls `DdlManager.sync(config)` against that database
4. Cloud calls `WaveletServer.attachTo(sharedHttpServer, { pathPrefix: '/p/{projectId}' })`
5. End users access `https://wavelet-cloud.fly.dev/p/{projectId}/v1/...` and `/subscribe/...`

### If you need to change a stable interface

1. File an issue at https://github.com/risingwavelabs/wavelet-cloud/issues
2. Describe what changes and why
3. Coordinate before merging

### Package names

wavelet-cloud's `vendor/` directory pins specific builds of:
- `@risingwave/wavelet` (config types)
- `@risingwave/wavelet-server` (server + DDL manager)

If you rename packages again, wavelet-cloud's imports and vendor will break.

## Agent Communication (Stream0)

This agent uses Stream0 for cross-repo coordination with wavelet-cloud.

- **Stream0 URL**: `http://3.94.39.251:8080`
- **Agent ID**: `wavelet-agent`
- **Peer**: `wavelet-cloud`
- **Task IDs**:
  - `cross-repo-sync` - general status updates and interface changes
  - `breaking-change` - urgent: something will break if not addressed
  - `feature-request` - one repo requesting a feature from the other
  - `bug-report` - cross-repo bugs

### At session start

Check inbox for messages from wavelet-cloud:

```bash
curl -s "http://3.94.39.251:8080/agents/wavelet-agent/inbox?status=unread" \
  -H "X-API-Key: $STREAM0_API_KEY"
```

Acknowledge processed messages:

```bash
curl -s -X POST "http://3.94.39.251:8080/inbox/messages/{id}/ack" \
  -H "X-API-Key: $STREAM0_API_KEY"
```

### When making breaking changes

Send a notification to wavelet-cloud:

```bash
curl -s -X POST "http://3.94.39.251:8080/agents/wavelet-cloud/inbox" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $STREAM0_API_KEY" \
  -d '{"task_id":"cross-repo-sync","from":"wavelet-agent","type":"request","content":{"change":"description of what changed"}}'
```

The API key is stored in the environment variable `STREAM0_API_KEY`. Do not hardcode it.

## Testing

Framework: Vitest. Run with `npm test` or `npx vitest run`.

```bash
npm test          # run all tests
npx vitest        # watch mode
npx vitest run    # single run
```

Existing tests (in `packages/*/src/__tests__/`):
- `config`: sql template tag, defineConfig
- `server`: cursor diff parsing, JWT verification, HTTP API routes

Tests that require a running RisingWave (DDL manager, end-to-end WebSocket) are not yet automated.
