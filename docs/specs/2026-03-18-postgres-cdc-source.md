# Postgres CDC Source

**Date**: 2026-03-18
**Status**: Implemented (v0.1.4)

## Motivation

Many developers already have a Postgres database with data they want to compute over. Requiring them to re-ingest data through Wavelet's HTTP write API adds friction. CDC lets them keep their existing write path and get real-time materialized views over their existing data.

## Design

### Config

```typescript
export default defineConfig({
  database: 'postgres://root@localhost:4566/dev',
  sources: {
    mydb: {
      type: 'postgres',
      connection: 'postgresql://user:pass@host:5432/mydb',
      tables: ['orders', 'users'],
      slotName: 'wavelet_mydb',          // optional, default: wavelet_{sourceName}
      publicationName: 'wavelet_mydb_pub' // optional, default: wavelet_{sourceName}_pub
    }
  },
  queries: {
    order_totals: sql`
      SELECT user_id, SUM(amount) AS total_spent
      FROM mydb_orders
      GROUP BY user_id
    `,
  },
})
```

### Table naming

CDC tables in RisingWave are named `{sourceName}_{tableName}`. So `mydb` source with table `orders` creates `mydb_orders` in RisingWave. Views reference this name.

### DDL generated

For each table in a source, DdlManager generates:

```sql
CREATE TABLE IF NOT EXISTS mydb_orders (*)
WITH (
  connector = 'postgres-cdc',
  hostname = 'host',
  port = '5432',
  username = 'user',
  password = 'pass',
  database.name = 'mydb',
  schema.name = 'public',
  table.name = 'orders',
  slot.name = 'wavelet_mydb',
  publication.name = 'wavelet_mydb_pub'
)
```

The `(*)` syntax tells RisingWave to auto-detect columns from the source table.

## Key decisions

- **Connection string parsing**: Standard Postgres URL format. Schema extracted from `?schema=xxx` query param, defaults to `public`.
- **Slot/publication naming**: Defaults to `wavelet_{sourceName}` to avoid conflicts. Can be overridden for users who already have replication slots set up.
- **Source removal not implemented**: Dropping CDC sources requires careful cleanup (replication slots). Deferred to a later version.

## Prerequisites

The source Postgres database must have:
1. `wal_level = logical` in postgresql.conf
2. A user with replication privileges
3. The tables must have primary keys (required by RisingWave CDC)
