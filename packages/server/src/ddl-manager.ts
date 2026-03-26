import pg from 'pg'
import type { WaveletConfig, EventDef, QueryDef, SqlFragment, PostgresCdcSource } from '@risingwave/wavelet'

const { Client } = pg

export interface DdlAction {
  type: 'create' | 'update' | 'delete' | 'unchanged'
  resource: 'event' | 'source' | 'query' | 'subscription'
  name: string
  detail?: string
}

const COLUMN_TYPE_MAP: Record<string, string> = {
  string: 'VARCHAR',
  int: 'INT',
  float: 'DOUBLE',
  boolean: 'BOOLEAN',
  timestamp: 'TIMESTAMPTZ',
  json: 'JSONB',
}

function normalizeSql(sql: string): string {
  // RisingWave stores definitions as "CREATE MATERIALIZED VIEW name AS SELECT ..."
  // Strip the prefix to compare just the query part
  const stripped = sql.replace(/^create\s+materialized\s+view\s+\S+\s+as\s+/i, '')
  return stripped.replace(/\s+/g, ' ').trim().toLowerCase()
}

function getQuerySql(queryDef: QueryDef | SqlFragment): string {
  if ('_tag' in queryDef && queryDef._tag === 'sql') return queryDef.text
  return (queryDef as QueryDef).query.text
}

function buildCreateTableSql(name: string, eventDef: EventDef): string {
  const cols = Object.entries(eventDef.columns)
    .map(([colName, colType]) => {
      const sqlType = COLUMN_TYPE_MAP[colType]
      if (!sqlType) throw new Error(`Unknown column type "${colType}" for column "${colName}"`)
      return `${colName} ${sqlType}`
    })
    .join(', ')
  return `CREATE TABLE ${name} (${cols})`
}

export class DdlManager {
  private client: InstanceType<typeof Client> | null = null

  constructor(private connectionString: string) {}

  async connect(): Promise<void> {
    this.client = new Client({ connectionString: this.connectionString })
    await this.client.connect()
    console.log('[ddl-manager] Connected to RisingWave')
  }

  async close(): Promise<void> {
    await this.client?.end()
    this.client = null
    console.log('[ddl-manager] Connection closed')
  }

  /**
   * Sync all events, queries, and subscriptions to match the config.
   * Returns a list of actions taken.
   * Idempotent - safe to call multiple times.
   */
  async sync(config: WaveletConfig): Promise<DdlAction[]> {
    if (!this.client) throw new Error('Not connected - call connect() first')

    const actions: DdlAction[] = []

    // 1. Fetch existing state from RisingWave
    const existingTables = await this.getExistingTables()
    const existingMVs = await this.getExistingMaterializedViews()
    const existingSubscriptions = await this.getExistingSubscriptions()

    const desiredEvents = config.events ?? config.streams ?? {}
    const desiredSources = config.sources ?? {}
    const desiredQueries = config.queries ?? config.views ?? {}

    // 2. Determine which events (tables) to create or remove
    const desiredEventNames = new Set(Object.keys(desiredEvents))
    const desiredQueryNames = new Set(Object.keys(desiredQueries))

    // 3. Sync events - create missing tables
    for (const [eventName, eventDef] of Object.entries(desiredEvents)) {
      if (existingTables.has(eventName)) {
        actions.push({ type: 'unchanged', resource: 'event', name: eventName })
      } else {
        await this.createTable(eventName, eventDef)
        actions.push({ type: 'create', resource: 'event', name: eventName })
      }
    }

    // 3b. Sync CDC sources - create Postgres CDC tables
    const existingSources = await this.getExistingSources()
    for (const [sourceName, sourceDef] of Object.entries(desiredSources)) {
      if (sourceDef.type === 'postgres') {
        for (const tableName of sourceDef.tables) {
          const cdcTableName = `${sourceName}_${tableName}`
          if (existingSources.has(cdcTableName) || existingTables.has(cdcTableName)) {
            actions.push({ type: 'unchanged', resource: 'source', name: cdcTableName })
          } else {
            await this.createCdcSource(sourceName, tableName, sourceDef)
            actions.push({ type: 'create', resource: 'source', name: cdcTableName })
          }
        }
      }
    }

    // 4. Sync queries - create, update, or leave unchanged
    for (const [queryName, queryDef] of Object.entries(desiredQueries)) {
      const subName = `wavelet_sub_${queryName}`
      const desiredSql = getQuerySql(queryDef)
      const existingSql = existingMVs.get(queryName)

      if (existingSql === undefined) {
        // MV does not exist - create MV and subscription
        await this.createMaterializedView(queryName, desiredSql)
        actions.push({ type: 'create', resource: 'query', name: queryName })

        await this.createSubscription(subName, queryName)
        actions.push({ type: 'create', resource: 'subscription', name: subName })
      } else if (normalizeSql(existingSql) !== normalizeSql(desiredSql)) {
        // Query SQL changed - drop subscription, drop MV, recreate
        if (existingSubscriptions.has(subName)) {
          await this.dropSubscription(subName)
          actions.push({ type: 'delete', resource: 'subscription', name: subName, detail: 'dropped for query update' })
        }

        await this.dropMaterializedView(queryName)
        actions.push({ type: 'delete', resource: 'query', name: queryName, detail: 'dropped for update' })

        await this.createMaterializedView(queryName, desiredSql)
        actions.push({ type: 'create', resource: 'query', name: queryName, detail: 'recreated with updated SQL' })

        await this.createSubscription(subName, queryName)
        actions.push({ type: 'create', resource: 'subscription', name: subName, detail: 'recreated after query update' })
      } else {
        // Query SQL unchanged
        actions.push({ type: 'unchanged', resource: 'query', name: queryName })

        // Ensure subscription exists even if the query is unchanged
        if (!existingSubscriptions.has(subName)) {
          await this.createSubscription(subName, queryName)
          actions.push({ type: 'create', resource: 'subscription', name: subName })
        } else {
          actions.push({ type: 'unchanged', resource: 'subscription', name: subName })
        }
      }
    }

    // 5. Remove queries that are no longer in the config
    for (const [existingMVName] of existingMVs) {
      if (!desiredQueryNames.has(existingMVName)) {
        const subName = `wavelet_sub_${existingMVName}`

        // Drop subscription first
        if (existingSubscriptions.has(subName)) {
          await this.dropSubscription(subName)
          actions.push({ type: 'delete', resource: 'subscription', name: subName, detail: 'query removed from config' })
        }

        await this.dropMaterializedView(existingMVName)
        actions.push({ type: 'delete', resource: 'query', name: existingMVName, detail: 'removed from config' })
      }
    }

    // 6. Remove orphaned subscriptions that are no longer needed
    for (const existingSubName of existingSubscriptions) {
      // Only manage wavelet-prefixed subscriptions
      if (!existingSubName.startsWith('wavelet_sub_')) continue

      const queryName = existingSubName.slice('wavelet_sub_'.length)
      if (!desiredQueryNames.has(queryName)) {
        // Already handled in step 5 if the MV existed, but handle dangling subs too
        if (!existingMVs.has(queryName)) {
          await this.dropSubscription(existingSubName)
          actions.push({ type: 'delete', resource: 'subscription', name: existingSubName, detail: 'orphaned subscription' })
        }
      }
    }

    // 7. Remove events (tables) that are no longer in the config
    for (const existingTableName of existingTables) {
      if (!desiredEventNames.has(existingTableName)) {
        // Only drop if no MV depends on it
        const hasDependents = await this.tableHasDependentMVs(existingTableName)
        if (hasDependents) {
          console.log(`[ddl-manager] Skipping drop of table "${existingTableName}" - materialized views depend on it`)
          actions.push({
            type: 'unchanged',
            resource: 'event',
            name: existingTableName,
            detail: 'kept because dependent materialized views exist',
          })
        } else {
          await this.dropTable(existingTableName)
          actions.push({ type: 'delete', resource: 'event', name: existingTableName, detail: 'removed from config' })
        }
      }
    }

    return actions
  }

  // ── Query helpers ─────────────────────────────────────────────────────

  private async getExistingTables(): Promise<Set<string>> {
    const result = await this.client!.query(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
    )
    return new Set(result.rows.map((r: any) => r.table_name))
  }

  private async getExistingMaterializedViews(): Promise<Map<string, string>> {
    const result = await this.client!.query(
      `SELECT name, definition FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    const views = new Map<string, string>()
    for (const row of result.rows) {
      views.set(row.name, row.definition)
    }
    return views
  }

  private async getExistingSources(): Promise<Set<string>> {
    try {
      const result = await this.client!.query(
        `SELECT name FROM rw_catalog.rw_tables WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public') AND is_index = false`
      )
      return new Set(result.rows.map((r: any) => r.name))
    } catch {
      // Fallback: if catalog query fails, return empty set
      return new Set()
    }
  }

  private async getExistingSubscriptions(): Promise<Set<string>> {
    const result = await this.client!.query(
      `SELECT name FROM rw_catalog.rw_subscriptions WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    return new Set(result.rows.map((r: any) => r.name))
  }

  private async tableHasDependentMVs(tableName: string): Promise<boolean> {
    const result = await this.client!.query(
      `SELECT name FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public') AND definition ILIKE $1`,
      [`%${tableName}%`]
    )
    return result.rows.length > 0
  }

  // ── DDL operations ────────────────────────────────────────────────────

  private async createTable(name: string, eventDef: EventDef): Promise<void> {
    const sql = buildCreateTableSql(name, eventDef)
    try {
      await this.client!.query(sql)
      console.log(`[ddl-manager] Created table: ${name}`)
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`[ddl-manager] Table already exists: ${name}`)
      } else {
        throw err
      }
    }
  }

  private async dropTable(name: string): Promise<void> {
    try {
      await this.client!.query(`DROP TABLE ${name}`)
      console.log(`[ddl-manager] Dropped table: ${name}`)
    } catch (err: any) {
      if (err.message?.includes('does not exist')) {
        console.log(`[ddl-manager] Table already gone: ${name}`)
      } else {
        throw err
      }
    }
  }

  private async createMaterializedView(name: string, sql: string): Promise<void> {
    try {
      await this.client!.query(`CREATE MATERIALIZED VIEW ${name} AS ${sql}`)
      console.log(`[ddl-manager] Created materialized view: ${name}`)
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`[ddl-manager] Materialized view already exists: ${name}`)
      } else {
        throw err
      }
    }
  }

  private async dropMaterializedView(name: string): Promise<void> {
    try {
      await this.client!.query(`DROP MATERIALIZED VIEW ${name}`)
      console.log(`[ddl-manager] Dropped materialized view: ${name}`)
    } catch (err: any) {
      if (err.message?.includes('does not exist')) {
        console.log(`[ddl-manager] Materialized view already gone: ${name}`)
      } else {
        throw err
      }
    }
  }

  private async createSubscription(subName: string, viewName: string): Promise<void> {
    try {
      await this.client!.query(
        `CREATE SUBSCRIPTION ${subName} FROM ${viewName} WITH (retention = '24h')`
      )
      console.log(`[ddl-manager] Created subscription: ${subName}`)
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`[ddl-manager] Subscription already exists: ${subName}`)
      } else {
        throw err
      }
    }
  }

  private async dropSubscription(subName: string): Promise<void> {
    try {
      await this.client!.query(`DROP SUBSCRIPTION ${subName}`)
      console.log(`[ddl-manager] Dropped subscription: ${subName}`)
    } catch (err: any) {
      if (err.message?.includes('does not exist')) {
        console.log(`[ddl-manager] Subscription already gone: ${subName}`)
      } else {
        throw err
      }
    }
  }

  private async createCdcSource(
    sourceName: string,
    tableName: string,
    source: PostgresCdcSource
  ): Promise<void> {
    const cdcTableName = `${sourceName}_${tableName}`
    const slotName = source.slotName ?? `wavelet_${sourceName}`
    const pubName = source.publicationName ?? `wavelet_${sourceName}_pub`

    // RisingWave CDC source syntax:
    // CREATE TABLE table_name ( ... ) WITH (
    //   connector = 'postgres-cdc',
    //   hostname = '...',
    //   port = '...',
    //   username = '...',
    //   password = '...',
    //   database.name = '...',
    //   table.name = '...',
    //   slot.name = '...',
    //   publication.name = '...'
    // )
    // We parse the connection string to extract components.

    const parsed = parsePostgresUrl(source.connection)

    const esc = (s: string) => s.replace(/'/g, "''")
    try {
      await this.client!.query(`
        CREATE TABLE IF NOT EXISTS ${cdcTableName} (*)
        WITH (
          connector = 'postgres-cdc',
          hostname = '${esc(parsed.host)}',
          port = '${esc(parsed.port)}',
          username = '${esc(parsed.user)}',
          password = '${esc(parsed.password)}',
          database.name = '${esc(parsed.database)}',
          schema.name = '${esc(parsed.schema)}',
          table.name = '${esc(tableName)}',
          slot.name = '${esc(slotName)}',
          publication.name = '${esc(pubName)}'
        )
      `)
      console.log(`[ddl-manager] Created CDC source: ${cdcTableName} (from ${parsed.host}/${parsed.database}.${tableName})`)
    } catch (err: any) {
      if (err.message?.includes('already exists')) {
        console.log(`[ddl-manager] CDC source already exists: ${cdcTableName}`)
      } else {
        throw err
      }
    }
  }
}

function parsePostgresUrl(url: string): {
  host: string
  port: string
  user: string
  password: string
  database: string
  schema: string
} {
  // Parse postgresql://user:password@host:port/database?schema=xxx
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || 'postgres',
    schema: u.searchParams.get('schema') ?? 'public',
  }
}
