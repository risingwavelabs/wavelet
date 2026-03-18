#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import pg from 'pg'

const { Client } = pg

const DATABASE_URL = process.env.WAVELET_DATABASE_URL ?? 'postgres://root@localhost:4566/dev'

async function main() {
  const server = new McpServer({
    name: 'wavelet',
    version: '0.1.0',
  })

  const db = new Client({ connectionString: DATABASE_URL })
  await db.connect()

  // Discover available views and streams
  const views = await discoverViews(db)
  const streams = await discoverStreams(db)

  // Tool: list_views - List all available Wavelet views
  server.tool(
    'list_views',
    'List all materialized views available in Wavelet. Returns view names and their column schemas.',
    {},
    async () => {
      const result: Record<string, { columns: { name: string; type: string }[] }> = {}

      for (const viewName of views) {
        const cols = await db.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [viewName]
        )
        result[viewName] = {
          columns: cols.rows.map((r: any) => ({ name: r.column_name, type: r.data_type })),
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // Tool: query_view - Query a materialized view
  server.tool(
    'query_view',
    'Query a Wavelet materialized view. Returns the current pre-computed results. The data is always fresh - views are incrementally maintained by RisingWave.',
    {
      view: z.string().describe(`View name. Available: ${views.join(', ')}`),
      filter: z.record(z.string(), z.string()).optional().describe('Optional key-value filters applied as WHERE clauses'),
      limit: z.number().optional().describe('Maximum number of rows to return (default: 100)'),
    },
    async ({ view, filter, limit }) => {
      if (!views.includes(view)) {
        return {
          content: [{ type: 'text' as const, text: `View '${view}' not found. Available views: ${views.join(', ')}` }],
          isError: true,
        }
      }

      let sql = `SELECT * FROM ${view}`
      const values: unknown[] = []

      if (filter && Object.keys(filter).length > 0) {
        const conditions = Object.entries(filter).map(([key, val], i) => {
          values.push(val)
          return `${key} = $${i + 1}`
        })
        sql += ` WHERE ${conditions.join(' AND ')}`
      }

      sql += ` LIMIT ${limit ?? 100}`

      const result = await db.query(sql, values)

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ view, rows: result.rows, count: result.rows.length }, null, 2) }],
      }
    }
  )

  // Tool: list_streams - List available event streams
  server.tool(
    'list_streams',
    'List all event streams available in Wavelet. Streams are tables that accept event writes.',
    {},
    async () => {
      const result: Record<string, { columns: { name: string; type: string }[] }> = {}

      for (const streamName of streams) {
        const cols = await db.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [streamName]
        )
        result[streamName] = {
          columns: cols.rows.map((r: any) => ({ name: r.column_name, type: r.data_type })),
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // Tool: emit_event - Write an event to a stream
  server.tool(
    'emit_event',
    'Write an event to a Wavelet stream. The event will be processed by RisingWave and any materialized views that depend on this stream will be updated automatically.',
    {
      stream: z.string().describe(`Stream name. Available: ${streams.join(', ')}`),
      data: z.record(z.string(), z.unknown()).describe('Event data as key-value pairs matching the stream columns'),
    },
    async ({ stream, data }) => {
      if (!streams.includes(stream)) {
        return {
          content: [{ type: 'text' as const, text: `Stream '${stream}' not found. Available streams: ${streams.join(', ')}` }],
          isError: true,
        }
      }

      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [stream]
      )
      const columnNames = cols.rows.map((r: any) => r.column_name)
      const values = columnNames.map((col: string) => data[col])
      const placeholders = columnNames.map((_: string, i: number) => `$${i + 1}`)

      await db.query(
        `INSERT INTO ${stream} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, stream, columns: columnNames }) }],
      }
    }
  )

  // Tool: emit_batch - Write multiple events to a stream
  server.tool(
    'emit_batch',
    'Write multiple events to a Wavelet stream in one call. More efficient than calling emit_event repeatedly.',
    {
      stream: z.string().describe(`Stream name. Available: ${streams.join(', ')}`),
      events: z.array(z.record(z.string(), z.unknown())).describe('Array of event data objects'),
    },
    async ({ stream, events }) => {
      if (!streams.includes(stream)) {
        return {
          content: [{ type: 'text' as const, text: `Stream '${stream}' not found. Available streams: ${streams.join(', ')}` }],
          isError: true,
        }
      }

      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [stream]
      )
      const columnNames = cols.rows.map((r: any) => r.column_name)

      let count = 0
      for (const data of events) {
        const values = columnNames.map((col: string) => data[col])
        const placeholders = columnNames.map((_: string, i: number) => `$${i + 1}`)
        await db.query(
          `INSERT INTO ${stream} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
          values
        )
        count++
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, stream, count }) }],
      }
    }
  )

  // Tool: run_sql - Execute a read-only SQL query (for advanced use)
  server.tool(
    'run_sql',
    'Execute a read-only SQL query against the Wavelet database. Use this for ad-hoc queries that go beyond what query_view provides. Only SELECT statements are allowed.',
    {
      sql: z.string().describe('SQL SELECT query to execute'),
    },
    async ({ sql }) => {
      if (!sql.trim().toLowerCase().startsWith('select')) {
        return {
          content: [{ type: 'text' as const, text: 'Only SELECT queries are allowed. Use emit_event to write data.' }],
          isError: true,
        }
      }

      const result = await db.query(sql)
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ rows: result.rows, count: result.rows.length }, null, 2) }],
      }
    }
  )

  // Start the MCP server on stdio
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

async function discoverViews(db: InstanceType<typeof Client>): Promise<string[]> {
  try {
    const result = await db.query(
      `SELECT name FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    return result.rows.map((r: any) => r.name)
  } catch {
    return []
  }
}

async function discoverStreams(db: InstanceType<typeof Client>): Promise<string[]> {
  try {
    const result = await db.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
    return result.rows.map((r: any) => r.table_name)
  } catch {
    return []
  }
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
