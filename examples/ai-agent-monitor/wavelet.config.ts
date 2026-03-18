import { defineConfig, sql } from 'wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

  streams: {
    llm_events: {
      columns: {
        tenant_id: 'string',
        model: 'string',
        tokens_in: 'int',
        tokens_out: 'int',
        cost_usd: 'float',
        latency_ms: 'int',
      }
    }
  },

  views: {
    // Per-tenant usage: tokens, cost, request count
    tenant_usage: {
      query: sql`
        SELECT
          tenant_id,
          SUM(tokens_in + tokens_out) AS total_tokens,
          SUM(cost_usd) AS total_cost,
          COUNT(*) AS total_requests,
          MAX(latency_ms) AS max_latency_ms
        FROM llm_events
        GROUP BY tenant_id
      `,
      filterBy: 'tenant_id',
    },

    // Per-model breakdown
    model_stats: sql`
      SELECT
        model,
        COUNT(*) AS request_count,
        SUM(tokens_in) AS tokens_in,
        SUM(tokens_out) AS tokens_out,
        SUM(cost_usd) AS total_cost,
        AVG(latency_ms)::INT AS avg_latency_ms
      FROM llm_events
      GROUP BY model
    `,
  },
})
