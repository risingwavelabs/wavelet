# Multi-Tenant Filtering

Wavelet supports per-tenant data isolation using JWT claims. This lets you build multi-tenant apps where each user only sees their own data.

## How it works

1. Define a view with a `filterBy` column
2. Configure JWT verification in your config
3. Clients connect with a JWT token
4. Wavelet extracts the claim from the token and filters diffs server-side

The client never receives data for other tenants. This is enforced in the Wavelet server, not in the client SDK.

## Configuration

```typescript
import { defineConfig, sql } from 'wavelet'

export default defineConfig({
  database: process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev',

  jwt: {
    secret: process.env.JWT_SECRET,
    // Or use JWKS for RS256:
    // jwksUrl: 'https://your-auth-provider.com/.well-known/jwks.json',
    // issuer: 'https://your-auth-provider.com',
    // audience: 'your-app',
  },

  streams: {
    llm_events: {
      columns: {
        tenant_id: 'string',
        model: 'string',
        tokens: 'int',
        cost_usd: 'float',
      }
    }
  },

  views: {
    tenant_usage: {
      query: sql`
        SELECT tenant_id, SUM(tokens) AS total_tokens, SUM(cost_usd) AS total_cost
        FROM llm_events
        GROUP BY tenant_id
      `,
      filterBy: 'tenant_id',
    },
  },
})
```

## Client usage

The client passes a JWT when connecting. Wavelet extracts `tenant_id` from the token and only sends matching diffs.

```typescript
const client = new WaveletClient({
  url: 'http://localhost:8080',
  token: () => getUserJwt(), // JWT must contain { tenant_id: "t1" }
})

// This client only receives diffs where tenant_id = "t1"
client.view('tenant_usage').subscribe({
  onData: (diff) => {
    console.log('My usage:', diff)
  },
})
```

## WebSocket connection

For direct WebSocket connections, pass the token as a query parameter:

```
ws://localhost:8080/subscribe/tenant_usage?token=eyJhbGci...
```

Or as an Authorization header (depends on your WebSocket client).

## How filtering works internally

1. Wavelet maintains a single RisingWave subscription cursor per view (not per tenant)
2. When a diff arrives, Wavelet checks each connected client's JWT claims
3. For views with `filterBy`, only rows matching the client's claim value are forwarded
4. Clients with no matching claim receive nothing (empty diffs are not sent)

This means adding more tenants does not increase load on RisingWave. The filtering happens in Wavelet's memory, after the cursor fetch.

## Security considerations

- The `filterBy` filter is enforced server-side. The client cannot override it.
- If JWT verification is configured, unauthenticated connections are rejected.
- JWT expiration is enforced. Expired tokens result in connection closure.
- The Wavelet server process can see all tenants' data (it reads the full cursor). If this is a concern for your security model, run separate Wavelet instances per tenant.
