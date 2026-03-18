/**
 * Integration tests that require a running RisingWave instance.
 * Skipped in CI unless WAVELET_TEST_DATABASE_URL is set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import http from 'node:http'
import { WebSocket } from 'ws'
import { DdlManager } from '../ddl-manager.js'
import { WaveletServer } from '../server.js'
import { sql } from 'wavelet'
import type { WaveletConfig } from 'wavelet'

const { Client } = pg

const DATABASE_URL = process.env.WAVELET_TEST_DATABASE_URL ?? 'postgres://root@localhost:4566/dev'

// Check if RisingWave is reachable
async function isRisingWaveAvailable(): Promise<boolean> {
  const client = new Client({ connectionString: DATABASE_URL, connectionTimeoutMillis: 2000 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    await client.end()
    return true
  } catch {
    return false
  }
}

// Use unique names to avoid collisions with other test runs
const prefix = `test_${Date.now()}`
const STREAM_NAME = `${prefix}_events`
const VIEW_NAME = `${prefix}_totals`
const SUB_NAME = `wavelet_sub_${VIEW_NAME}`

const testConfig: WaveletConfig = {
  database: DATABASE_URL,
  streams: {
    [STREAM_NAME]: {
      columns: {
        user_id: 'string',
        value: 'int',
      },
    },
  },
  views: {
    [VIEW_NAME]: sql`
      SELECT user_id, SUM(value) AS total_value, COUNT(*) AS event_count
      FROM ${STREAM_NAME}
      GROUP BY user_id
    `,
  },
  server: {
    port: 0, // random port
  },
}

describe.runIf(process.env.WAVELET_INTEGRATION === '1')('Integration: DDL Manager', () => {
  let ddl: DdlManager

  beforeAll(async () => {
    ddl = new DdlManager(DATABASE_URL)
    await ddl.connect()
  })

  afterAll(async () => {
    // Cleanup: drop test objects
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    try { await client.query(`DROP SUBSCRIPTION IF EXISTS ${SUB_NAME}`) } catch {}
    try { await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${VIEW_NAME}`) } catch {}
    try { await client.query(`DROP TABLE IF EXISTS ${STREAM_NAME}`) } catch {}
    await client.end()
    await ddl.close()
  })

  it('creates tables, views, and subscriptions', async () => {
    const actions = await ddl.sync(testConfig)

    const creates = actions.filter(a => a.type === 'create')
    expect(creates.length).toBeGreaterThanOrEqual(3) // stream + view + subscription

    const streamAction = creates.find(a => a.resource === 'stream' && a.name === STREAM_NAME)
    expect(streamAction).toBeDefined()

    const viewAction = creates.find(a => a.resource === 'view' && a.name === VIEW_NAME)
    expect(viewAction).toBeDefined()

    const subAction = creates.find(a => a.resource === 'subscription' && a.name === SUB_NAME)
    expect(subAction).toBeDefined()
  })

  it('is idempotent - second sync reports unchanged', async () => {
    const actions = await ddl.sync(testConfig)

    const unchanged = actions.filter(a => a.type === 'unchanged')
    expect(unchanged.length).toBeGreaterThanOrEqual(3)

    const creates = actions.filter(a => a.type === 'create')
    expect(creates.length).toBe(0)
  })

  it('can write and read data', async () => {
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()

    await client.query(`INSERT INTO ${STREAM_NAME} (user_id, value) VALUES ('alice', 10)`)
    await client.query(`INSERT INTO ${STREAM_NAME} (user_id, value) VALUES ('alice', 20)`)
    await client.query(`INSERT INTO ${STREAM_NAME} (user_id, value) VALUES ('bob', 5)`)

    // Wait for MV to update
    await new Promise(r => setTimeout(r, 2000))

    const result = await client.query(`SELECT * FROM ${VIEW_NAME} ORDER BY total_value DESC`)
    expect(result.rows.length).toBeGreaterThanOrEqual(2)

    const alice = result.rows.find((r: any) => r.user_id === 'alice')
    expect(alice).toBeDefined()
    expect(Number(alice.total_value)).toBe(30)
    expect(Number(alice.event_count)).toBe(2)

    await client.end()
  })
})

describe.runIf(process.env.WAVELET_INTEGRATION === '1')('Integration: Full Server', () => {
  let server: WaveletServer
  let port: number

  beforeAll(async () => {
    // Ensure DDL is synced
    const ddl = new DdlManager(DATABASE_URL)
    await ddl.connect()
    await ddl.sync(testConfig)
    await ddl.close()

    // Start server on random port
    server = new WaveletServer({ ...testConfig, server: { port: 0 } })
    await server.start()

    // Get the actual port
    const addr = (server as any).httpServer?.address()
    port = addr?.port
  }, 15000)

  afterAll(async () => {
    await server.stop()

    // Cleanup
    const client = new Client({ connectionString: DATABASE_URL })
    await client.connect()
    try { await client.query(`DROP SUBSCRIPTION IF EXISTS ${SUB_NAME}`) } catch {}
    try { await client.query(`DROP MATERIALIZED VIEW IF EXISTS ${VIEW_NAME}`) } catch {}
    try { await client.query(`DROP TABLE IF EXISTS ${STREAM_NAME}`) } catch {}
    await client.end()
  })

  it('serves health check', async () => {
    const res = await fetch(`http://localhost:${port}/v1/health`)
    const data = await res.json()
    expect(data.status).toBe('ok')
  })

  it('lists views', async () => {
    const res = await fetch(`http://localhost:${port}/v1/views`)
    const data = await res.json()
    expect(data.views).toContain(VIEW_NAME)
  })

  it('writes events via HTTP and reads view', async () => {
    // Write events
    await fetch(`http://localhost:${port}/v1/streams/${STREAM_NAME}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'integration_test', value: 42 }),
    })

    // Wait for MV update
    await new Promise(r => setTimeout(r, 2000))

    // Read view
    const res = await fetch(`http://localhost:${port}/v1/views/${VIEW_NAME}`)
    const data = await res.json()
    expect(data.rows.length).toBeGreaterThan(0)
  })

  it('pushes diffs via WebSocket', async () => {
    const diff = await new Promise<any>((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${port}/subscribe/${VIEW_NAME}`)

      ws.on('message', (data: Buffer) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'connected') {
          // Write event to trigger diff
          fetch(`http://localhost:${port}/v1/streams/${STREAM_NAME}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: 'ws_test_user', value: 7 }),
          })
        }
        if (msg.type === 'diff') {
          ws.close()
          resolve(msg)
        }
      })

      ws.on('error', reject)
      setTimeout(() => { ws.close(); reject(new Error('WebSocket timeout')) }, 15000)
    })

    expect(diff.type).toBe('diff')
    expect(diff.cursor).toBeDefined()
    // Should have at least one insert or update
    expect(diff.inserted.length + diff.updated.length).toBeGreaterThan(0)
  }, 20000)
})
