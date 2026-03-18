export type ColumnType = 'string' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'

export interface StreamDef {
  columns: Record<string, ColumnType>
}

export interface PostgresCdcSource {
  type: 'postgres'
  connection: string
  tables: string[]
  slotName?: string
  publicationName?: string
}

export type SourceDef = PostgresCdcSource

export interface ViewDef {
  query: SqlFragment
  filterBy?: string
  columns?: Record<string, ColumnType>
}

export interface SqlFragment {
  readonly _tag: 'sql'
  readonly text: string
}

export interface WaveletConfig {
  database: string
  streams?: Record<string, StreamDef>
  sources?: Record<string, SourceDef>
  views?: Record<string, ViewDef | SqlFragment>
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
