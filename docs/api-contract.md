# Wavelet API Contract

This document defines the stable interfaces that external consumers (wavelet-cloud, third-party integrations) depend on. Changes to these interfaces are **breaking changes** and must be communicated before merging.

## Consumers

- `wavelet-cloud` repo: uses `WaveletServer.attachTo()`, depends on npm packages
- End-user apps: use SDK, HTTP API, WebSocket protocol

## WaveletServer API (used by wavelet-cloud)

```typescript
class WaveletServer {
  constructor(config: WaveletConfig)

  // Standalone mode: creates its own HTTP server
  start(): Promise<void>
  stop(): Promise<void>

  // Attached mode: mounts on an existing HTTP server (used by wavelet-cloud)
  attachTo(server: Server, opts?: { pathPrefix?: string }): Promise<{
    handleHttp: (req: IncomingMessage, res: ServerResponse) => void
  }>
}
```

## WaveletConfig schema

```typescript
interface WaveletConfig {
  database: string
  streams?: Record<string, { columns: Record<string, ColumnType> }>
  views?: Record<string, ViewDef | SqlFragment>
  jwt?: { secret?: string; jwksUrl?: string; issuer?: string; audience?: string }
  server?: { port?: number; host?: string }
}
```

## HTTP API routes

```
GET  /v1/health                  -> { status: "ok" }
GET  /v1/views                   -> { views: string[] }
GET  /v1/views/{name}            -> { view: string, rows: object[] }
GET  /v1/streams                 -> { streams: string[] }
POST /v1/streams/{name}          -> { ok: true }
POST /v1/streams/{name}/batch    -> { ok: true, count: number }
```

Error responses: `{ error: string, available_views?: string[], available_streams?: string[], routes?: string[] }`

## WebSocket protocol

Connect: `ws://host/subscribe/{viewName}?token={jwt}&cursor={cursor}`

Messages (server to client):
```json
{ "type": "connected", "view": "viewName" }
{ "type": "diff", "view": "viewName", "cursor": "123", "inserted": [...], "updated": [...], "deleted": [...] }
```

Close codes:
- 4000: server rejected (auth error, view not found). Reason in close message.
- 1001: server shutting down

## DdlManager API (used by wavelet-cloud provisioner)

```typescript
class DdlManager {
  constructor(connectionString: string)
  connect(): Promise<void>
  sync(config: WaveletConfig): Promise<DdlAction[]>
  close(): Promise<void>
}

interface DdlAction {
  type: 'create' | 'update' | 'delete' | 'unchanged'
  resource: 'stream' | 'view' | 'subscription'
  name: string
  detail?: string
}
```

## npm package names

| Package | Name |
|---|---|
| Config/types | `@risingwave/wavelet` |
| Server | `@risingwave/wavelet-server` |
| SDK | `@risingwave/wavelet-sdk` |
| CLI | `@risingwave/wavelet-cli` |
| MCP | `@risingwave/wavelet-mcp` |

## Breaking change policy

Any change to the interfaces above requires:
1. A GitHub issue labeled `breaking-change` filed on both wavelet and wavelet-cloud repos
2. A version bump (minor version for pre-1.0)
3. Both repos updated before merging
