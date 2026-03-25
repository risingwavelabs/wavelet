---
name: wavelet
description: Set up and configure Wavelet projects. Use when the user wants to add streams, views, or subscriptions to a wavelet.config.ts, integrate the Wavelet SDK or React hooks, or set up MCP for agent integration.
---

# Wavelet

Wavelet is a reactive backend that pushes pre-computed SQL query results to apps and AI agents over WebSocket.

## Core Concepts

- **Streams** -- event ingestion tables. Defined with typed columns.
- **Views** -- SQL materialized views that incrementally recompute when source data changes.
- **Subscriptions** -- WebSocket connections that receive diffs when a view changes.
- **filterBy** -- JWT-based per-tenant row filtering, enforced server-side.

## Config File: wavelet.config.ts

Everything is defined in a single config file. The full type signature:

```typescript
import { defineConfig, sql } from '@risingwave/wavelet'

export default defineConfig({
  database: 'postgres://root@localhost:4566/dev',

  streams: {
    // Event ingestion. Column types: 'string' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'
    events: {
      columns: {
        user_id: 'string',
        action: 'string',
        value: 'int',
        metadata: 'json',
        ts: 'timestamp',
      }
    }
  },

  // CDC from existing Postgres (optional)
  sources: {
    my_postgres: {
      type: 'postgres',
      connection: 'postgres://user:pass@host:5432/db',
      tables: ['users', 'products'],
    }
  },

  views: {
    // Simple view -- just SQL
    totals: sql`
      SELECT user_id, SUM(value) AS total
      FROM events GROUP BY user_id
    `,

    // View with per-tenant filtering
    tenant_metrics: {
      query: sql`
        SELECT tenant_id, COUNT(*) AS count
        FROM events GROUP BY tenant_id
      `,
      filterBy: 'tenant_id',
    },

    // View with explicit column types (enables offline codegen without RisingWave)
    stats: {
      query: sql`SELECT ...`,
      columns: { user_id: 'string', total: 'int' },
    },
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    // or: jwksUrl: 'https://.../.well-known/jwks.json'
    // optional: issuer, audience
  },

  server: {
    port: 8080,    // default
    host: '0.0.0.0',
  },
})
```

## CLI Commands

```bash
npx wavelet init       # Create wavelet.config.ts template
npx wavelet dev        # Sync config to RisingWave + start server (auto-starts RisingWave)
npx wavelet push       # Sync config to RisingWave without starting server
npx wavelet generate   # Generate typed client at .wavelet/client.ts
npx wavelet status     # Show config summary
```

All commands are idempotent.

## SDK Usage

After running `npx wavelet generate`, a typed client is available at `.wavelet/client.ts`.

### React

```typescript
import { useWavelet } from './.wavelet/client'

function Component() {
  const { data, isLoading, error } = useWavelet('view_name')
  // data is fully typed based on the view's columns
}
```

### TypeScript Client

```typescript
import { TypedWaveletClient } from './.wavelet/client'

const wavelet = new TypedWaveletClient({
  url: 'http://localhost:8080',
  token: 'jwt-token',  // or: () => getToken()
})

// Read view
const rows = await wavelet.views.view_name.get()

// Subscribe to live updates
const unsub = wavelet.views.view_name.subscribe({
  onData: (diff) => {
    // diff.inserted, diff.updated, diff.deleted
  },
})

// Write events
await wavelet.streams.stream_name.emit({ key: 'value' })
await wavelet.streams.stream_name.emitBatch([{ key: 'v1' }, { key: 'v2' }])
```

## HTTP API

```
GET  /v1/health                  -> { status: "ok" }
GET  /v1/views                   -> { views: [...] }
GET  /v1/views/{name}            -> { view: "name", rows: [...] }
GET  /v1/views/{name}?key=value  -> filtered rows
GET  /v1/streams                 -> { streams: [...] }
POST /v1/streams/{name}          -> { ok: true }
POST /v1/streams/{name}/batch    -> { ok: true, count: N }
WS   /subscribe/{name}           -> real-time diffs
```

## MCP Setup (for AI agents)

Add to your MCP config (Codex Desktop, Cursor, etc.):

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

Available tools: `list_views`, `query_view`, `list_streams`, `emit_event`, `emit_batch`, `run_sql`.

## SQL Patterns for Views

Views are standard SQL running on RisingWave. Key patterns:

```sql
-- Aggregation
SELECT user_id, SUM(amount) AS total FROM orders GROUP BY user_id

-- Windowed aggregation
SELECT user_id, COUNT(*) AS recent_orders
FROM orders WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY user_id

-- Threshold / alert (rows appear/disappear as condition changes)
SELECT user_id, COUNT(*) AS tx_count
FROM transactions GROUP BY user_id HAVING COUNT(*) > 100

-- Join streams with reference tables
SELECT o.*, u.name, p.category
FROM orders o JOIN users u ON o.user_id = u.id JOIN products p ON o.product_id = p.id

-- Window functions
SELECT symbol, price,
       AVG(price) OVER (PARTITION BY symbol ORDER BY ts ROWS 50 PRECEDING) AS ma50
FROM trades
```

## Common Tasks

### Add a new stream + view

1. Add stream columns to `wavelet.config.ts` under `streams`
2. Add a SQL view under `views` that queries the stream
3. Run `npx wavelet dev` (or `npx wavelet push` if server is already running)
4. Run `npx wavelet generate` to update the typed client

### Add per-tenant filtering

Use the object form for the view with `filterBy`:

```typescript
views: {
  my_view: {
    query: sql`SELECT tenant_id, ... FROM ... GROUP BY tenant_id`,
    filterBy: 'tenant_id',
  }
}
```

The `filterBy` column must appear in the SELECT. Clients with a JWT containing `{ tenant_id: "t1" }` only receive rows where `tenant_id = 't1'`.

### Ingest from existing Postgres

Add a CDC source:

```typescript
sources: {
  prod_db: {
    type: 'postgres',
    connection: process.env.POSTGRES_URL,
    tables: ['users', 'orders'],
  }
}
```

Tables become available in views as `prod_db_users`, `prod_db_orders`.
