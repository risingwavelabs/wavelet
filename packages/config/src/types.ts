export type ColumnType = 'string' | 'int' | 'float' | 'boolean' | 'timestamp' | 'json'

export interface StreamDef {
  columns: Record<string, ColumnType>
}

export interface ViewDef {
  query: SqlFragment
  filterBy?: string
}

export interface SqlFragment {
  readonly _tag: 'sql'
  readonly text: string
}

export interface WaveletConfig {
  database: string
  streams?: Record<string, StreamDef>
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
