import type { IncomingMessage, ServerResponse } from 'node:http'
import pg from 'pg'
import type { EventDef, QueryDef, SqlFragment } from '@risingwave/wavelet'
import type { JwtVerifier, JwtClaims } from './jwt.js'

const { Pool } = pg

const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_INSERT_PARAMETERS = 65535

export class HttpApi {
  private pool: InstanceType<typeof Pool> | null = null

  constructor(
    private connectionString: string,
    private events: Record<string, EventDef>,
    private queries: Record<string, QueryDef | SqlFragment>,
    private jwt?: JwtVerifier
  ) {}

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')

    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)

    try {
      // POST /v1/events/{name}
      const eventMatch = url.pathname.match(/^\/v1\/events\/([^/]+)$/)
      if (eventMatch && req.method === 'POST') {
        await this.handleWrite(eventMatch[1], req, res)
        return
      }

      // POST /v1/events/{name}/batch
      const batchMatch = url.pathname.match(/^\/v1\/events\/([^/]+)\/batch$/)
      if (batchMatch && req.method === 'POST') {
        await this.handleBatchWrite(batchMatch[1], req, res)
        return
      }

      // GET /v1/queries/{name}
      const queryMatch = url.pathname.match(/^\/v1\/queries\/([^/]+)$/)
      if (queryMatch && req.method === 'GET') {
        await this.handleRead(queryMatch[1], url, req, res)
        return
      }

      // GET /v1/health
      if (url.pathname === '/v1/health') {
        this.json(res, 200, { status: 'ok' })
        return
      }

      // GET /v1/queries - list available queries
      if (url.pathname === '/v1/queries' && req.method === 'GET') {
        this.json(res, 200, { queries: Object.keys(this.queries) })
        return
      }

      // GET /v1/events - list available events
      if (url.pathname === '/v1/events' && req.method === 'GET') {
        this.json(res, 200, { events: Object.keys(this.events) })
        return
      }

      this.json(res, 404, {
        error: 'Not found',
        message: `${req.method} ${url.pathname} does not match any route.`,
        routes: [
          'GET  /v1/health',
          'GET  /v1/queries',
          'GET  /v1/queries/{name}',
          'GET  /v1/events',
          'POST /v1/events/{name}',
          'POST /v1/events/{name}/batch',
        ],
      })
    } catch (err: any) {
      console.error('HTTP error:', err)
      this.json(res, 500, { error: err.message })
    }
  }

  private ensurePool(): InstanceType<typeof Pool> {
    if (!this.pool) {
      this.pool = new Pool({ connectionString: this.connectionString, max: 10 })
    }
    return this.pool
  }

  private async handleWrite(eventName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const eventDef = this.events[eventName]
    if (!eventDef) {
      const available = Object.keys(this.events)
      this.json(res, 404, {
        error: `Event '${eventName}' not found.`,
        available_events: available,
      })
      return
    }

    const body = await this.readBody(req)
    const data = JSON.parse(body)

    const pool = this.ensurePool()
    const columns = Object.keys(eventDef.columns)
    const values = columns.map((col) => data[col])
    const placeholders = columns.map((_, i) => `$${i + 1}`)

    await pool.query(
      `INSERT INTO ${eventName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    )

    this.json(res, 200, { ok: true })
  }

  private async handleBatchWrite(eventName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const eventDef = this.events[eventName]
    if (!eventDef) {
      const available = Object.keys(this.events)
      this.json(res, 404, {
        error: `Event '${eventName}' not found.`,
        available_events: available,
      })
      return
    }

    const body = await this.readBody(req)
    const items: any[] = JSON.parse(body)

    if (!Array.isArray(items)) {
      this.json(res, 400, { error: 'Batch endpoint expects a JSON array.' })
      return
    }

    if (items.length === 0) {
      this.json(res, 200, { ok: true, count: 0 })
      return
    }

    const pool = this.ensurePool()
    const columns = Object.keys(eventDef.columns)
    const maxRowsPerInsert = Math.max(1, Math.floor(MAX_INSERT_PARAMETERS / Math.max(columns.length, 1)))

    for (let start = 0; start < items.length; start += maxRowsPerInsert) {
      const chunk = items.slice(start, start + maxRowsPerInsert)
      const { values, rows } = this.buildBatchInsert(chunk, columns)

      await pool.query(
        `INSERT INTO ${eventName} (${columns.join(', ')}) VALUES ${rows.join(', ')}`,
        values
      )
    }

    this.json(res, 200, { ok: true, count: items.length })
  }

  private async handleRead(queryName: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.queries[queryName]) {
      const available = Object.keys(this.queries)
      this.json(res, 404, {
        error: `Query '${queryName}' not found.`,
        available_queries: available,
      })
      return
    }

    // JWT verification for queries with filterBy
    const queryDef = this.queries[queryName]
    const filterBy = this.getFilterBy(queryDef)

    let claims: JwtClaims | null = null
    if (filterBy && this.jwt?.isConfigured()) {
      const token = url.searchParams.get('token')
        ?? req.headers.authorization?.replace('Bearer ', '')

      if (!token) {
        this.json(res, 401, { error: 'Authentication required for filtered queries.' })
        return
      }

      claims = await this.jwt.verify(token)
    }

    const pool = this.ensurePool()

    // Build WHERE clause: start with filterBy if applicable
    const params: string[] = []
    const values: unknown[] = []

    if (filterBy && claims) {
      const claimValue = claims[filterBy]
      if (claimValue === undefined) {
        // No matching claim -- return empty result, not all data
        this.json(res, 200, { query: queryName, rows: [] })
        return
      }
      values.push(String(claimValue))
      params.push(`${filterBy} = $${values.length}`)
    }

    // Add query params as additional filters, validating column names
    const knownColumns = this.getQueryColumns(queryDef)
    for (const [key, value] of url.searchParams.entries()) {
      if (key === 'token') continue // skip JWT token param
      if (knownColumns && !knownColumns.includes(key)) {
        this.json(res, 400, { error: `Unknown column '${key}'. Known columns: ${knownColumns.join(', ')}` })
        return
      }
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        this.json(res, 400, { error: `Invalid column name: '${key}'` })
        return
      }
      values.push(value)
      params.push(`${key} = $${values.length}`)
    }

    let sql = `SELECT * FROM ${queryName}`
    if (params.length > 0) {
      sql += ` WHERE ${params.join(' AND ')}`
    }

    const result = await pool.query(sql, values)
    this.json(res, 200, { query: queryName, rows: result.rows })
  }

  private getFilterBy(queryDef: QueryDef | SqlFragment): string | undefined {
    if ('_tag' in queryDef && queryDef._tag === 'sql') return undefined
    return (queryDef as QueryDef).filterBy
  }

  private getQueryColumns(queryDef: QueryDef | SqlFragment): string[] | null {
    if ('_tag' in queryDef && queryDef._tag === 'sql') return null
    const qd = queryDef as QueryDef
    if (qd.columns) return Object.keys(qd.columns)
    return null
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private buildBatchInsert(items: Record<string, unknown>[], columns: string[]): {
    values: unknown[]
    rows: string[]
  } {
    const values: unknown[] = []
    const rows = items.map((item, rowIndex) => {
      const placeholders = columns.map((column, columnIndex) => {
        values.push(item[column])
        return `$${rowIndex * columns.length + columnIndex + 1}`
      })
      return `(${placeholders.join(', ')})`
    })

    return { values, rows }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_SIZE) {
          req.destroy()
          reject(new Error(`Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit`))
          return
        }
        body += chunk
      })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }
}
