import pg from 'pg'
import type { WaveletConfig, StreamDef, ViewDef, SqlFragment } from '@risingwave/wavelet'

const { Client } = pg

export interface DdlAction {
  type: 'create' | 'update' | 'delete' | 'unchanged'
  resource: 'stream' | 'view' | 'subscription'
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

function getViewQuery(viewDef: ViewDef | SqlFragment): string {
  if ('_tag' in viewDef && viewDef._tag === 'sql') return viewDef.text
  return (viewDef as ViewDef).query.text
}

function buildCreateTableSql(name: string, streamDef: StreamDef): string {
  const cols = Object.entries(streamDef.columns)
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
   * Sync all streams, views, and subscriptions to match the config.
   * Returns a list of actions taken.
   * Idempotent - safe to call multiple times.
   */
  async sync(config: WaveletConfig): Promise<DdlAction[]> {
    if (!this.client) throw new Error('Not connected - call connect() first')

    const actions: DdlAction[] = []

    // 1. Fetch existing state from RisingWave
    const existingTables = await this.getExistingTables()
    const existingViews = await this.getExistingViews()
    const existingSubscriptions = await this.getExistingSubscriptions()

    const desiredStreams = config.streams ?? {}
    const desiredViews = config.views ?? {}

    // 2. Determine which streams (tables) to create or remove
    const desiredStreamNames = new Set(Object.keys(desiredStreams))
    const desiredViewNames = new Set(Object.keys(desiredViews))

    // 3. Sync streams - create missing tables
    for (const [streamName, streamDef] of Object.entries(desiredStreams)) {
      if (existingTables.has(streamName)) {
        actions.push({ type: 'unchanged', resource: 'stream', name: streamName })
      } else {
        await this.createTable(streamName, streamDef)
        actions.push({ type: 'create', resource: 'stream', name: streamName })
      }
    }

    // 4. Sync views - create, update, or leave unchanged
    for (const [viewName, viewDef] of Object.entries(desiredViews)) {
      const subName = `wavelet_sub_${viewName}`
      const desiredSql = getViewQuery(viewDef)
      const existingSql = existingViews.get(viewName)

      if (existingSql === undefined) {
        // View does not exist - create MV and subscription
        await this.createMaterializedView(viewName, desiredSql)
        actions.push({ type: 'create', resource: 'view', name: viewName })

        await this.createSubscription(subName, viewName)
        actions.push({ type: 'create', resource: 'subscription', name: subName })
      } else if (normalizeSql(existingSql) !== normalizeSql(desiredSql)) {
        // View SQL changed - drop subscription, drop MV, recreate
        if (existingSubscriptions.has(subName)) {
          await this.dropSubscription(subName)
          actions.push({ type: 'delete', resource: 'subscription', name: subName, detail: 'dropped for view update' })
        }

        await this.dropMaterializedView(viewName)
        actions.push({ type: 'delete', resource: 'view', name: viewName, detail: 'dropped for update' })

        await this.createMaterializedView(viewName, desiredSql)
        actions.push({ type: 'create', resource: 'view', name: viewName, detail: 'recreated with updated SQL' })

        await this.createSubscription(subName, viewName)
        actions.push({ type: 'create', resource: 'subscription', name: subName, detail: 'recreated after view update' })
      } else {
        // View SQL unchanged
        actions.push({ type: 'unchanged', resource: 'view', name: viewName })

        // Ensure subscription exists even if the view is unchanged
        if (!existingSubscriptions.has(subName)) {
          await this.createSubscription(subName, viewName)
          actions.push({ type: 'create', resource: 'subscription', name: subName })
        } else {
          actions.push({ type: 'unchanged', resource: 'subscription', name: subName })
        }
      }
    }

    // 5. Remove views that are no longer in the config
    for (const [existingViewName] of existingViews) {
      if (!desiredViewNames.has(existingViewName)) {
        const subName = `wavelet_sub_${existingViewName}`

        // Drop subscription first
        if (existingSubscriptions.has(subName)) {
          await this.dropSubscription(subName)
          actions.push({ type: 'delete', resource: 'subscription', name: subName, detail: 'view removed from config' })
        }

        await this.dropMaterializedView(existingViewName)
        actions.push({ type: 'delete', resource: 'view', name: existingViewName, detail: 'removed from config' })
      }
    }

    // 6. Remove orphaned subscriptions that are no longer needed
    for (const existingSubName of existingSubscriptions) {
      // Only manage wavelet-prefixed subscriptions
      if (!existingSubName.startsWith('wavelet_sub_')) continue

      const viewName = existingSubName.slice('wavelet_sub_'.length)
      if (!desiredViewNames.has(viewName)) {
        // Already handled in step 5 if the view existed, but handle dangling subs too
        if (!existingViews.has(viewName)) {
          await this.dropSubscription(existingSubName)
          actions.push({ type: 'delete', resource: 'subscription', name: existingSubName, detail: 'orphaned subscription' })
        }
      }
    }

    // 7. Remove streams (tables) that are no longer in the config
    for (const existingTableName of existingTables) {
      if (!desiredStreamNames.has(existingTableName)) {
        // Only drop if no MV depends on it
        const hasDependents = await this.tableHasDependentViews(existingTableName)
        if (hasDependents) {
          console.log(`[ddl-manager] Skipping drop of table "${existingTableName}" - materialized views depend on it`)
          actions.push({
            type: 'unchanged',
            resource: 'stream',
            name: existingTableName,
            detail: 'kept because dependent views exist',
          })
        } else {
          await this.dropTable(existingTableName)
          actions.push({ type: 'delete', resource: 'stream', name: existingTableName, detail: 'removed from config' })
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

  private async getExistingViews(): Promise<Map<string, string>> {
    const result = await this.client!.query(
      `SELECT name, definition FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    const views = new Map<string, string>()
    for (const row of result.rows) {
      views.set(row.name, row.definition)
    }
    return views
  }

  private async getExistingSubscriptions(): Promise<Set<string>> {
    const result = await this.client!.query(
      `SELECT name FROM rw_catalog.rw_subscriptions WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public')`
    )
    return new Set(result.rows.map((r: any) => r.name))
  }

  private async tableHasDependentViews(tableName: string): Promise<boolean> {
    const result = await this.client!.query(
      `SELECT name FROM rw_catalog.rw_materialized_views WHERE schema_id = (SELECT id FROM rw_catalog.rw_schemas WHERE name = 'public') AND definition ILIKE $1`,
      [`%${tableName}%`]
    )
    return result.rows.length > 0
  }

  // ── DDL operations ────────────────────────────────────────────────────

  private async createTable(name: string, streamDef: StreamDef): Promise<void> {
    const sql = buildCreateTableSql(name, streamDef)
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
}
