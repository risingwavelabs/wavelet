# Wavelet

[![CI](https://github.com/risingwavelabs/wavelet/actions/workflows/ci.yml/badge.svg)](https://github.com/risingwavelabs/wavelet/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@risingwave/wavelet)](https://www.npmjs.com/package/@risingwave/wavelet)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Slack](https://badgen.net/badge/Slack/Join%20RisingWave/0abd59?icon=slack)](https://go.risingwave.com/slack)
[![SKILL.md](https://img.shields.io/badge/SKILL.md-agent%20onboarding-black)](skills/wavelet/SKILL.md)

**The reactive backend for agents and apps.**

Your app shouldn't poll for answers. Answers should flow to your app.

Wavelet lets you define a computation in SQL and subscribe to its result. When the underlying data changes, every connected app and AI agent receives the updated result automatically. No API to build, no cache to manage, no WebSocket to wire up.

```typescript
// Define what to compute
views: {
  revenue: {
    query: sql`SELECT tenant_id, SUM(amount) AS total FROM orders GROUP BY tenant_id`,
    filterBy: 'tenant_id',
  }
}

// Subscribe from your app
const { data } = useWavelet('revenue')
// data updates automatically. Each tenant sees only their own numbers.
```

Built on [RisingWave](https://github.com/risingwavelabs/risingwave). By the RisingWave team.

## Use Cases

### Real-time SaaS Dashboards

Your customers log in and see their own metrics updating live -- revenue, active users, API usage. One view definition, thousands of tenants, each isolated by JWT. Replaces a polling endpoint + cache + per-tenant auth check.

### Usage Metering and Billing

Stream API calls, aggregate tokens and cost per customer, push to both customer-facing dashboards and rate limiters. Same source of truth, no sync issues.

### Proactive Agents

AI agents subscribe to computed views via MCP and act autonomously when conditions change. An agent watches `sla_violations` -- rows appear when an order exceeds its SLA, disappear when resolved. The agent escalates, notifies, or triggers a remediation. No polling, no cron -- the agent reacts to computed state, not raw events.

## Quick Start

Install [RisingWave](https://docs.risingwave.com/docs/current/get-started/) and Wavelet:

```bash
curl -L https://risingwave.com/sh | sh   # install RisingWave
npm install @risingwave/wavelet           # install Wavelet
```

`wavelet dev` auto-starts RisingWave if the binary or Docker is available.

**1. Define your config**

```typescript
// wavelet.config.ts
import { defineConfig, sql } from '@risingwave/wavelet'

export default defineConfig({
  database: 'postgres://root@localhost:4566/dev',

  streams: {
    game_events: {
      columns: {
        player_id: 'string',
        score: 'int',
        event_type: 'string',
      }
    }
  },

  views: {
    leaderboard: sql`
      SELECT player_id, SUM(score) AS total_score, COUNT(*) AS games_played
      FROM game_events
      GROUP BY player_id
      ORDER BY total_score DESC
      LIMIT 100
    `,
  },
})
```

**2. Start dev server**

```bash
npx wavelet dev
```

**3. Try the example app**

```bash
npm run build
npx vite --open /examples/sdk-leaderboard/
```

See [`examples/sdk-leaderboard`](./examples/sdk-leaderboard/) for a working browser demo, or [`examples/react-leaderboard`](./examples/react-leaderboard/) for a React version.

**4. Subscribe from your own app**

```bash
npx wavelet generate   # generates .wavelet/client.ts with full types
```

```typescript
import { TypedWaveletClient } from './.wavelet/client'

const wavelet = new TypedWaveletClient({ url: 'http://localhost:8080' })

// read current state
const rows = await wavelet.views.leaderboard.get()

// subscribe to live updates
wavelet.views.leaderboard.subscribe({
  onData: (diff) => {
    console.log(diff.inserted, diff.updated, diff.deleted)
  }
})

// write events
await wavelet.streams.game_events.emit({
  player_id: 'alice',
  score: 42,
  event_type: 'win',
})
```

## Agent Integration (MCP)

AI agents query views and write events as tool calls.

```json
{
  "mcpServers": {
    "wavelet": {
      "command": "npx",
      "args": ["@risingwave/wavelet-mcp"],
      "env": {
        "WAVELET_DATABASE_URL": "postgres://root@localhost:4566/dev"
      }
    }
  }
}
```

| Tool | Description |
|---|---|
| `list_views` | List all materialized views with schemas |
| `query_view` | Query a view with optional filters |
| `list_streams` | List all event streams |
| `emit_event` | Write an event to a stream |
| `emit_batch` | Write a batch of events |
| `run_sql` | Execute a read-only SQL query |

## Agent Onboarding

```bash
npx skills add risingwavelabs/skills --skill wavelet
```

Or read [SKILL.md](https://github.com/risingwavelabs/skills/blob/main/skills/wavelet/SKILL.md) directly.

## Architecture

```
App / Agent  <-  WebSocket  <-  Wavelet Server  <-  SQL cursor  <-  RisingWave
                                      |                                |
                                JWT filtering                   Incremental
                                + fan-out                       computation
```

**Write path.** `POST /v1/streams/{name}` inserts directly into RisingWave. No queue, no buffer. 200 means the row is persisted. RisingWave recomputes affected views on its next barrier cycle (~1s by default), and Wavelet pushes the diff to subscribers. End-to-end latency from write to client update is typically 1-2 seconds.

**Stateless server.** Wavelet holds no persistent state. Cursor positions are in memory. On restart, cursors recover from RisingWave's subscription retention window (default 24h). During recovery, clients may receive duplicate diffs -- applications should handle updates idempotently (e.g. key by primary key, not append).

**Single cursor per view.** One subscription cursor feeds all connected clients. 1 client or 10,000 -- same RisingWave load.

**Config-driven DDL.** `wavelet.config.ts` is the source of truth. `wavelet dev` and `wavelet push` diff config against RisingWave and apply minimal changes (create/drop tables, materialized views, subscriptions).

**JWT-scoped delivery.** Views with `filterBy` match the column value against a JWT claim. Filtering is enforced server-side -- clients cannot override it. Views without `filterBy` broadcast all rows to all clients. For multi-tenant applications, omitting `filterBy` on a tenant-scoped view is a data leak -- Wavelet does not enforce this automatically.

**Failure modes.** If RisingWave goes down, cursor fetch returns an error and Wavelet retries after 1 second. Clients stay connected but receive no diffs until RisingWave recovers. If a WebSocket disconnects, the SDK reconnects with exponential backoff (1s to 30s) and resumes from the last cursor position. Each view has its own cursor and connection -- a slow view does not block other views.

## CLI

```bash
wavelet init       # Create wavelet.config.ts
wavelet dev        # Sync config + start dev server
wavelet push       # Sync config to RisingWave (no server)
wavelet generate   # Generate typed client at .wavelet/client.ts
wavelet status     # Show current config summary
```

All commands are idempotent. Supports `--json` for structured output.

## HTTP API

```
GET  /v1/health                  -> { status: "ok" }
GET  /v1/views                   -> list all views
GET  /v1/views/{name}            -> current rows
GET  /v1/views/{name}?key=value  -> filtered rows
GET  /v1/streams                 -> list all streams
POST /v1/streams/{name}          -> write single event
POST /v1/streams/{name}/batch    -> write batch of events
WS   /subscribe/{name}           -> real-time diffs
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
