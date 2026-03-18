# CLI Reference

All commands are non-interactive and idempotent. Safe to run multiple times.

## `wavelet init`

Create a `wavelet.config.ts` in the current directory.

```bash
npx wavelet init
```

Skips if the file already exists.

## `wavelet dev`

Start a local development server. Syncs DDL, then starts the HTTP + WebSocket server.

```bash
npx wavelet dev
npx wavelet dev --config ./path/to/wavelet.config.ts
```

If RisingWave is not running, `wavelet dev` will attempt to start it automatically (native binary or Docker).

## `wavelet push`

Sync stream and view definitions to RisingWave without starting a server.

```bash
npx wavelet push
npx wavelet push --json     # structured output
```

The push command diffs your config against the current RisingWave state:
- Creates missing tables, materialized views, and subscriptions
- Drops removed views and their subscriptions
- Recreates views whose SQL has changed (drop + create)
- Drops orphaned tables only if no view depends on them

## `wavelet generate`

Generate a typed TypeScript client from your view and stream schemas.

```bash
npx wavelet generate
```

Creates `.wavelet/client.ts` with:
- TypeScript interfaces for each view's row type
- TypeScript interfaces for each stream's event type
- Typed client class with view and stream accessors
- React hook overloads with correct return types

Requires a running RisingWave instance (to introspect schemas).

## `wavelet status`

Show current configuration summary.

```bash
npx wavelet status
```

Displays: config file path, database URL (masked), stream count, view count, and view names.

## Common options

| Flag | Description |
|---|---|
| `--config <path>` | Path to wavelet.config.ts (default: `./wavelet.config.ts`) |
| `--json` | Output in JSON format (push command) |
| `--help` | Show help |
