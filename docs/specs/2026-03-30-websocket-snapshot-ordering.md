# WebSocket Snapshot Ordering

**Date**: 2026-03-30
**Status**: Implemented

## Motivation

Wavelet clients need an immediately usable initial result set when they subscribe to a query. Relying on diffs alone forces clients to hydrate from a separate read path and introduces a race where subscription diffs can arrive before the initial state is established.

## Design Overview

When a WebSocket client subscribes to `/subscribe/{queryName}`, the server now sends messages in this order:

1. `connected` acknowledgement
2. `snapshot` containing the current rows for the query
3. bootstrap `diff` messages read from a temporary `FULL` subscription cursor after the snapshot boundary
4. live `diff` messages for subsequent updates

Snapshot rows are filtered with the same `filterBy` JWT claim logic used for diff fanout.

## Key Decisions

### Snapshot is part of the WebSocket protocol

Initial hydration is a protocol concern, not a wavelet-cloud concern. All Wavelet clients benefit from a server-provided snapshot because it guarantees a consistent starting point before incremental updates begin.

### Buffer diffs until snapshot completes

The server marks each subscriber as ready only after the snapshot has been sent. Any diffs produced by the shared live cursor in the meantime are queued per subscriber and only flushed after the bootstrap cursor has advanced far enough to establish a handoff point, preventing the same write from appearing in both the snapshot and replayed diffs.

### Use RisingWave `FULL` cursors for bootstrap

Instead of issuing a standalone `SELECT`, Wavelet now opens a temporary `FULL` subscription cursor per connecting subscriber. This gives the server a snapshot plus the exact incremental changes after that snapshot boundary, which avoids replaying pre-subscribe changes twice.

### Reuse query filtering rules

JWT-filtered queries apply the same `filterBy` rule to snapshot rows and incremental diffs so clients never observe rows they would not be allowed to receive later.

### Surface snapshots in the TypeScript SDK

`@risingwave/wavelet-sdk` exposes the initial payload through `subscribe({ onSnapshot })`, and the React hooks now use the WebSocket snapshot as the initial hydration path when no extra HTTP-only filters are requested.

## Trade-offs

- New subscriptions open a temporary bootstrap cursor in addition to the shared live cursor.
- Subscribers briefly hold an in-memory queue of shared diffs while the bootstrap cursor establishes a clean handoff point.
- Clients now need to handle a `snapshot` message type, but this simplifies most real-time UIs because they can hydrate and subscribe through one connection.
