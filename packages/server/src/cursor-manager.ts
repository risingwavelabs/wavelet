import pg from 'pg'
import type { SqlFragment, QueryDef } from '@risingwave/wavelet'

const { Client } = pg

export interface DiffRow {
  op: 'insert' | 'update_insert' | 'update_delete' | 'delete'
  row: Record<string, unknown>
  rw_timestamp: string
}

export interface ViewDiff {
  cursor: string
  inserted: Record<string, unknown>[]
  updated: Record<string, unknown>[]
  deleted: Record<string, unknown>[]
}

export interface BootstrapResult {
  snapshotRows: Record<string, unknown>[]
  diffs: ViewDiff[]
  lastCursor: string | null
}

type DiffCallback = (queryName: string, diff: ViewDiff) => void

/**
 * Manages persistent subscription cursors against RisingWave.
 *
 * Each query gets its own dedicated pg connection and a persistent cursor.
 * Uses blocking FETCH (WITH timeout) so there is no polling interval -
 * diffs are dispatched as soon as RisingWave produces them.
 */
export class CursorManager {
  // Shared connection for DDL (CREATE SUBSCRIPTION) and ad-hoc queries
  private client: InstanceType<typeof Client> | null = null

  // Per-query dedicated connections for blocking FETCH
  private queryConnections: Map<string, InstanceType<typeof Client>> = new Map()
  private cursorNames: Map<string, string> = new Map()
  private subscriptions: Map<string, string> = new Map()
  private running = false

  constructor(
    private connectionString: string,
    private queries: Record<string, QueryDef | SqlFragment>
  ) {}

  async initialize(): Promise<void> {
    this.client = new Client({ connectionString: this.connectionString })
    await this.client.connect()
    console.log('Connected to RisingWave')

    for (const [queryName] of Object.entries(this.queries)) {
      const subName = `wavelet_sub_${queryName}`

      // Create subscription if not exists (idempotent)
      try {
        await this.client.query(
          `CREATE SUBSCRIPTION ${subName} FROM ${queryName} WITH (retention = '24h')`
        )
        console.log(`Created subscription: ${subName}`)
      } catch (err: any) {
        if (err.message?.includes('exists')) {
          console.log(`Subscription exists: ${subName}`)
        } else {
          throw err
        }
      }

      this.subscriptions.set(queryName, subName)

      // Create dedicated connection and persistent cursor for this query
      const conn = new Client({ connectionString: this.connectionString })
      await conn.connect()

      const cursorName = `wavelet_cur_${queryName}`
      await conn.query(`DECLARE ${cursorName} SUBSCRIPTION CURSOR FOR ${subName}`)
      console.log(`Opened persistent cursor: ${cursorName}`)

      this.queryConnections.set(queryName, conn)
      this.cursorNames.set(queryName, cursorName)
    }
  }

  /**
   * Start listening for diffs on all queries.
   * Each query runs its own async loop with blocking FETCH.
   * No polling interval - FETCH blocks until data arrives or timeout.
   */
  startPolling(callback: DiffCallback): void {
    this.running = true

    for (const [queryName] of this.subscriptions.entries()) {
      this.listenLoop(queryName, callback)
    }
  }

  stopPolling(): void {
    this.running = false
  }

  private async listenLoop(queryName: string, callback: DiffCallback): Promise<void> {
    const conn = this.queryConnections.get(queryName)
    const cursorName = this.cursorNames.get(queryName)
    if (!conn || !cursorName) return

    while (this.running) {
      try {
        // Blocking FETCH: waits up to 5s for new data, returns immediately when data arrives
        const result = await conn.query(
          `FETCH NEXT FROM ${cursorName} WITH (timeout = '5s')`
        )

        if (result.rows.length === 0) continue

        // Got at least one row. Drain any remaining rows with timeout.
        const allRows = [...result.rows]
        let more = true
        while (more) {
          const batch = await conn.query(
            `FETCH 100 FROM ${cursorName} WITH (timeout = '1s')`
          )
          if (batch.rows.length > 0) {
            allRows.push(...batch.rows)
          } else {
            more = false
          }
        }

        const diffs = this.parseDiffBatches(allRows)

        for (const diff of diffs) {
          if (diff.inserted.length === 0 && diff.updated.length === 0 && diff.deleted.length === 0) {
            continue
          }
          callback(queryName, diff)
        }
      } catch (err: any) {
        if (!this.running) return
        console.error(`[cursor-manager] Error fetching ${queryName}:`, err.message)
        // Back off on error, then retry
        await new Promise(r => setTimeout(r, 1000))
      }
    }
  }

  parseDiffs(rows: any[]): ViewDiff {
    const diff: ViewDiff = {
      cursor: '',
      inserted: [],
      updated: [],
      deleted: [],
    }

    for (const row of rows) {
      const { op, rw_timestamp, ...data } = row
      diff.cursor = rw_timestamp ?? diff.cursor

      // RisingWave returns op as a string: "Insert", "Delete", "UpdateInsert", "UpdateDelete"
      const opStr = String(op)
      switch (opStr) {
        case 'Insert':
        case '1':
          diff.inserted.push(data)
          break
        case 'Delete':
        case '2':
          diff.deleted.push(data)
          break
        case 'UpdateDelete':
        case '3':
          diff.deleted.push(data)
          break
        case 'UpdateInsert':
        case '4':
          diff.updated.push(data)
          break
      }
    }

    return diff
  }

  parseDiffBatches(rows: any[]): ViewDiff[] {
    const diffs: ViewDiff[] = []
    let currentRows: any[] = []
    let currentCursor: string | null = null

    for (const row of rows) {
      const cursor = this.normalizeCursor(row.rw_timestamp)
      if (!cursor) continue

      if (currentCursor !== null && cursor !== currentCursor) {
        diffs.push(this.parseDiffs(currentRows))
        currentRows = []
      }

      currentCursor = cursor
      currentRows.push(row)
    }

    if (currentRows.length > 0) {
      diffs.push(this.parseDiffs(currentRows))
    }

    return diffs
  }

  async bootstrap(queryName: string): Promise<BootstrapResult> {
    const subName = this.subscriptions.get(queryName)
    if (!subName) {
      throw new Error(
        `Subscription for query '${queryName}' is not initialized. Start the server before accepting WebSocket clients.`
      )
    }

    const conn = new Client({ connectionString: this.connectionString })
    await conn.connect()

    const cursorName = `wavelet_boot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    try {
      await conn.query(`DECLARE ${cursorName} SUBSCRIPTION CURSOR FOR ${subName} FULL`)

      const snapshotRows: Record<string, unknown>[] = []
      const incrementalRows: any[] = []
      let readingSnapshot = true

      while (readingSnapshot) {
        const result = await conn.query(`FETCH 1000 FROM ${cursorName}`)
        if (result.rows.length === 0) break

        let firstIncrementalIndex = result.rows.findIndex((row) => this.normalizeCursor(row.rw_timestamp) !== null)
        if (firstIncrementalIndex === -1) firstIncrementalIndex = result.rows.length

        for (const row of result.rows.slice(0, firstIncrementalIndex)) {
          snapshotRows.push(this.stripSubscriptionMetadata(row))
        }

        if (firstIncrementalIndex < result.rows.length) {
          incrementalRows.push(...result.rows.slice(firstIncrementalIndex))
          readingSnapshot = false
        }
      }

      while (true) {
        const result = await conn.query(`FETCH 1000 FROM ${cursorName}`)
        if (result.rows.length === 0) break
        incrementalRows.push(...result.rows)
      }

      const diffs = this.parseDiffBatches(incrementalRows)
      const lastCursor = diffs.length > 0 ? diffs[diffs.length - 1].cursor : null

      return { snapshotRows, diffs, lastCursor }
    } finally {
      try {
        await conn.query(`CLOSE ${cursorName}`)
      } catch {}
      try {
        await conn.end()
      } catch {}
    }
  }

  async query(sql: string): Promise<any[]> {
    if (!this.client) throw new Error('Not connected')
    const result = await this.client.query(sql)
    return result.rows
  }

  async execute(sql: string): Promise<void> {
    if (!this.client) throw new Error('Not connected')
    await this.client.query(sql)
  }

  async close(): Promise<void> {
    this.running = false

    // Close per-query connections
    for (const [queryName, conn] of this.queryConnections) {
      const cursorName = this.cursorNames.get(queryName)
      try {
        if (cursorName) await conn.query(`CLOSE ${cursorName}`)
      } catch {}
      try {
        await conn.end()
      } catch {}
    }
    this.queryConnections.clear()
    this.cursorNames.clear()

    // Close shared connection
    try {
      await this.client?.end()
    } catch {}
    this.client = null
  }

  private stripSubscriptionMetadata(row: Record<string, unknown>): Record<string, unknown> {
    const { op: _op, rw_timestamp: _rwTimestamp, ...data } = row
    return data
  }

  private normalizeCursor(value: unknown): string | null {
    if (value === null || value === undefined) return null
    const cursor = String(value).trim()
    return cursor === '' ? null : cursor
  }
}
