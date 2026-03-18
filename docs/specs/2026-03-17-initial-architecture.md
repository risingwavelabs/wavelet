# Wavelet Initial Architecture

**Date**: 2026-03-17
**Status**: Implemented

## Motivation

RisingWave is a streaming database for data engineers. App developers (frontend, full-stack, indie) have no low-friction path to use it. Wavelet bridges this gap by exposing RisingWave's incremental computation through WebSocket, HTTP APIs, and typed SDKs.

## Design Overview

Wavelet is a thin orchestration layer on top of RisingWave. It does not do computation - RisingWave does. Wavelet handles:

1. **WebSocket fanout** - wraps RisingWave's `FETCH cursor` loop into persistent WebSocket connections
2. **JWT-based result filtering** - extracts claims from client tokens, filters diffs server-side before forwarding
3. **HTTP event write API** - accepts JSON over HTTP, writes to RisingWave tables
4. **Typed SDKs** - TypeScript client with React hooks, codegen from view schemas

## Key Decisions

### Single cursor per view, internal fanout

Wavelet maintains one RisingWave subscription cursor per materialized view, not one per client. Diffs are fanned out in-memory to all connected WebSocket clients for that view. This minimizes load on RisingWave.

### Config-driven DDL

`wavelet.config.ts` is the single source of truth. The `DdlManager` diffs config against RisingWave state and applies minimal changes. Users never write SQL directly against RisingWave.

### Single-tenant process

The open-source Wavelet server is a single-tenant process: one connection string, one set of views. Multi-tenancy (database-level isolation, resource groups) is handled by Wavelet Cloud externally.

### Agent-native DX

The SDK uses codegen (`npx wavelet generate`) to produce fully typed clients. View and stream names are literal types, not strings. This makes the SDK usable by AI coding agents through type inference alone.

## Trade-offs

- **No streaming writes**: HTTP write API is request-response, not streaming. Sufficient for app developers; high-throughput pipelines should use RisingWave directly.
- **In-memory cursor state**: Cursor positions are held in memory. On restart, they recover from RisingWave's subscription retention window. Some diffs may be replayed.
- **SQL in config**: Views are defined as raw SQL strings in the config file. This gives full SQL expressiveness but no compile-time validation of the SQL itself.

## Multi-tenancy Architecture (for Wavelet Cloud)

- Open-source: single RisingWave instance, single database
- Cloud: single RisingWave cluster, one database per Wavelet user
- RisingWave's database-level isolation provides namespace, checkpoint, and error recovery isolation
- Resource groups provide compute isolation between databases
- JWT filtering provides end-user (tenant) isolation within a single Wavelet user's app
- Two layers: database isolation (between Wavelet users) + JWT filtering (between end-user tenants)
