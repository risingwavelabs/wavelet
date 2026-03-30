export interface WaveletClientOptions {
  url: string
  token?: string | (() => string | Promise<string>)
}

export interface Diff<T = Record<string, unknown>> {
  cursor: string
  inserted: T[]
  updated: T[]
  deleted: T[]
}

export interface Snapshot<T = Record<string, unknown>> {
  rows: T[]
}

export interface QueryHandle<T = Record<string, unknown>> {
  get(params?: Record<string, string>): Promise<T[]>
  subscribe(handlers: SubscribeHandlers<T>): Unsubscribe
}

/** @deprecated Use QueryHandle instead */
export type ViewHandle<T = Record<string, unknown>> = QueryHandle<T>

export interface EventHandle<T = Record<string, unknown>> {
  emit(data: T): Promise<void>
  emitBatch(data: T[]): Promise<void>
}

/** @deprecated Use EventHandle instead */
export type StreamHandle<T = Record<string, unknown>> = EventHandle<T>

export interface SubscribeHandlers<T> {
  onOpen?: () => void
  onSnapshot?: (snapshot: Snapshot<T>) => void
  onData: (diff: Diff<T>) => void
  onError?: (error: WaveletError) => void
  onReconnect?: () => void
}

export type Unsubscribe = () => void

export type WaveletErrorCode = 'AUTH_ERROR' | 'QUERY_NOT_FOUND' | 'VIEW_NOT_FOUND' | 'CONNECTION_ERROR' | 'SERVER_ERROR'

export class WaveletError extends Error {
  constructor(
    message: string,
    public readonly code: WaveletErrorCode
  ) {
    super(message)
    this.name = 'WaveletError'
  }
}
