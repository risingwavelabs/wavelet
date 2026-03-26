import { useState, useEffect, useRef, useCallback } from 'react'
import type { Diff } from '@risingwave/wavelet-sdk'
import { WaveletClient } from '@risingwave/wavelet-sdk'

export type ChangeType = 'inserted' | 'updated' | 'deleted'

export interface UseWaveletDiffOptions {
  keyBy: string
  params?: Record<string, string>
  /** How long change markers persist in ms (default 500) */
  changeDuration?: number
}

export interface UseWaveletDiffResult<T> {
  data: T[]
  changes: Map<unknown, ChangeType>
  isLoading: boolean
  error: Error | null
}

/**
 * Like useWavelet, but tracks which rows changed in the last diff cycle.
 * `changes` is a Map from keyBy value to change type, cleared after `changeDuration` ms.
 */
export function useWaveletDiff<T = Record<string, unknown>>(
  client: WaveletClient,
  viewName: string,
  options: UseWaveletDiffOptions
): UseWaveletDiffResult<T> {
  const { keyBy, params, changeDuration = 500 } = options

  const [data, setData] = useState<T[]>([])
  const [changes, setChanges] = useState<Map<unknown, ChangeType>>(new Map())
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const dataRef = useRef<T[]>([])
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const applyDiff = useCallback((diff: Diff<T>) => {
    const map = new Map<unknown, T>()
    for (const row of dataRef.current) {
      map.set((row as any)[keyBy], row)
    }

    const newChanges = new Map<unknown, ChangeType>()

    for (const row of diff.deleted) {
      const key = (row as any)[keyBy]
      map.delete(key)
      newChanges.set(key, 'deleted')
    }

    for (const row of diff.updated) {
      const key = (row as any)[keyBy]
      map.set(key, row)
      newChanges.set(key, 'updated')
    }

    for (const row of diff.inserted) {
      const key = (row as any)[keyBy]
      map.set(key, row)
      newChanges.set(key, 'inserted')
    }

    dataRef.current = Array.from(map.values())
    setData([...dataRef.current])
    setChanges(newChanges)

    // Clear change markers after duration
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    clearTimerRef.current = setTimeout(() => {
      setChanges(new Map())
    }, changeDuration)
  }, [keyBy, changeDuration])

  useEffect(() => {
    let cancelled = false

    client.view<T>(viewName).get(params).then((rows) => {
      if (cancelled) return
      dataRef.current = rows
      setData(rows)
      setIsLoading(false)
    }).catch((err) => {
      if (cancelled) return
      setError(err instanceof Error ? err : new Error(String(err)))
      setIsLoading(false)
    })

    const unsub = client.view<T>(viewName).subscribe({
      onData: (diff: Diff<T>) => {
        if (cancelled) return
        applyDiff(diff)
      },
      onError: (err) => {
        if (cancelled) return
        setError(err)
      },
    })

    return () => {
      cancelled = true
      unsub()
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
    }
  }, [client, viewName, keyBy, JSON.stringify(params), applyDiff])

  return { data, changes, isLoading, error }
}
