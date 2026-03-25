import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { ViewDef, SqlFragment } from '@risingwave/wavelet'
import type { CursorManager, ViewDiff } from './cursor-manager.js'
import type { JwtVerifier, JwtClaims } from './jwt.js'

interface Subscriber {
  ws: WebSocket
  viewName: string
  claims: JwtClaims | null
}

export class WebSocketFanout {
  private wss: WebSocketServer | null = null
  private subscribers: Map<string, Set<Subscriber>> = new Map() // viewName -> subscribers

  constructor(
    private cursorManager: CursorManager,
    private jwt: JwtVerifier,
    private views: Record<string, ViewDef | SqlFragment>
  ) {}

  attach(server: Server, pathPrefix?: string): void {
    this.wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const pathname = req.url?.split('?')[0] ?? ''
      const subscribePrefix = (pathPrefix ?? '') + '/subscribe/'

      if (pathname.startsWith(subscribePrefix)) {
        this.wss!.handleUpgrade(req, socket, head, (ws) => {
          this.wss!.emit('connection', ws, req)
        })
      }
    })

    this.wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
      // Strip path prefix before handling
      if (pathPrefix && req.url?.startsWith(pathPrefix)) {
        req.url = req.url.slice(pathPrefix.length)
      }
      try {
        await this.handleConnection(ws, req)
      } catch (err: any) {
        ws.send(JSON.stringify({ error: err.message }))
        ws.close(4000, err.message)
      }
    })
  }

  private async handleConnection(ws: WebSocket, req: IncomingMessage): Promise<void> {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`)
    const match = url.pathname?.match(/^\/subscribe\/(.+)$/)

    if (!match) {
      throw new Error(
        `Invalid path: ${url.pathname}. Use /subscribe/{viewName}. ` +
        `Available views: ${Object.keys(this.views).join(', ')}`
      )
    }

    const viewName = match[1]

    if (!this.views[viewName]) {
      const available = Object.keys(this.views)
      throw new Error(
        `View '${viewName}' not found. Available views: ${available.join(', ')}`
      )
    }

    // Verify JWT if configured
    let claims: JwtClaims | null = null
    const token = url.searchParams.get('token')
      ?? req.headers.authorization?.replace('Bearer ', '')

    if (this.jwt.isConfigured()) {
      if (!token) {
        throw new Error('Authentication required. Pass token as query param or Authorization header.')
      }
      claims = await this.jwt.verify(token)
    }

    const subscriber: Subscriber = { ws, viewName, claims }

    if (!this.subscribers.has(viewName)) {
      this.subscribers.set(viewName, new Set())
    }
    this.subscribers.get(viewName)!.add(subscriber)

    ws.on('close', () => {
      this.subscribers.get(viewName)?.delete(subscriber)
    })

    // Heartbeat: detect dead connections behind proxies/load balancers
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, 30000)
    ws.on('close', () => clearInterval(pingInterval))
    ws.on('pong', () => { /* connection alive */ })

    ws.send(JSON.stringify({ type: 'connected', view: viewName }))
  }

  broadcast(viewName: string, diff: ViewDiff): void {
    const subs = this.subscribers.get(viewName)
    if (!subs || subs.size === 0) return

    const viewDef = this.views[viewName]
    const filterBy = this.getFilterBy(viewDef)

    for (const sub of subs) {
      if (sub.ws.readyState !== WebSocket.OPEN) continue

      let filteredDiff = diff
      if (filterBy && sub.claims) {
        filteredDiff = this.filterDiff(diff, filterBy, sub.claims)
      }

      if (
        filteredDiff.inserted.length === 0 &&
        filteredDiff.updated.length === 0 &&
        filteredDiff.deleted.length === 0
      ) {
        continue
      }

      sub.ws.send(JSON.stringify({
        type: 'diff',
        view: viewName,
        cursor: filteredDiff.cursor,
        inserted: filteredDiff.inserted,
        updated: filteredDiff.updated,
        deleted: filteredDiff.deleted,
      }))
    }
  }

  private filterDiff(diff: ViewDiff, filterBy: string, claims: JwtClaims): ViewDiff {
    const claimValue = claims[filterBy]
    if (claimValue === undefined) {
      // No matching claim -- return empty diff, not all data
      return { cursor: diff.cursor, inserted: [], updated: [], deleted: [] }
    }

    const filterFn = (row: Record<string, unknown>) =>
      String(row[filterBy]) === String(claimValue)

    return {
      cursor: diff.cursor,
      inserted: diff.inserted.filter(filterFn),
      updated: diff.updated.filter(filterFn),
      deleted: diff.deleted.filter(filterFn),
    }
  }

  private getFilterBy(viewDef: ViewDef | SqlFragment): string | undefined {
    if ('_tag' in viewDef && viewDef._tag === 'sql') return undefined
    return (viewDef as ViewDef).filterBy
  }

  closeAll(): void {
    for (const [, subs] of this.subscribers) {
      for (const sub of subs) {
        sub.ws.close(1001, 'Server shutting down')
      }
    }
    this.wss?.close()
  }
}
