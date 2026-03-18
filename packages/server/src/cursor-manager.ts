import pg from 'pg'
import type { SqlFragment, ViewDef } from 'wavelet'

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

type DiffCallback = (viewName: string, diff: ViewDiff) => void

/**
 * Manages persistent subscription cursors against RisingWave.
 *
 * Each view gets its own dedicated pg connection and a persistent cursor.
 * Uses blocking FETCH (WITH timeout) so there is no polling interval -
 * diffs are dispatched as soon as RisingWave produces them.
 */
export class CursorManager {
  // Shared connection for DDL (CREATE SUBSCRIPTION) and ad-hoc queries
  private client: InstanceType<typeof Client> | null = null

  // Per-view dedicated connections for blocking FETCH
  private viewConnections: Map<string, InstanceType<typeof Client>> = new Map()
  private cursorNames: Map<string, string> = new Map()
  private subscriptions: Map<string, string> = new Map()
  private running = false

  constructor(
    private connectionString: string,
    private views: Record<string, ViewDef | SqlFragment>
  ) {}

  async initialize(): Promise<void> {
    this.client = new Client({ connectionString: this.connectionString })
    await this.client.connect()
    console.log('Connected to RisingWave')

    for (const [viewName] of Object.entries(this.views)) {
      const subName = `wavelet_sub_${viewName}`

      // Create subscription if not exists (idempotent)
      try {
        await this.client.query(
          `CREATE SUBSCRIPTION ${subName} FROM ${viewName} WITH (retention = '24h')`
        )
        console.log(`Created subscription: ${subName}`)
      } catch (err: any) {
        if (err.message?.includes('exists')) {
          console.log(`Subscription exists: ${subName}`)
        } else {
          throw err
        }
      }

      this.subscriptions.set(viewName, subName)

      // Create dedicated connection and persistent cursor for this view
      const conn = new Client({ connectionString: this.connectionString })
      await conn.connect()

      const cursorName = `wavelet_cur_${viewName}`
      await conn.query(`DECLARE ${cursorName} SUBSCRIPTION CURSOR FOR ${subName}`)
      console.log(`Opened persistent cursor: ${cursorName}`)

      this.viewConnections.set(viewName, conn)
      this.cursorNames.set(viewName, cursorName)
    }
  }

  /**
   * Start listening for diffs on all views.
   * Each view runs its own async loop with blocking FETCH.
   * No polling interval - FETCH blocks until data arrives or timeout.
   */
  startPolling(callback: DiffCallback): void {
    this.running = true

    for (const [viewName] of this.subscriptions.entries()) {
      this.listenLoop(viewName, callback)
    }
  }

  stopPolling(): void {
    this.running = false
  }

  private async listenLoop(viewName: string, callback: DiffCallback): Promise<void> {
    const conn = this.viewConnections.get(viewName)
    const cursorName = this.cursorNames.get(viewName)
    if (!conn || !cursorName) return

    while (this.running) {
      try {
        // Blocking FETCH: waits up to 5s for new data, returns immediately when data arrives
        const result = await conn.query(
          `FETCH NEXT FROM ${cursorName} WITH (timeout = '5s')`
        )

        if (result.rows.length === 0) continue

        // Got at least one row. Drain any remaining rows without blocking.
        const allRows = [...result.rows]
        let more = true
        while (more) {
          const batch = await conn.query(
            `FETCH 100 FROM ${cursorName}`
          )
          if (batch.rows.length > 0) {
            allRows.push(...batch.rows)
          } else {
            more = false
          }
        }

        const diff = this.parseDiffs(allRows)

        if (diff.inserted.length > 0 || diff.updated.length > 0 || diff.deleted.length > 0) {
          callback(viewName, diff)
        }
      } catch (err: any) {
        if (!this.running) return
        console.error(`[cursor-manager] Error fetching ${viewName}:`, err.message)
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

    // Close per-view connections
    for (const [viewName, conn] of this.viewConnections) {
      const cursorName = this.cursorNames.get(viewName)
      try {
        if (cursorName) await conn.query(`CLOSE ${cursorName}`)
      } catch {}
      try {
        await conn.end()
      } catch {}
    }
    this.viewConnections.clear()
    this.cursorNames.clear()

    // Close shared connection
    try {
      await this.client?.end()
    } catch {}
    this.client = null
  }
}
