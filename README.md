# Wavelet

**Subscribe to computed results, not raw rows.**

Wavelet is a real-time backend that pushes pre-computed query results to your app over WebSocket. Define a SQL view, subscribe from your frontend — Wavelet keeps it up to date automatically.

Built on [RisingWave](https://github.com/risingwavelabs/risingwave), an incremental computation engine. By the RisingWave team.

## Why Wavelet

ClickHouse helps you compute fast. Supabase tells you data changed. **Wavelet tells you your computed result changed** — and delivers it to your app.

- **No polling** — results push to your app within 500ms of source data changes
- **Pre-computed** — 1 client or 10,000, query cost is the same
- **Typed** — codegen gives your IDE and AI agent full autocomplete
- **Filtered** — JWT-based per-tenant filtering, enforced server-side

## Quick Start

### 1. Install

```bash
npm install wavelet
```

### 2. Define your config

```typescript
// wavelet.config.ts
import { defineConfig, sql } from 'wavelet'

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

### 3. Generate typed client

```bash
npx wavelet generate
```

### 4. Use in your app

```typescript
import { useWavelet } from './.wavelet/client'

function Leaderboard() {
  const { data, isLoading } = useWavelet('leaderboard')
  // data: { player_id: string, total_score: number, games_played: number }[]
  // Updates automatically via WebSocket — no polling, no refetching

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

### 5. Write events

```typescript
await wavelet.streams.game_events.emit({
  player_id: 'alice',
  score: 42,
  event_type: 'win',
})
```

## How It Works

```
Your App ←— WebSocket —— Wavelet Server —— SQL cursor —— RisingWave
                              ↑                              ↑
                         JWT filter                   Incremental MV
                         + fanout                     computation
```

1. You define **streams** (where data comes in) and **views** (what to compute)
2. Wavelet creates materialized views in RisingWave and subscribes to their change streams
3. When source data changes, RisingWave recomputes the view incrementally
4. Wavelet fans out the diffs to connected clients over WebSocket
5. JWT claims are matched against view columns for per-tenant filtering

Wavelet is a thin orchestration layer. The heavy computation is done by RisingWave.

## Multi-Tenant Filtering

Define a `filterBy` column that maps to a JWT claim:

```typescript
views: {
  tenant_usage: {
    query: sql`
      SELECT tenant_id, SUM(tokens) AS tokens_today
      FROM llm_events
      GROUP BY tenant_id
    `,
    filterBy: 'tenant_id',
  }
}
```

A client with `{ tenant_id: "t1" }` in their JWT only receives diffs for `t1`. Enforced server-side — the client cannot override it.

## CLI

```bash
wavelet init       # Create wavelet.config.ts
wavelet generate   # Generate typed client at .wavelet/client.ts
wavelet dev        # Start local dev server
wavelet push       # Sync streams and views to RisingWave
wavelet status     # Show current config summary
```

All commands are non-interactive and idempotent. Supports `--json` for structured output.

## Run Locally

```bash
docker compose up     # Starts RisingWave + Wavelet
```

Then open `examples/leaderboard/index.html` in your browser.

## HTTP API

```
GET  /v1/health                  → { status: "ok" }
GET  /v1/views                   → { views: ["leaderboard", ...] }
GET  /v1/views/{name}            → { rows: [...] }
GET  /v1/views/{name}?key=value  → filtered result
POST /v1/streams/{name}          → write single event
POST /v1/streams/{name}/batch    → write batch of events
WS   /subscribe/{name}           → real-time diffs
```

## Project Structure

```
wavelet/
├── packages/
│   ├── config/    # defineConfig, sql tag, types (published as `wavelet`)
│   ├── server/    # WebSocket fanout + cursor polling + JWT + HTTP API
│   ├── sdk/       # TypeScript client + React hooks
│   └── cli/       # CLI tools (init, generate, dev, push)
├── examples/
│   └── leaderboard/
├── docker-compose.yml
└── wavelet.config.ts
```

## License

Apache 2.0 — see [LICENSE](./LICENSE).
