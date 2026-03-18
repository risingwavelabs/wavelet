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

export class CursorManager {
  private client: InstanceType<typeof Client> | null = null
  private cursors: Map<string, string> = new Map() // viewName -> last rw_timestamp
  private subscriptions: Map<string, string> = new Map() // viewName -> subscription name
  private pollInterval: ReturnType<typeof setInterval> | null = null

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
        if (err.message?.includes('already exists')) {
          console.log(`Subscription exists: ${subName}`)
        } else {
          throw err
        }
      }

      this.subscriptions.set(viewName, subName)
      // Initialize cursor to "now"
      const result = await this.client.query(`SELECT now()::text AS ts`)
      this.cursors.set(viewName, result.rows[0].ts)
    }
  }

  startPolling(callback: DiffCallback, intervalMs: number = 200): void {
    this.pollInterval = setInterval(async () => {
      for (const [viewName, subName] of this.subscriptions.entries()) {
        try {
          await this.fetchAndDispatch(viewName, subName, callback)
        } catch (err) {
          console.error(`Error polling ${viewName}:`, err)
        }
      }
    }, intervalMs)
  }

  stopPolling(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  private async fetchAndDispatch(
    viewName: string,
    subName: string,
    callback: DiffCallback
  ): Promise<void> {
    if (!this.client) return

    const lastTs = this.cursors.get(viewName)
    const cursorName = `wavelet_cursor_${viewName}_${Date.now()}`

    try {
      await this.client.query(
        `DECLARE ${cursorName} SUBSCRIPTION CURSOR FOR ${subName} SINCE ${lastTs}`
      )

      const result = await this.client.query(
        `FETCH 1000 FROM ${cursorName}`
      )

      if (result.rows.length === 0) {
        await this.client.query(`CLOSE ${cursorName}`)
        return
      }

      const diff = this.parseDiffs(result.rows)

      // Update cursor position
      const lastRow = result.rows[result.rows.length - 1]
      if (lastRow.rw_timestamp) {
        this.cursors.set(viewName, lastRow.rw_timestamp)
      }

      await this.client.query(`CLOSE ${cursorName}`)

      callback(viewName, diff)
    } catch (err) {
      // Try to close cursor on error
      try {
        await this.client.query(`CLOSE ${cursorName}`)
      } catch {}
      throw err
    }
  }

  private parseDiffs(rows: any[]): ViewDiff {
    const diff: ViewDiff = {
      cursor: '',
      inserted: [],
      updated: [],
      deleted: [],
    }

    for (const row of rows) {
      const { op, rw_timestamp, ...data } = row
      diff.cursor = rw_timestamp ?? diff.cursor

      switch (op) {
        case 1: // Insert
          diff.inserted.push(data)
          break
        case 2: // Delete
          diff.deleted.push(data)
          break
        case 3: // Update (old value)
          diff.deleted.push(data)
          break
        case 4: // Update (new value)
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
}
