import React, { useRef, useEffect } from 'react'
import { getClient } from '@risingwave/wavelet-sdk/react'
import { useWaveletDiff } from './useWaveletDiff.js'
import type { ChangeType } from './useWaveletDiff.js'

export interface WaveletFeedProps<T = Record<string, unknown>> {
  view: string
  keyBy: string
  params?: Record<string, string>
  maxItems?: number
  renderItem: (item: T, change?: ChangeType) => React.ReactNode
  emptyState?: React.ReactNode
  changeDuration?: number
  className?: string
}

export function WaveletFeed<T = Record<string, unknown>>({
  view,
  keyBy,
  params,
  maxItems = 50,
  renderItem,
  emptyState,
  changeDuration,
  className,
}: WaveletFeedProps<T>) {
  const { data, changes, isLoading, error } = useWaveletDiff<T>(
    getClient(),
    view,
    { keyBy, params, changeDuration }
  )

  // Show newest first, capped at maxItems
  const items = data.slice(-maxItems).reverse()

  if (error) {
    return <div className="wv-feed-error">{error.message}</div>
  }

  if (isLoading) {
    return <div className="wv-feed-loading">Loading...</div>
  }

  if (items.length === 0 && emptyState) {
    return <div className="wv-feed-empty">{emptyState}</div>
  }

  return (
    <div className={`wv-feed ${className ?? ''}`}>
      {items.map((item) => {
        const key = (item as any)[keyBy]
        const change = changes.get(key)
        return (
          <div
            key={String(key)}
            className="wv-feed-item"
            data-wv-change={change}
          >
            {renderItem(item, change)}
          </div>
        )
      })}
    </div>
  )
}
