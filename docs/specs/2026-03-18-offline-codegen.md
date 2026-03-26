# Offline Codegen

**Date**: 2026-03-18
**Status**: Implemented (v0.1.4)

## Motivation

`npx wavelet generate` previously required a running RisingWave instance to introspect view column types. This blocked the agent workflow: a coding agent couldn't generate typed clients without first starting infrastructure. For many use cases, the types are known at config time.

## Design

Three-tier type resolution:

### Tier 1: Config-declared columns (no RisingWave needed)

Queries can declare their output columns explicitly:

```typescript
queries: {
  leaderboard: {
    query: sql`SELECT user_id, SUM(score) AS total FROM events GROUP BY user_id`,
    columns: {
      user_id: 'string',
      total: 'int',
    }
  }
}
```

Generated type:
```typescript
export interface LeaderboardRow {
  user_id: string
  total: number
}
```

### Tier 2: RisingWave introspection (if reachable)

If no columns are declared and RisingWave is reachable, codegen introspects `information_schema.columns` as before. Connection attempt has a 3-second timeout.

### Tier 3: Generic fallback

If neither config columns nor RisingWave are available, the query gets `Record<string, unknown>`:

```typescript
export type RawViewRow = Record<string, unknown>
```

Query names are still typed as literals, so the agent at least knows which queries exist.

## Key decisions

- **Optional, not required**: The `columns` field on `QueryDef` is optional. Existing configs without it continue to work exactly as before.
- **No SQL parsing**: We considered parsing the SELECT clause to infer types. Too fragile - SQL has aliases, casts, functions, subqueries. Explicit declaration is more reliable.
- **Graceful degradation**: Connection failure doesn't crash codegen. It falls back silently to generic types. This means `npx wavelet generate` always succeeds.
- **Event types are always known**: Events declare their columns in the config, so event types never need RisingWave.

## Impact on agent workflow

Before:
```
npx wavelet generate   # FAILS if RisingWave not running
```

After:
```
npx wavelet generate   # ALWAYS succeeds
                       # Full types if columns declared or RisingWave running
                       # Generic types otherwise
```
