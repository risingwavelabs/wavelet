import { defineConfig, sql } from '@risingwave/wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

  events: {
    orders: {
      columns: {
        tenant_id: 'string',
        amount: 'float',
        product: 'string',
        region: 'string',
        ts: 'timestamp',
      }
    }
  },

  queries: {
    tenant_revenue: {
      query: sql`
        SELECT
          tenant_id,
          SUM(amount) AS total_revenue,
          COUNT(*) AS order_count,
          AVG(amount)::INT AS avg_order_value
        FROM orders
        GROUP BY tenant_id
      `,
      filterBy: 'tenant_id',
    },

    revenue_by_product: sql`
      SELECT
        product,
        SUM(amount) AS revenue,
        COUNT(*) AS orders
      FROM orders
      GROUP BY product
      ORDER BY revenue DESC
    `,

    revenue_by_region: sql`
      SELECT
        region,
        SUM(amount) AS revenue,
        COUNT(*) AS orders
      FROM orders
      GROUP BY region
    `,

    recent_orders: sql`
      SELECT
        tenant_id, amount, product, region, ts
      FROM orders
      ORDER BY ts DESC
      LIMIT 20
    `,
  },
})
