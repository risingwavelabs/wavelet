import type { IncomingMessage, ServerResponse } from 'node:http'
import pg from 'pg'
import type { StreamDef, ViewDef, SqlFragment } from '@risingwave/wavelet'
import type { JwtVerifier, JwtClaims } from './jwt.js'

const { Pool } = pg

const MAX_BODY_SIZE = 10 * 1024 * 1024 // 10MB

export class HttpApi {
  private pool: InstanceType<typeof Pool> | null = null

  constructor(
    private connectionString: string,
    private streams: Record<string, StreamDef>,
    private views: Record<string, ViewDef | SqlFragment>,
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
      // POST /v1/streams/{name}
      const streamMatch = url.pathname.match(/^\/v1\/streams\/([^/]+)$/)
      if (streamMatch && req.method === 'POST') {
        await this.handleWrite(streamMatch[1], req, res)
        return
      }

      // POST /v1/streams/{name}/batch
      const batchMatch = url.pathname.match(/^\/v1\/streams\/([^/]+)\/batch$/)
      if (batchMatch && req.method === 'POST') {
        await this.handleBatchWrite(batchMatch[1], req, res)
        return
      }

      // GET /v1/views/{name}
      const viewMatch = url.pathname.match(/^\/v1\/views\/([^/]+)$/)
      if (viewMatch && req.method === 'GET') {
        await this.handleRead(viewMatch[1], url, req, res)
        return
      }

      // GET /v1/health
      if (url.pathname === '/v1/health') {
        this.json(res, 200, { status: 'ok' })
        return
      }

      // GET /v1/views - list available views
      if (url.pathname === '/v1/views' && req.method === 'GET') {
        this.json(res, 200, { views: Object.keys(this.views) })
        return
      }

      // GET /v1/streams - list available streams
      if (url.pathname === '/v1/streams' && req.method === 'GET') {
        this.json(res, 200, { streams: Object.keys(this.streams) })
        return
      }

      this.json(res, 404, {
        error: 'Not found',
        message: `${req.method} ${url.pathname} does not match any route.`,
        routes: [
          'GET  /v1/health',
          'GET  /v1/views',
          'GET  /v1/views/{name}',
          'GET  /v1/streams',
          'POST /v1/streams/{name}',
          'POST /v1/streams/{name}/batch',
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

  private async handleWrite(streamName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stream = this.streams[streamName]
    if (!stream) {
      const available = Object.keys(this.streams)
      this.json(res, 404, {
        error: `Stream '${streamName}' not found.`,
        available_streams: available,
      })
      return
    }

    const body = await this.readBody(req)
    const data = JSON.parse(body)

    const pool = this.ensurePool()
    const columns = Object.keys(stream.columns)
    const values = columns.map((col) => data[col])
    const placeholders = columns.map((_, i) => `$${i + 1}`)

    await pool.query(
      `INSERT INTO ${streamName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
      values
    )

    this.json(res, 200, { ok: true })
  }

  private async handleBatchWrite(streamName: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const stream = this.streams[streamName]
    if (!stream) {
      const available = Object.keys(this.streams)
      this.json(res, 404, {
        error: `Stream '${streamName}' not found.`,
        available_streams: available,
      })
      return
    }

    const body = await this.readBody(req)
    const events: any[] = JSON.parse(body)

    if (!Array.isArray(events)) {
      this.json(res, 400, { error: 'Batch endpoint expects a JSON array.' })
      return
    }

    if (events.length === 0) {
      this.json(res, 200, { ok: true, count: 0 })
      return
    }

    const pool = this.ensurePool()
    const columns = Object.keys(stream.columns)

    // Build a single INSERT with multiple VALUE rows
    const allValues: unknown[] = []
    const rowPlaceholders: string[] = []

    for (let i = 0; i < events.length; i++) {
      const row = events[i]
      const offset = i * columns.length
      const ph = columns.map((_, j) => `$${offset + j + 1}`)
      rowPlaceholders.push(`(${ph.join(', ')})`)
      for (const col of columns) {
        allValues.push(row[col])
      }
    }

    await pool.query(
      `INSERT INTO ${streamName} (${columns.join(', ')}) VALUES ${rowPlaceholders.join(', ')}`,
      allValues
    )

    this.json(res, 200, { ok: true, count: events.length })
  }

  private async handleRead(viewName: string, url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.views[viewName]) {
      const available = Object.keys(this.views)
      this.json(res, 404, {
        error: `View '${viewName}' not found.`,
        available_views: available,
      })
      return
    }

    // JWT verification for views with filterBy
    const viewDef = this.views[viewName]
    const filterBy = this.getFilterBy(viewDef)

    let claims: JwtClaims | null = null
    if (filterBy && this.jwt?.isConfigured()) {
      const token = url.searchParams.get('token')
        ?? req.headers.authorization?.replace('Bearer ', '')

      if (!token) {
        this.json(res, 401, { error: 'Authentication required for filtered views.' })
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
        this.json(res, 200, { view: viewName, rows: [] })
        return
      }
      values.push(String(claimValue))
      params.push(`${filterBy} = $${values.length}`)
    }

    // Add query params as additional filters, validating column names
    const knownColumns = this.getViewColumns(viewDef)
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

    let sql = `SELECT * FROM ${viewName}`
    if (params.length > 0) {
      sql += ` WHERE ${params.join(' AND ')}`
    }

    const result = await pool.query(sql, values)
    this.json(res, 200, { view: viewName, rows: result.rows })
  }

  private getFilterBy(viewDef: ViewDef | SqlFragment): string | undefined {
    if ('_tag' in viewDef && viewDef._tag === 'sql') return undefined
    return (viewDef as ViewDef).filterBy
  }

  private getViewColumns(viewDef: ViewDef | SqlFragment): string[] | null {
    if ('_tag' in viewDef && viewDef._tag === 'sql') return null
    const vd = viewDef as ViewDef
    if (vd.columns) return Object.keys(vd.columns)
    return null
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
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
