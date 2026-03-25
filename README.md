# Wavelet

[![CI](https://github.com/risingwavelabs/wavelet/actions/workflows/ci.yml/badge.svg)](https://github.com/risingwavelabs/wavelet/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@risingwave/wavelet)](https://www.npmjs.com/package/@risingwave/wavelet)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![Slack](https://badgen.net/badge/Slack/Join%20RisingWave/0abd59?icon=slack)](https://go.risingwave.com/slack)
[![SKILL.md](https://img.shields.io/badge/SKILL.md-agent%20onboarding-black)](.agents/skills/wavelet/SKILL.md)

**The reactive backend for agents and apps.**

Write a SQL query. Subscribe to its result from your app or AI agent. When the underlying data changes, Wavelet pushes the recomputed result to every subscriber.

Built on [RisingWave](https://github.com/risingwavelabs/risingwave). By the RisingWave team.

## What Wavelet Does

Most real-time tools push **row changes** -- "a row was inserted into the orders table." Wavelet pushes **computed results** -- "revenue for tenant A is now $12,450."

You define the computation as a SQL materialized view. RisingWave maintains it incrementally. Wavelet fans out diffs to connected clients over WebSocket, filtered per tenant via JWT claims.

```
Events in -> RisingWave (incremental SQL) -> Wavelet (fan-out + JWT filter) -> Your app / AI agent
```

## Use Cases

### Real-time SaaS Dashboards

Your customers log in and see their own metrics updating live. Revenue, active users, API usage -- computed server-side, pushed per-tenant, no polling.

```typescript
streams: {
  orders: {
    columns: {
      tenant_id: 'string', amount: 'float',
      product_id: 'string', ts: 'timestamp',
    }
  }
},

views: {
  tenant_revenue: {
    query: sql`
      SELECT tenant_id,
             SUM(amount) AS total_revenue,
             COUNT(*) AS order_count,
             SUM(amount) FILTER (WHERE ts > NOW() - INTERVAL '24 hours') AS revenue_24h
      FROM orders GROUP BY tenant_id
    `,
    filterBy: 'tenant_id',
  }
}
```

A client with `{ tenant_id: "acme" }` in their JWT sees only Acme's numbers. One view, thousands of tenants, each isolated by JWT. The alternative is writing a polling endpoint, a caching layer, and a per-tenant authorization check -- Wavelet replaces all three.

### Usage Metering and Billing

Every API call, every token, every GPU second -- streamed in, aggregated per customer, pushed to dashboards and enforcement layers in real time.

```typescript
streams: {
  api_calls: {
    columns: {
      customer_id: 'string', model: 'string',
      tokens: 'int', cost_usd: 'float',
    }
  }
},

views: {
  customer_usage: {
    query: sql`
      SELECT customer_id,
             SUM(tokens) AS total_tokens,
             SUM(cost_usd) AS total_cost,
             COUNT(*) AS total_requests
      FROM api_calls GROUP BY customer_id
    `,
    filterBy: 'customer_id',
  }
}
```

Your customer-facing usage page subscribes via WebSocket. Your rate limiter reads the same view via HTTP. Same source of truth, no sync issues.

### Agent Watchdogs

AI agents subscribe to computed views via MCP and act when conditions are met. The agent receives only the exceptions, not the firehose.

```typescript
views: {
  sla_violations: sql`
    SELECT order_id, customer_id,
           fulfillment_time_mins,
           fulfillment_time_mins - 120 AS overdue_by_mins
    FROM order_status
    WHERE fulfillment_time_mins > 120
  `
}
```

An agent subscribes to `sla_violations` via MCP. When a new row appears, the agent escalates. When the issue is resolved, the row disappears from the view and the agent sees the delete diff. No polling, no cron, no stale alerts.

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

Read [SKILL.md](.agents/skills/wavelet/SKILL.md) and follow the instructions to set up and use Wavelet.

## Architecture

```
App / Agent  <-  WebSocket  <-  Wavelet Server  <-  SQL cursor  <-  RisingWave
                                      |                                |
                                JWT filtering                   Incremental
                                + fan-out                       computation
```

**Stateless server.** Wavelet holds no persistent state. Cursor positions are in memory and recover from RisingWave's subscription retention window on restart.

**Single cursor per view.** One subscription cursor feeds all connected clients. 1 client or 10,000 -- same RisingWave load.

**Config-driven DDL.** `wavelet.config.ts` is the source of truth. `wavelet dev` and `wavelet push` diff config against RisingWave and apply minimal changes (create/drop tables, materialized views, subscriptions).

**JWT-scoped delivery.** Views with `filterBy` match the column value against a JWT claim. Filtering is enforced server-side -- clients cannot override it.

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
