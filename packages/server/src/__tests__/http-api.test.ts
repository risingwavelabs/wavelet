import { describe, it, expect } from 'vitest'
import http from 'node:http'
import { HttpApi } from '../http-api.js'

function createTestServer(api: HttpApi): Promise<http.Server> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => api.handle(req, res))
    server.listen(0, () => resolve(server))
  })
}

function request(server: http.Server, method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const addr = server.address() as any
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: addr.port,
      method,
      path,
      headers: body ? { 'Content-Type': 'application/json' } : {},
    }, (res) => {
      let data = ''
      res.on('data', (chunk) => { data += chunk })
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(data) })
        } catch {
          resolve({ status: res.statusCode!, data })
        }
      })
    })
    req.on('error', reject)
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

describe('HttpApi', () => {
  const events = {
    game_events: { columns: { user_id: 'string' as const, value: 'int' as const } },
  }
  const queries = {
    leaderboard: { _tag: 'sql' as const, text: 'SELECT 1' },
  }

  it('returns health check', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/health')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ status: 'ok' })
    } finally {
      server.close()
    }
  })

  it('lists available queries', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/queries')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ queries: ['leaderboard'] })
    } finally {
      server.close()
    }
  })

  it('lists available events', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/events')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ events: ['game_events'] })
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown routes with helpful message', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/nonexistent')
      expect(res.status).toBe(404)
      expect(res.data.error).toBe('Not found')
      expect(res.data.routes).toBeDefined()
      expect(res.data.routes.length).toBeGreaterThan(0)
    } finally {
      server.close()
    }
  })

  it('handles CORS preflight', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'OPTIONS', '/v1/queries')
      expect(res.status).toBe(204)
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown event', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'POST', '/v1/events/nonexistent', { x: 1 })
      expect(res.status).toBe(404)
      expect(res.data.available_events).toEqual(['game_events'])
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown query', async () => {
    const api = new HttpApi('postgres://dummy', events, queries)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/queries/nonexistent')
      expect(res.status).toBe(404)
      expect(res.data.available_queries).toEqual(['leaderboard'])
    } finally {
      server.close()
    }
  })
})
