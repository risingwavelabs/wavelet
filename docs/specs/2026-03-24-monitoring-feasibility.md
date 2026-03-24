# Monitoring Use Cases: Feasibility Evaluation

**Date**: 2026-03-24
**Status**: Proposal

## Motivation

Wavelet positions itself as "real-time computed results for app developers." To validate this positioning and guide README/marketing messaging, we evaluated the most compelling reactive/real-time use cases and assessed Wavelet's differentiation against existing solutions (Firebase, Supabase, Pusher, Ably, Convex, Materialize, Liveblocks).

The core question: which use cases best demonstrate why *computed results* (not raw event push) matter, and where does Wavelet's architecture (SQL materialized views + WebSocket fanout + JWT filtering + MCP) create a defensible advantage?

## Design Overview

This document is a feasibility assessment, not a code change. It ranks 10 use cases by fit with Wavelet's architecture and recommends which to highlight.

## Ranked Use Cases

### Tier 1: Core Differentiators

#### 1. Live Dashboards

Embed real-time, pre-computed KPIs and metrics directly into an app.

- **Why Wavelet wins**: Competitors push raw row changes (Supabase) or raw events (Pusher/Ably). Wavelet pushes *computed results* -- aggregations, joins, window functions -- defined in SQL materialized views. A developer writes `SELECT tenant_id, SUM(revenue) ... GROUP BY ...` in their config and every connected client gets sub-second updates to the *result*. No one else offers "SQL-defined computed view, pushed over WebSocket, filtered per tenant via JWT" as a single primitive.
- **Feasibility**: Fully supported today. This is Wavelet's primary use case.

#### 2. Agent Watchdogs

AI agents subscribe to computed data changes via MCP and act autonomously when conditions are met.

- **Why Wavelet wins**: The MCP server package makes this native. An agent subscribes to a view like "orders where fulfillment_time > SLA_threshold" and gets pushed only the *computed exceptions*, not the firehose. Wavelet is the only product that gives agents computed, filtered, real-time views via MCP.
- **Feasibility**: Fully supported via `@risingwave/wavelet-mcp`. Rides the 2025-2026 agentic AI wave.

#### 3. Usage Metering

Stream billing events, compute running totals per customer in SQL, push real-time usage to app and enforcement layer.

- **Why Wavelet wins**: Usage-based billing (AI API calls, token counts, GPU hours) requires streaming aggregation -- summing events per customer per billing period. Wavelet defines this as a SQL materialized view and pushes results to both customer-facing dashboards and enforcement layers. JWT filtering means each customer sees only their own usage. Replaces a Kafka + Flink + Redis + custom WebSocket stack with a config file.
- **Feasibility**: Fully supported. Requires no new features.

### Tier 2: Strong Fit

#### 4. Anomaly Alerts

Define thresholds and patterns in SQL; get pushed only when computed metrics cross them.

- **Why Wavelet wins**: RisingWave's incremental computation means anomaly detection queries run continuously, not on a cron. A view like `SELECT user_id, COUNT(*) as tx_count ... HAVING tx_count > 100` produces rows only when the condition becomes true. The diff-based subscription notifies at the moment of crossing, not on the next poll cycle.
- **Feasibility**: Supported today. The `op` column (insert/delete) in subscription diffs naturally represents threshold crossings.

#### 5. Live Inventory

Compute available stock from order streams, reservation holds, and warehouse updates; push to every product page.

- **Why Wavelet wins**: Inventory is a *computed result*: `warehouse_stock - pending_orders - reserved_items`. This is a join + aggregation across multiple event streams -- exactly what materialized views excel at. JWT claims can filter by region or warehouse.
- **Feasibility**: Supported. HTTP POST API handles event ingestion from existing systems.

#### 6. Multiplayer State

Compute shared application state from a stream of user actions and broadcast consistent results.

- **Why Wavelet wins**: Unlike Liveblocks (CRDT-based, document-focused) or raw pub/sub (Pusher/Ably), Wavelet computes *derived state* from events. Clients receive the authoritative computed state -- no client-side conflict resolution needed.
- **Feasibility**: Supported, but latency depends on RisingWave's materialization speed. Not suitable for sub-50ms requirements (e.g., cursor positions). Best for computed summaries (leaderboards, column counts, aggregated scores).

### Tier 3: Viable Niche

#### 7. Personalization Feeds

Compute per-user content rankings from real-time interaction events; push updated recommendations as behavior changes.

- **Feasibility**: Supported but SQL-expressible ranking logic is limited compared to ML-based systems. Best for simple heuristic rankings.

#### 8. Workflow Monitors

Track multi-step processes as computed state machines; push progress to stakeholders.

- **Feasibility**: Supported. Strong agent crossover via MCP -- an agent subscribes to "deployments WHERE status = 'failed'" and triggers rollback.

#### 9. Feature Flags

Evaluate feature gates as computed views over user segments; push flag changes instantly.

- **Feasibility**: Supported as a zero-additional-infrastructure play for existing Wavelet users. Not compelling enough to adopt Wavelet for this alone.

#### 10. Dynamic Pricing

Compute prices from real-time supply/demand signals; push to storefronts.

- **Feasibility**: Supported but high-value niche. Most teams with dynamic pricing already have streaming infrastructure.

## Key Decisions

### Recommended README use cases

Highlight the top 5 (Live Dashboards, Agent Watchdogs, Usage Metering, Anomaly Alerts, Live Inventory). They:

1. Clearly demonstrate why *computed results* matter vs. raw event push
2. Map to real developer pain (polling, webhook complexity, Kafka+Flink overhead)
3. Span both the app developer and AI agent audiences Wavelet targets
4. Require no new features -- all are feasible with today's architecture

### What NOT to build

None of these use cases require new Wavelet features. The architecture already supports all of them. The gap is messaging and examples, not code.

### Potential future work

- **Example apps**: Add example configs for top use cases to `examples/`
- **Latency benchmarks**: Publish numbers for materialization-to-WebSocket latency to quantify the "sub-second" claim
- **Anomaly alert hooks**: Consider a server-side webhook trigger when a view diff matches a condition (avoids requiring a persistent WebSocket client for alerting)

## Trade-offs

- **SQL expressiveness ceiling**: Use cases 7 (personalization) and 10 (dynamic pricing) may outgrow what SQL can express. This is a RisingWave limitation, not Wavelet's.
- **Latency floor**: Use case 6 (multiplayer) is constrained by RisingWave's materialization latency (~100-500ms). Wavelet cannot compete with CRDTs for real-time cursor/presence.
- **No built-in alerting**: Use case 4 (anomaly alerts) requires a persistent subscriber. A future server-side webhook feature would make this zero-client.

## Competitive Landscape Summary

| Competitor | Model | Wavelet Advantage |
|-----------|-------|-------------------|
| Firebase/Supabase | Raw row changes via realtime | Wavelet pushes *computed* results, not row diffs |
| Pusher/Ably | Raw event pub/sub | Wavelet computes on the stream, not just relays |
| Convex | Reactive functions (JS) | Wavelet uses SQL (broader reach), no vendor lock-in |
| Materialize | Streaming SQL (no app layer) | Wavelet adds WebSocket fanout, JWT filtering, SDK, MCP |
| Liveblocks | CRDTs for collaboration | Wavelet computes authoritative state server-side |
