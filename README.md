# Wavelet

**The reactive backend for agents and apps.**

Write a SQL query. Subscribe to its result from a React component or an AI agent. When the underlying data changes, Wavelet pushes the recomputed result to every subscriber.

Built on [RisingWave](https://github.com/risingwavelabs/risingwave). By the RisingWave team.

## Examples

**Live leaderboard** — ranks recompute on every score submission, all clients see the update:

```typescript
views: {
  leaderboard: sql`
    SELECT player_id, SUM(score) AS total_score, COUNT(*) AS games_played
    FROM game_events GROUP BY player_id
    ORDER BY total_score DESC LIMIT 100
  `
}
```

```typescript
const { data } = useWavelet('leaderboard')  // re-renders on rank changes
```

**Per-tenant LLM cost tracking** — each tenant sees only their own usage via JWT filtering:

```typescript
views: {
  tenant_usage: {
    query: sql`
      SELECT tenant_id, SUM(cost_usd) AS total_cost,
             SUM(tokens_in + tokens_out) AS total_tokens
      FROM llm_events GROUP BY tenant_id
    `,
    filterBy: 'tenant_id',
  }
}
```

**Operational metrics** — error rates, latency percentiles, grouped by endpoint:

```typescript
views: {
  api_health: sql`
    SELECT endpoint, COUNT(*) AS requests,
           AVG(latency_ms)::INT AS avg_latency,
           SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS errors
    FROM api_events GROUP BY endpoint
  `
}
```

All three work the same way: define a SQL view, subscribe from your app or agent, get live updates. The view is incrementally maintained by RisingWave — not re-queried on every change.

## Quick Start

```bash
npm install @risingwave/wavelet
```

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

**3. Subscribe from your app**

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

**4. Write events**

```typescript
await wavelet.streams.game_events.emit({
  player_id: 'alice',
  score: 42,
  event_type: 'win',
})
// Leaderboard recomputes. All clients receive the diff.
```

## Agent Integration (MCP)

AI agents can query views and write events as tool calls — no HTTP client needed.

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

## How It Works

```
App / Agent  ←  WebSocket  ←  Wavelet Server  ←  SQL cursor  ←  RisingWave
                                    │                                │
                              JWT filtering                  Incremental
                              + fan-out                      computation
```

1. You define **streams** (data in) and **views** (what to compute) in `wavelet.config.ts`
2. `wavelet dev` syncs config to RisingWave — creates tables, materialized views, and subscriptions
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
GET  /v1/health                  → { status: "ok" }
GET  /v1/views                   → list all views
GET  /v1/views/{name}            → current rows
GET  /v1/views/{name}?key=value  → filtered rows
GET  /v1/streams                 → list all streams
POST /v1/streams/{name}          → write single event
POST /v1/streams/{name}/batch    → write batch of events
WS   /subscribe/{name}           → real-time diffs
```

## Run Locally

```bash
docker compose up     # Starts RisingWave + Wavelet
```

## Project Structure

```
packages/
  config/    →  @risingwave/wavelet         defineConfig, sql tag, types
  server/    →  @risingwave/wavelet-server  WebSocket fan-out, cursor polling, JWT, HTTP API
  sdk/       →  @risingwave/wavelet-sdk     TypeScript client + React hooks
  cli/       →  @risingwave/wavelet-cli     CLI (init, dev, push, generate)
  mcp/       →  @risingwave/wavelet-mcp     MCP server for AI agents
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
