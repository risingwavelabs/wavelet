import { WebSocketServer, WebSocket } from 'ws'
import type { IncomingMessage, Server } from 'node:http'
import type { QueryDef, SqlFragment } from '@risingwave/wavelet'
import type { CursorManager, ViewDiff } from './cursor-manager.js'
import type { JwtVerifier, JwtClaims } from './jwt.js'

interface Subscriber {
  ws: WebSocket
  queryName: string
  claims: JwtClaims | null
  ready: boolean
  pendingDiffs: ViewDiff[]
}

export class WebSocketFanout {
  private wss: WebSocketServer | null = null
  private subscribers: Map<string, Set<Subscriber>> = new Map() // queryName -> subscribers

  constructor(
    private cursorManager: CursorManager,
    private jwt: JwtVerifier,
    private queries: Record<string, QueryDef | SqlFragment>
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
        `Invalid path: ${url.pathname}. Use /subscribe/{queryName}. ` +
        `Available queries: ${Object.keys(this.queries).join(', ')}`
      )
    }

    const queryName = match[1]

    if (!this.queries[queryName]) {
      const available = Object.keys(this.queries)
      throw new Error(
        `Query '${queryName}' not found. Available queries: ${available.join(', ')}`
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

    const subscriber: Subscriber = {
      ws,
      queryName,
      claims,
      ready: false,
      pendingDiffs: [],
    }

    if (!this.subscribers.has(queryName)) {
      this.subscribers.set(queryName, new Set())
    }
    this.subscribers.get(queryName)!.add(subscriber)

    ws.on('close', () => {
      this.subscribers.get(queryName)?.delete(subscriber)
    })

    // Heartbeat: detect dead connections behind proxies/load balancers
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping()
      }
    }, 30000)
    ws.on('close', () => clearInterval(pingInterval))
    ws.on('pong', () => { /* connection alive */ })

    ws.send(JSON.stringify({ type: 'connected', query: queryName }))

    const bootstrap = await this.cursorManager.bootstrap(queryName)
    const snapshotRows = this.filterSnapshotRows(queryName, bootstrap.snapshotRows, claims)
    ws.send(JSON.stringify({
      type: 'snapshot',
      query: queryName,
      rows: snapshotRows,
    }))

    for (const diff of bootstrap.diffs) {
      const filteredDiff = this.filterDiffForSubscriber(queryName, diff, claims)
      if (this.isEmptyDiff(filteredDiff)) continue
      if (ws.readyState !== WebSocket.OPEN) break
      ws.send(this.serializeDiffMessage(queryName, filteredDiff))
    }

    const handoffCursor = bootstrap.lastCursor
    subscriber.ready = true
    for (const diff of subscriber.pendingDiffs) {
      if (ws.readyState !== WebSocket.OPEN) break
      if (handoffCursor && this.compareCursor(diff.cursor, handoffCursor) <= 0) {
        continue
      }
      ws.send(this.serializeDiffMessage(queryName, diff))
    }
    subscriber.pendingDiffs = []
  }

  broadcast(queryName: string, diff: ViewDiff): void {
    const subs = this.subscribers.get(queryName)
    if (!subs || subs.size === 0) return

    for (const sub of subs) {
      if (sub.ws.readyState !== WebSocket.OPEN) continue

      const filteredDiff = this.filterDiffForSubscriber(queryName, diff, sub.claims)
      if (this.isEmptyDiff(filteredDiff)) continue

      if (!sub.ready) {
        sub.pendingDiffs.push(filteredDiff)
        continue
      }

      sub.ws.send(this.serializeDiffMessage(queryName, filteredDiff))
    }
  }

  private filterSnapshotRows(
    queryName: string,
    rows: Record<string, unknown>[],
    claims: JwtClaims | null
  ): Record<string, unknown>[] {
    const queryDef = this.queries[queryName]
    const filterBy = this.getFilterBy(queryDef)

    if (filterBy && claims) {
      const claimValue = claims[filterBy]
      if (claimValue === undefined) return []

      return rows.filter((row) => String(row[filterBy]) === String(claimValue))
    }

    return rows
  }

  private filterDiffForSubscriber(
    queryName: string,
    diff: ViewDiff,
    claims: JwtClaims | null
  ): ViewDiff {
    const queryDef = this.queries[queryName]
    const filterBy = this.getFilterBy(queryDef)

    if (filterBy && claims) {
      return this.filterDiff(diff, filterBy, claims)
    }

    return diff
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

  private getFilterBy(queryDef: QueryDef | SqlFragment): string | undefined {
    if ('_tag' in queryDef && queryDef._tag === 'sql') return undefined
    return (queryDef as QueryDef).filterBy
  }

  private isEmptyDiff(diff: ViewDiff): boolean {
    return diff.inserted.length === 0 && diff.updated.length === 0 && diff.deleted.length === 0
  }

  private serializeDiffMessage(queryName: string, diff: ViewDiff): string {
    return JSON.stringify({
      type: 'diff',
      query: queryName,
      cursor: diff.cursor,
      inserted: diff.inserted,
      updated: diff.updated,
      deleted: diff.deleted,
    })
  }

  private compareCursor(left: string, right: string): number {
    const leftValue = BigInt(left)
    const rightValue = BigInt(right)
    if (leftValue === rightValue) return 0
    return leftValue < rightValue ? -1 : 1
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
