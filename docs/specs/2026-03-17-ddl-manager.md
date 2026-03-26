# DDL Manager

**Date**: 2026-03-17
**Status**: Implemented

## Motivation

Users define events and queries in `wavelet.config.ts`. These need to be synced to RisingWave as tables, materialized views, and subscriptions. Without a DDL manager, users would need to manually run SQL against RisingWave, which defeats the purpose of Wavelet.

## Design Overview

`DdlManager` connects to RisingWave, diffs the desired state (from config) against the actual state (from RisingWave catalogs), and applies the minimal set of DDL operations to converge.

### Sync algorithm

1. Query existing tables, materialized views, and subscriptions from RisingWave catalogs
2. For each event in config: CREATE TABLE if missing
3. For each query in config:
   - If missing: CREATE MATERIALIZED VIEW + CREATE SUBSCRIPTION
   - If SQL changed: DROP SUBSCRIPTION, DROP MV, CREATE MV, CREATE SUBSCRIPTION (in that order)
   - If unchanged: no-op (but ensure subscription exists)
4. For queries removed from config: DROP SUBSCRIPTION + DROP MV
5. For events removed from config: DROP TABLE (only if no MV depends on it)

### Catalog queries

```sql
-- Tables
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'

-- Materialized views (with definition for diff comparison)
SELECT name, definition FROM rw_catalog.rw_materialized_views
WHERE schema_name = 'public'

-- Subscriptions
SELECT name FROM rw_catalog.rw_subscriptions
WHERE schema_name = 'public'
```

## Key Decisions

### SQL normalization for comparison

View definitions from RisingWave may have different whitespace/formatting than what the user wrote. We normalize both sides by collapsing whitespace and lowercasing before comparison.

### Wavelet-prefixed subscriptions

All subscriptions created by Wavelet use the naming convention `wavelet_sub_{viewName}`. This ensures we only manage our own subscriptions and don't interfere with user-created ones.

### Safe table deletion

Tables are only dropped if no materialized view references them. This prevents accidentally breaking materialized views that depend on the table.

### Idempotent operations

All CREATE/DROP operations catch "already exists" / "does not exist" errors gracefully. Running `wavelet push` twice produces the same result.

## Usage

Used by both `wavelet push` (CLI) and `wavelet dev` (syncs before starting server).

```typescript
const ddl = new DdlManager(connectionString)
await ddl.connect()
const actions = await ddl.sync(config)  // returns list of actions taken
await ddl.close()
```
