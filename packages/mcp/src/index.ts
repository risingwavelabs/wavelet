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

  // Discover available queries and events
  const queriesList = await discoverQueries(db)
  const eventsList = await discoverEvents(db)

  // Tool: list_queries - List all available Wavelet queries
  server.tool(
    'list_queries',
    'List all queries (materialized views) available in Wavelet. Returns query names and their column schemas.',
    {},
    async () => {
      const result: Record<string, { columns: { name: string; type: string }[] }> = {}

      for (const queryName of queriesList) {
        const cols = await db.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [queryName]
        )
        result[queryName] = {
          columns: cols.rows.map((r: any) => ({ name: r.column_name, type: r.data_type })),
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // Tool: query - Query a materialized view
  server.tool(
    'query',
    'Query a Wavelet query (materialized view). Returns the current pre-computed results. The data is always fresh - queries are incrementally maintained by RisingWave.',
    {
      query: z.string().describe(`Query name. Available: ${queriesList.join(', ')}`),
      filter: z.record(z.string(), z.string()).optional().describe('Optional key-value filters applied as WHERE clauses'),
      limit: z.number().optional().describe('Maximum number of rows to return (default: 100)'),
    },
    async ({ query, filter, limit }) => {
      if (!queriesList.includes(query)) {
        return {
          content: [{ type: 'text' as const, text: `Query '${query}' not found. Available queries: ${queriesList.join(', ')}` }],
          isError: true,
        }
      }

      let sql = `SELECT * FROM ${query}`
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
        content: [{ type: 'text' as const, text: JSON.stringify({ query, rows: result.rows, count: result.rows.length }, null, 2) }],
      }
    }
  )

  // Tool: list_events - List available events
  server.tool(
    'list_events',
    'List all events available in Wavelet. Events are tables that accept event writes.',
    {},
    async () => {
      const result: Record<string, { columns: { name: string; type: string }[] }> = {}

      for (const eventName of eventsList) {
        const cols = await db.query(
          `SELECT column_name, data_type FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
          [eventName]
        )
        result[eventName] = {
          columns: cols.rows.map((r: any) => ({ name: r.column_name, type: r.data_type })),
        }
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      }
    }
  )

  // Tool: emit_event - Write an event
  server.tool(
    'emit_event',
    'Write an event to a Wavelet event table. The event will be processed by RisingWave and any queries that depend on this event table will be updated automatically.',
    {
      event: z.string().describe(`Event name. Available: ${eventsList.join(', ')}`),
      data: z.record(z.string(), z.unknown()).describe('Event data as key-value pairs matching the event columns'),
    },
    async ({ event, data }) => {
      if (!eventsList.includes(event)) {
        return {
          content: [{ type: 'text' as const, text: `Event '${event}' not found. Available events: ${eventsList.join(', ')}` }],
          isError: true,
        }
      }

      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [event]
      )
      const columnNames = cols.rows.map((r: any) => r.column_name)
      const values = columnNames.map((col: string) => data[col])
      const placeholders = columnNames.map((_: string, i: number) => `$${i + 1}`)

      await db.query(
        `INSERT INTO ${event} (${columnNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, event, columns: columnNames }) }],
      }
    }
  )

  // Tool: emit_batch - Write multiple events
  server.tool(
    'emit_batch',
    'Write multiple events to a Wavelet event table in one call. More efficient than calling emit_event repeatedly.',
    {
      event: z.string().describe(`Event name. Available: ${eventsList.join(', ')}`),
      events: z.array(z.record(z.string(), z.unknown())).describe('Array of event data objects'),
    },
    async ({ event, events }) => {
      if (!eventsList.includes(event)) {
        return {
          content: [{ type: 'text' as const, text: `Event '${event}' not found. Available events: ${eventsList.join(', ')}` }],
          isError: true,
        }
      }

      const cols = await db.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
        [event]
      )
      const columnNames = cols.rows.map((r: any) => r.column_name)

      if (events.length === 0) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, event, count: 0 }) }],
        }
      }

      // Build a single INSERT with multiple VALUE rows
      const allValues: unknown[] = []
      const rowPlaceholders: string[] = []

      for (let i = 0; i < events.length; i++) {
        const data = events[i]
        const offset = i * columnNames.length
        const ph = columnNames.map((_: string, j: number) => `$${offset + j + 1}`)
        rowPlaceholders.push(`(${ph.join(', ')})`)
        for (const col of columnNames) {
          allValues.push(data[col])
        }
      }

      await db.query(
        `INSERT INTO ${event} (${columnNames.join(', ')}) VALUES ${rowPlaceholders.join(', ')}`,
        allValues
      )

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, event, count: events.length }) }],
      }
    }
  )

  // Tool: run_sql - Execute a read-only SQL query (scoped to known tables)
  const allowedTables = [...queriesList, ...eventsList]
  server.tool(
    'run_sql',
    `Execute a read-only SQL query. Only SELECT statements are allowed, and queries may only reference known queries and events: ${allowedTables.join(', ')}.`,
    {
      sql: z.string().describe('SQL SELECT query to execute'),
    },
    async ({ sql }) => {
      const normalized = sql.trim().toLowerCase()

      if (!normalized.startsWith('select')) {
        return {
          content: [{ type: 'text' as const, text: 'Only SELECT queries are allowed. Use emit_event to write data.' }],
          isError: true,
        }
      }

      // Check that the query only references allowed tables
      // Extract identifiers from FROM and JOIN clauses
      const fromJoinPattern = /\b(?:from|join)\s+([a-z_][a-z0-9_]*)/gi
      let match
      const referencedTables: string[] = []
      while ((match = fromJoinPattern.exec(normalized)) !== null) {
        referencedTables.push(match[1])
      }

      const disallowed = referencedTables.filter(t => !allowedTables.includes(t))
      if (disallowed.length > 0) {
        return {
          content: [{ type: 'text' as const, text: `Query references tables not managed by Wavelet: ${disallowed.join(', ')}. Allowed tables: ${allowedTables.join(', ')}` }],
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

async function discoverQueries(db: InstanceType<typeof Client>): Promise<string[]> {
  try {
    const result = await db.query(
      `SELECT name FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    return result.rows.map((r: any) => r.name)
  } catch {
    return []
  }
}

async function discoverEvents(db: InstanceType<typeof Client>): Promise<string[]> {
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
