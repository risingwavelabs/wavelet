import { defineConfig, sql } from '@risingwave/wavelet'

export default defineConfig({
  database: 'postgres://root@localhost:4566/dev',

  events: {
    orders: {
      columns: {
        tenant_id: 'string',
        amount: 'float',
      }
    }
  },

  queries: {
    high_value_orders: {
      query: sql`
        SELECT tenant_id, SUM(amount) AS total
        FROM orders
        GROUP BY tenant_id
        HAVING SUM(amount) > 100
      `,
      webhook: 'http://localhost:9999/on-high-value',
    }
  },

  jwt: {
    secret: 'test-secret',
  },
})
