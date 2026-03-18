import { useState, useEffect, useRef, useCallback } from 'react'
import { WaveletClient } from './client.js'
import type { Diff, WaveletClientOptions } from './types.js'
import { WaveletError } from './types.js'

let globalClient: WaveletClient | null = null

export function initWavelet(options: WaveletClientOptions): void {
  globalClient = new WaveletClient(options)
}

export function getClient(): WaveletClient {
  if (!globalClient) {
    throw new WaveletError(
      'Wavelet client not initialized. Call initWavelet({ url: "..." }) first.',
      'CONNECTION_ERROR'
    )
  }
  return globalClient
}

export interface UseWaveletResult<T> {
  data: T[]
  isLoading: boolean
  error: WaveletError | null
}

export function useWavelet<T = Record<string, unknown>>(
  viewName: string,
  params?: Record<string, string>
): UseWaveletResult<T> {
  const [data, setData] = useState<T[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<WaveletError | null>(null)
  const dataRef = useRef<T[]>([])

  useEffect(() => {
    const client = getClient()
    let cancelled = false

    // Initial fetch
    client.view<T>(viewName).get(params).then((rows) => {
      if (cancelled) return
      dataRef.current = rows
      setData(rows)
      setIsLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof WaveletError ? err : new WaveletError(err.message, 'SERVER_ERROR'))
      setIsLoading(false)
    })

    // Subscribe to updates
    const unsub = client.view<T>(viewName).subscribe({
      onData: (diff: Diff<T>) => {
        if (cancelled) return
        // Simple merge: this is a naive approach, replace with key-based merge in production
        let current = [...dataRef.current]

        // Remove deleted rows (by reference equality on all fields)
        if (diff.deleted.length > 0) {
          const deletedJson = new Set(diff.deleted.map(r => JSON.stringify(r)))
          current = current.filter(r => !deletedJson.has(JSON.stringify(r)))
        }

        // Add inserted rows
        current.push(...diff.inserted)

        // For updates: remove old, add new (updates come as pairs)
        current.push(...diff.updated)

        dataRef.current = current
        setData(current)
      },
      onError: (err) => {
        if (cancelled) return
        setError(err)
      },
    })

    return () => {
      cancelled = true
      unsub()
    }
  }, [viewName, JSON.stringify(params)])

  return { data, isLoading, error }
}
