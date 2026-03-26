import React, { useEffect, useRef, useState } from 'react'
import { getClient } from '@risingwave/wavelet-sdk/react'
import { useWaveletDiff } from './useWaveletDiff.js'

export interface WaveletCounterProps {
  view: string
  keyBy: string
  field: string
  params?: Record<string, string>
  label?: string
  format?: (value: number) => string
  /** Show up/down trend arrow (default true) */
  trend?: boolean
  changeDuration?: number
  className?: string
}

export function WaveletCounter({
  view,
  keyBy,
  field,
  params,
  label,
  format,
  trend = true,
  changeDuration,
  className,
}: WaveletCounterProps) {
  const { data, isLoading, error } = useWaveletDiff<Record<string, unknown>>(
    getClient(),
    view,
    { keyBy, params, changeDuration }
  )

  const prevValueRef = useRef<number | null>(null)
  const [trendDirection, setTrendDirection] = useState<'up' | 'down' | null>(null)

  const rawValue = data.length > 0 ? Number(data[0][field] ?? 0) : 0
  const displayValue = format ? format(rawValue) : String(rawValue)

  useEffect(() => {
    if (prevValueRef.current !== null && trend) {
      if (rawValue > prevValueRef.current) {
        setTrendDirection('up')
      } else if (rawValue < prevValueRef.current) {
        setTrendDirection('down')
      }
    }
    prevValueRef.current = rawValue
  }, [rawValue, trend])

  if (error) {
    return <div className="wv-counter-error">{error.message}</div>
  }

  if (isLoading) {
    return <div className="wv-counter-loading">--</div>
  }

  return (
    <div className={`wv-counter ${className ?? ''}`} data-wv-trend={trendDirection}>
      {label && <div className="wv-counter-label">{label}</div>}
      <div className="wv-counter-value">
        {displayValue}
        {trend && trendDirection && (
          <span className={`wv-counter-trend wv-counter-trend-${trendDirection}`}>
            {trendDirection === 'up' ? '\u2191' : '\u2193'}
          </span>
        )}
      </div>
    </div>
  )
}
