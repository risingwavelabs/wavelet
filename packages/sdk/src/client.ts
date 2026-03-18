import type { WaveletClientOptions, ViewHandle, StreamHandle, SubscribeHandlers, Diff, Unsubscribe } from './types.js'
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

  view<T = Record<string, unknown>>(name: string): ViewHandle<T> {
    return {
      get: (params) => this.getView<T>(name, params),
      subscribe: (handlers) => this.subscribeView<T>(name, handlers),
    }
  }

  stream<T = Record<string, unknown>>(name: string): StreamHandle<T> {
    return {
      emit: (data) => this.emitEvent(name, data),
      emitBatch: (data) => this.emitBatch(name, data),
    }
  }

  private async getView<T>(name: string, params?: Record<string, string>): Promise<T[]> {
    const url = new URL(`${this.baseUrl}/v1/views/${name}`)
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
      if (res.status === 404) throw new WaveletError(body.error ?? `View '${name}' not found`, 'VIEW_NOT_FOUND')
      if (res.status === 401) throw new WaveletError(body.error ?? 'Authentication required', 'AUTH_ERROR')
      throw new WaveletError(body.error ?? `Server error: ${res.status}`, 'SERVER_ERROR')
    }

    const data = await res.json()
    return data.rows as T[]
  }

  private subscribeView<T>(name: string, handlers: SubscribeHandlers<T>): Unsubscribe {
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

  private async emitEvent(streamName: string, data: unknown): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`
    }

    const res = await fetch(`${this.baseUrl}/v1/streams/${streamName}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new WaveletError(body.error ?? `Failed to emit to '${streamName}'`, 'SERVER_ERROR')
    }
  }

  private async emitBatch(streamName: string, data: unknown[]): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.tokenProvider) {
      headers['Authorization'] = `Bearer ${await this.tokenProvider()}`
    }

    const res = await fetch(`${this.baseUrl}/v1/streams/${streamName}/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    })

    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new WaveletError(body.error ?? `Failed to batch emit to '${streamName}'`, 'SERVER_ERROR')
    }
  }
}
