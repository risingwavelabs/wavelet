import { useState, useEffect, useRef } from 'react'
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

export interface UseWaveletOptions {
  params?: Record<string, string>
  keyBy?: string
}

export interface UseWaveletResult<T> {
  data: T[]
  isLoading: boolean
  error: WaveletError | null
}

export function useWavelet<T = Record<string, unknown>>(
  queryName: string,
  options?: UseWaveletOptions
): UseWaveletResult<T> {
  const [data, setData] = useState<T[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<WaveletError | null>(null)
  const dataRef = useRef<T[]>([])
  const keyBy = options?.keyBy
  const params = options?.params

  useEffect(() => {
    const client = getClient()
    let cancelled = false

    // Initial fetch
    client.query<T>(queryName).get(params).then((rows) => {
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
    const unsub = client.query<T>(queryName).subscribe({
      onData: (diff: Diff<T>) => {
        if (cancelled) return

        if (keyBy) {
          dataRef.current = mergeByKey(dataRef.current, diff, keyBy)
        } else {
          dataRef.current = mergeNaive(dataRef.current, diff)
        }

        setData([...dataRef.current])
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
  }, [queryName, keyBy, JSON.stringify(params)])

  return { data, isLoading, error }
}

/**
 * Key-based merge: uses a specified field as primary key.
 * O(n) using a Map, no JSON.stringify needed.
 */
function mergeByKey<T>(current: T[], diff: Diff<T>, keyBy: string): T[] {
  const map = new Map<unknown, T>()
  for (const row of current) {
    map.set((row as any)[keyBy], row)
  }

  // Remove deleted rows
  for (const row of diff.deleted) {
    map.delete((row as any)[keyBy])
  }

  // Apply updates (replace existing rows by key)
  for (const row of diff.updated) {
    map.set((row as any)[keyBy], row)
  }

  // Add inserted rows
  for (const row of diff.inserted) {
    map.set((row as any)[keyBy], row)
  }

  return Array.from(map.values())
}

/**
 * Naive merge: uses JSON.stringify for equality.
 * Fallback when no keyBy is specified.
 */
function mergeNaive<T>(current: T[], diff: Diff<T>): T[] {
  let result = [...current]

  if (diff.deleted.length > 0) {
    const deletedJson = new Set(diff.deleted.map(r => JSON.stringify(r)))
    result = result.filter(r => !deletedJson.has(JSON.stringify(r)))
  }

  result.push(...diff.inserted)
  result.push(...diff.updated)

  return result
}
