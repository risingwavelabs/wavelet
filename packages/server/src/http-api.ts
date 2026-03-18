import type { IncomingMessage, ServerResponse } from 'node:http'
import pg from 'pg'
import type { StreamDef, ViewDef, SqlFragment } from '@risingwave/wavelet'

const { Client } = pg

export class HttpApi {
  private client: InstanceType<typeof Client> | null = null

  constructor(
    private connectionString: string,
    private streams: Record<string, StreamDef>,
    private views: Record<string, ViewDef | SqlFragment>
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
        await this.handleRead(viewMatch[1], url, res)
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

  private async ensureClient(): Promise<InstanceType<typeof Client>> {
    if (!this.client) {
      this.client = new Client({ connectionString: this.connectionString })
      await this.client.connect()
    }
    return this.client
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

    const client = await this.ensureClient()
    const columns = Object.keys(stream.columns)
    const values = columns.map((col) => data[col])
    const placeholders = columns.map((_, i) => `$${i + 1}`)

    await client.query(
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

    const client = await this.ensureClient()
    const columns = Object.keys(stream.columns)

    for (const data of events) {
      const values = columns.map((col) => data[col])
      const placeholders = columns.map((_, i) => `$${i + 1}`)
      await client.query(
        `INSERT INTO ${streamName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values
      )
    }

    this.json(res, 200, { ok: true, count: events.length })
  }

  private async handleRead(viewName: string, url: URL, res: ServerResponse): Promise<void> {
    if (!this.views[viewName]) {
      const available = Object.keys(this.views)
      this.json(res, 404, {
        error: `View '${viewName}' not found.`,
        available_views: available,
      })
      return
    }

    const client = await this.ensureClient()

    // Build WHERE clause from query params
    const params: string[] = []
    const values: unknown[] = []
    for (const [key, value] of url.searchParams.entries()) {
      params.push(`${key} = $${params.length + 1}`)
      values.push(value)
    }

    let sql = `SELECT * FROM ${viewName}`
    if (params.length > 0) {
      sql += ` WHERE ${params.join(' AND ')}`
    }

    const result = await client.query(sql, values)
    this.json(res, 200, { view: viewName, rows: result.rows })
  }

  private json(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => resolve(body))
      req.on('error', reject)
    })
  }
}
