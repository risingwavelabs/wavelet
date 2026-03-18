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
  const streams = {
    events: { columns: { user_id: 'string' as const, value: 'int' as const } },
  }
  const views = {
    leaderboard: { _tag: 'sql' as const, text: 'SELECT 1' },
  }

  it('returns health check', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/health')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ status: 'ok' })
    } finally {
      server.close()
    }
  })

  it('lists available views', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/views')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ views: ['leaderboard'] })
    } finally {
      server.close()
    }
  })

  it('lists available streams', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/streams')
      expect(res.status).toBe(200)
      expect(res.data).toEqual({ streams: ['events'] })
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown routes with helpful message', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
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
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'OPTIONS', '/v1/views')
      expect(res.status).toBe(204)
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown stream', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'POST', '/v1/streams/nonexistent', { x: 1 })
      expect(res.status).toBe(404)
      expect(res.data.available_streams).toEqual(['events'])
    } finally {
      server.close()
    }
  })

  it('returns 404 for unknown view', async () => {
    const api = new HttpApi('postgres://dummy', streams, views)
    const server = await createTestServer(api)
    try {
      const res = await request(server, 'GET', '/v1/views/nonexistent')
      expect(res.status).toBe(404)
      expect(res.data.available_views).toEqual(['leaderboard'])
    } finally {
      server.close()
    }
  })
})
