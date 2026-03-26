import type { WaveletClientOptions, QueryHandle, EventHandle, SubscribeHandlers, Diff, Unsubscribe } from './types.js'
import { WaveletError } from './types.js'

export class WaveletClient {
  private baseUrl: string
  private wsBaseUrl: string
  private tokenProvider: (() => Promise<string>) | null

  constructor(private options: WaveletClientOptions) {
    // Normalize URLs
    this.baseUrl = options.url.replace(/\/$/, '').replace(/^ws/, 'http')
    this.wsBaseUrl = options.url.replace(/\/$/, '').replace(/^http/, 'ws')

    if (typeof options.token === 'function') {
      const fn = options.token
      this.tokenProvider = async () => {
        const t = fn()
        return t instanceof Promise ? t : t
      }
    } else if (typeof options.token === 'string') {
      const t = options.token
      this.tokenProvider = async () => t
    } else {
      this.tokenProvider = null
    }
  }

  query<T = Record<string, unknown>>(name: string): QueryHandle<T> {
    return {
      get: (params) => this.getQuery<T>(name, params),
      subscribe: (handlers) => this.subscribeQuery<T>(name, handlers),
    }
  }

  /** @deprecated Use query() instead */
  view<T = Record<string, unknown>>(name: string): QueryHandle<T> {
    return this.query<T>(name)
  }

  event<T = Record<string, unknown>>(name: string): EventHandle<T> {
    return {
      emit: (data) => this.emitEvent(name, data),
      emitBatch: (data) => this.emitBatch(name, data),
    }
  }

  /** @deprecated Use event() instead */
  stream<T = Record<string, unknown>>(name: string): EventHandle<T> {
    return this.event<T>(name)
  }

  private async getQuery<T>(name: string, params?: Record<string, string>): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/v1/queries/${name}`)
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v)
      }
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`
    }

    const res = await fetch(url.toString(), { headers })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      if (res.status === 404) throw new WaveletError(body.error ?? `Query '${name}' not found`, 'QUERY_NOT_FOUND')
      if (res.status === 401) throw new WaveletError(body.error ?? 'Authentication required', 'AUTH_ERROR')
      throw new WaveletError(body.error ?? `Server error: ${res.status}`, 'SERVER_ERROR')
    }

    const data = await res.json()
    return data.rows as T[]
  }

  private subscribeQuery<T>(name: string, handlers: SubscribeHandlers<T>): Unsubscribe {
    let ws: WebSocket | null = null
    let closed = false
    let reconnectAttempt = 0
    const maxReconnectDelay = 30000
    let lastCursor: string | null = null

    const connect = async () => {
      if (closed) return

      let url = `${this.wsBaseUrl}/subscribe/${name}`
      if (this.tokenProvider) {
        const token = await this.tokenProvider()
        url += `?token=${encodeURIComponent(token)}`
      }
      if (lastCursor) {
        url += `${url.includes('?') ? '&' : '?'}cursor=${encodeURIComponent(lastCursor)}`
      }

      ws = new WebSocket(url)

      ws.onopen = () => {
        reconnectAttempt = 0
        handlers.onOpen?.()
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(typeof event.data === 'string' ? event.data : '')
          if (msg.type === 'diff') {
            lastCursor = msg.cursor
            handlers.onData({
              cursor: msg.cursor,
              inserted: msg.inserted ?? [],
              updated: msg.updated ?? [],
              deleted: msg.deleted ?? [],
            } as Diff<T>)
          }
        } catch (err: any) {
          handlers.onError?.(new WaveletError(err.message, 'SERVER_ERROR'))
        }
      }

      ws.onerror = () => {
        // onclose will fire next
      }

      ws.onclose = (event) => {
        if (closed) return

        if (event.code === 4000) {
          // Server rejected connection (auth error, view not found)
          handlers.onError?.(new WaveletError(event.reason, 'AUTH_ERROR'))
          return
        }

        // Reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), maxReconnectDelay)
        reconnectAttempt++
        setTimeout(() => {
          handlers.onReconnect?.()
          connect()
        }, delay)
      }
    }

    connect()

    return () => {
      closed = true
      ws?.close()
    }
  }

  private async emitEvent(eventName: string, data: unknown): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`
    }

    const res = await fetch(`${this.baseUrl}/v1/events/${eventName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new WaveletError(body.error ?? `Failed to emit to '${eventName}'`, 'SERVER_ERROR')
    }
  }

  private async emitBatch(eventName: string, data: unknown[]): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`
    }

    const res = await fetch(`${this.baseUrl}/v1/events/${eventName}/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new WaveletError(body.error ?? `Failed to batch emit to '${eventName}'`, 'SERVER_ERROR')
    }
  }
}
