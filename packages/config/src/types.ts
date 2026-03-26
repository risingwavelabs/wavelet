export type ColumnType = 'string' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'

export interface EventDef {
  columns: Record<string, ColumnType>
}

/** @deprecated Use EventDef instead */
export type StreamDef = EventDef

export interface PostgresCdcSource {
  type: 'postgres'
  connection: string
  tables: string[]
  slotName?: string
  publicationName?: string
}

export type SourceDef = PostgresCdcSource

export interface QueryDef {
  query: SqlFragment
  filterBy?: string
  columns?: Record<string, ColumnType>
  webhook?: string
}

/** @deprecated Use QueryDef instead */
export type ViewDef = QueryDef

export interface SqlFragment {
  readonly _tag: 'sql'
  readonly text: string
}

export interface WaveletConfig {
  database: string
  events?: Record<string, EventDef>
  sources?: Record<string, SourceDef>
  queries?: Record<string, QueryDef | SqlFragment>
  /** @deprecated Use events instead */
  streams?: Record<string, EventDef>
  /** @deprecated Use queries instead */
  views?: Record<string, QueryDef | SqlFragment>
  jwt?: {
    secret?: string
    jwksUrl?: string
    issuer?: string
    audience?: string
  }
  server?: {
    port?: number
    host?: string
  }
}
