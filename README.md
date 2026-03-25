# Wavelet

[![Slack](https://badgen.net/badge/Slack/Join%20RisingWave/0abd59?icon=slack)](https://go.risingwave.com/slack)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![npm](https://img.shields.io/npm/v/@risingwave/wavelet)](https://www.npmjs.com/package/@risingwave/wavelet)
[![SKILL.md](https://img.shields.io/badge/SKILL.md-agent%20onboarding-black)](.claude/skills/wavelet/SKILL.md)

**The reactive backend for agents and apps.**

Write a SQL query. Subscribe to its result from your app or AI agent. When the underlying data changes, Wavelet pushes the recomputed result to every subscriber.

Built on [RisingWave](https://github.com/risingwavelabs/risingwave). By the RisingWave team.

## Use Cases

### Live Dashboards

Embed real-time, pre-computed KPIs directly into your app. Define aggregations, joins, and window functions in SQL. Wavelet pushes the computed result to every connected client, filtered per tenant via JWT.

```typescript
views: {
  revenue_by_tenant: {
    query: sql`
      SELECT tenant_id, SUM(revenue) AS total_revenue,
             COUNT(*) AS order_count
      FROM orders GROUP BY tenant_id
    `,
    filterBy: 'tenant_id',
  }
}
```

```typescript
const { data } = useWavelet('revenue_by_tenant')  // live, per-tenant, pre-computed
```

### Agent Watchdogs

AI agents subscribe to computed views via MCP and act when conditions are met. The agent gets pushed only the computed exceptions, not the firehose.

```typescript
views: {
  sla_violations: sql`
    SELECT order_id, customer_id, fulfillment_time_mins
    FROM order_status
    WHERE fulfillment_time_mins > 120
  `
}
```

An agent subscribes to `sla_violations` via MCP. When a new row appears, the agent triggers an escalation. No polling, no cron jobs.

### Usage Metering

Stream billing events, compute running totals per customer in SQL, push to both customer-facing dashboards and enforcement layers.

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
      SELECT customer_id, SUM(tokens) AS total_tokens,
             SUM(cost_usd) AS total_cost
      FROM api_calls GROUP BY customer_id
    `,
    filterBy: 'customer_id',
  }
}
```

Each customer sees only their own usage via JWT. Your billing service reads the same view via HTTP. Replaces a Kafka + Flink + Redis + custom WebSocket stack with a config file.

### Anomaly Alerts

Define thresholds in SQL. Get notified the moment a computed metric crosses them, not on the next poll cycle.

```typescript
views: {
  high_frequency_users: sql`
    SELECT user_id, COUNT(*) AS tx_count
    FROM transactions
    WHERE created_at > NOW() - INTERVAL '1 hour'
    GROUP BY user_id
    HAVING COUNT(*) > 100
  `
}
```

When a user crosses 100 transactions/hour, a row appears in the view. The subscription diff delivers it immediately. When they drop below, the row is deleted and the diff reflects that too.

### Live Inventory

Compute available stock from order streams, reservation holds, and warehouse updates. Push to every product page.

```typescript
views: {
  available_stock: sql`
    SELECT product_id,
           warehouse_qty - pending_orders - reserved AS available
    FROM inventory
    JOIN (SELECT product_id, COUNT(*) AS pending_orders FROM orders WHERE status = 'pending' GROUP BY product_id) o USING (product_id)
    JOIN (SELECT product_id, COUNT(*) AS reserved FROM reservations WHERE expires_at > NOW() GROUP BY product_id) r USING (product_id)
  `
}
```

### Multiplayer State

Compute shared state from a stream of user actions. Clients receive the authoritative computed result, no client-side conflict resolution needed.

```typescript
views: {
  board_summary: sql`
    SELECT board_id, column_name, COUNT(*) AS card_count,
           SUM(story_points) AS total_points
    FROM cards GROUP BY board_id, column_name
  `
}
```

Best for computed summaries (column counts, aggregated scores, progress bars). Not suited for sub-50ms latency requirements like cursor positions.

### Proactive Agents

An agent watches a portfolio. When a position's moving average crosses a threshold, it places an order.

```typescript
streams: {
  trades: {
    columns: {
      symbol: 'string', price: 'float',
      volume: 'int', ts: 'timestamp',
    }
  },
  orders: {
    columns: {
      symbol: 'string', side: 'string',
      qty: 'int', reason: 'string',
    }
  },
},

views: {
  ma_crossovers: sql`
    SELECT symbol, price,
           AVG(price) OVER (PARTITION BY symbol ORDER BY ts ROWS 50 PRECEDING) AS ma50,
           AVG(price) OVER (PARTITION BY symbol ORDER BY ts ROWS 200 PRECEDING) AS ma200
    FROM trades
    WHERE symbol IN ('AAPL', 'NVDA', 'TSLA')
    QUALIFY ma50 > ma200 AND
            LAG(ma50) OVER (PARTITION BY symbol ORDER BY ts) <= LAG(ma200) OVER (PARTITION BY symbol ORDER BY ts)
  `
}
```

The agent subscribes to `ma_crossovers` via MCP. A golden cross appears:

```
query_view("ma_crossovers")
-> [{ symbol: "NVDA", price: 142.50, ma50: 138.2, ma200: 137.9 }]

emit_event("orders", {
  symbol: "NVDA", side: "buy", qty: 100,
  reason: "MA50 crossed above MA200"
})
```

The order lands in the `orders` stream. A downstream view tracks open positions. The agent's dashboard updates.

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

**3. Start the React example app**

```bash
npm run build
npm exec vite -- --open /examples/react-leaderboard/
```

Then open `http://localhost:5173/examples/react-leaderboard/`.

The example lives in [`examples/react-leaderboard`](./examples/react-leaderboard/) and uses:
- `React` + `ReactDOM` in the browser
- `WaveletClient` from the local browser SDK build
- keyed row reconciliation by `player_id`

**4. Subscribe from your app**

```bash
npx wavelet generate   # generates .wavelet/client.ts with full types
```

```typescript
import { useWavelet } from './.wavelet/client'

function Leaderboard() {
  const { data, isLoading } = useWavelet('leaderboard')
  // data: { player_id: string, total_score: number, games_played: number }[]
  // Updates automatically via WebSocket

  if (isLoading) return <div>Loading...</div>

  return (
    <ul>
      {data.map((row) => (
        <li key={row.player_id}>{row.player_id}: {row.total_score}</li>
      ))}
    </ul>
  )
}
```

**5. Write events**

```typescript
await wavelet.streams.game_events.emit({
  player_id: 'alice',
  score: 42,
  event_type: 'win',
})
// Leaderboard recomputes. All clients receive the diff.
```

## SDK Example

Want a minimal browser example that uses the SDK directly instead of hand-written `fetch` and `WebSocket` calls?

Use [`examples/sdk-leaderboard`](./examples/sdk-leaderboard/):

```bash
npm install
npm run build
node packages/cli/dist/index.js dev --config examples/sdk-leaderboard/wavelet.config.ts
npm exec vite -- --open /examples/sdk-leaderboard/
```

Then open `http://localhost:5173/examples/sdk-leaderboard/`.

The page imports the browser ESM build from `packages/sdk/browser/index.browser.js` and demonstrates:
- `client.view('leaderboard').get()`
- `client.view('leaderboard').subscribe(...)`
- `client.stream('game_events').emit(...)`
- `client.stream('game_events').emitBatch(...)`

## React Example

Want the same leaderboard as a React app with keyed row reconciliation?

Use [`examples/react-leaderboard`](./examples/react-leaderboard/):

```bash
npm run build
node packages/cli/dist/index.js dev --config examples/react-leaderboard/wavelet.config.ts
npm exec vite -- --open /examples/react-leaderboard/
```

Then open `http://localhost:5173/examples/react-leaderboard/`.

This example:
- loads `React` and `ReactDOM` from `esm.sh`
- imports `initWavelet()` and `useWavelet()` from `packages/sdk/browser/react.js`
- uses the SDK React hooks for the initial fetch and live updates

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

Read [SKILL.md](.claude/skills/wavelet/SKILL.md) and follow the instructions to set up and use Wavelet.

## How It Works

```
App / Agent  <-  WebSocket  <-  Wavelet Server  <-  SQL cursor  <-  RisingWave
                                      |                                |
                                JWT filtering                   Incremental
                                + fan-out                       computation
```

1. You define **streams** (data in) and **views** (what to compute) in `wavelet.config.ts`
2. `wavelet dev` syncs config to RisingWave -- creates tables, materialized views, and subscriptions
3. When source data changes, RisingWave incrementally recomputes affected views
4. Wavelet maintains one cursor per view, fans out diffs to all connected clients
5. JWT claims filter rows per-client for multi-tenant isolation

Wavelet is stateless. All state lives in RisingWave.

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

## Project Structure

```
packages/
  config/    ->  @risingwave/wavelet         defineConfig, sql tag, types
  server/    ->  @risingwave/wavelet-server  WebSocket fan-out, cursor polling, JWT, HTTP API
  sdk/       ->  @risingwave/wavelet-sdk     TypeScript client + React hooks
  cli/       ->  @risingwave/wavelet-cli     CLI (init, dev, push, generate)
  mcp/       ->  @risingwave/wavelet-mcp     MCP server for AI agents
```

## License

Apache 2.0. See [LICENSE](./LICENSE).
