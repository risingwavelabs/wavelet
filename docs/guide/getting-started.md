# Getting Started

## Prerequisites

- Node.js >= 20
- RisingWave (local or remote)

## Install

```bash
npm install wavelet
```

## Initialize a project

```bash
npx wavelet init
```

This creates `wavelet.config.ts` in your current directory.

## Define your data

Edit `wavelet.config.ts`:

```typescript
import { defineConfig, sql } from 'wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

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

**Streams** define where data comes in. Each stream becomes a table in RisingWave.

**Views** define what to compute. Each view becomes a materialized view that RisingWave keeps up to date incrementally.

## Start the dev server

```bash
npx wavelet dev
```

This does three things:
1. Checks if RisingWave is running (starts it if not)
2. Syncs your streams and views to RisingWave
3. Starts the Wavelet server (HTTP + WebSocket)

## Write events

```bash
curl -X POST http://localhost:8080/v1/streams/game_events \
  -H "Content-Type: application/json" \
  -d '{"player_id":"alice","score":42,"event_type":"win"}'
```

Or from your app:

```typescript
await fetch('http://localhost:8080/v1/streams/game_events', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ player_id: 'alice', score: 42, event_type: 'win' }),
})
```

## Read results

```bash
curl http://localhost:8080/v1/views/leaderboard
```

The result is pre-computed. 1 caller or 10,000, the cost is the same.

## Subscribe to changes

```javascript
const ws = new WebSocket('ws://localhost:8080/subscribe/leaderboard')

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.type === 'diff') {
    console.log('Leaderboard updated:', msg.inserted, msg.updated, msg.deleted)
  }
}
```

Or with the React hook:

```typescript
import { useWavelet } from './.wavelet/client'

function Leaderboard() {
  const { data, isLoading } = useWavelet('leaderboard')
  // data updates automatically via WebSocket
}
```

## Generate typed client

```bash
npx wavelet generate
```

This creates `.wavelet/client.ts` with full TypeScript types derived from your view schemas. Your IDE and AI coding agents get autocomplete for every field.

## Next steps

- [Multi-tenant filtering](./multi-tenant.md) - JWT-based per-user data isolation
- [CLI reference](./cli.md) - All available commands
- [MCP integration](./mcp.md) - Use Wavelet from AI agents
