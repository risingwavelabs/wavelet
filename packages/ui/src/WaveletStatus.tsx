import React from 'react'
import { useWavelet } from '@risingwave/wavelet-sdk/react'

export interface WaveletStatusProps {
  /** Any view name to monitor connectivity */
  view: string
  labels?: {
    connected?: string
    loading?: string
    error?: string
  }
  className?: string
}

/**
 * Shows current connection status based on a view subscription.
 * Uses the existing useWavelet hook to derive state.
 */
export function WaveletStatus({
  view,
  labels,
  className,
}: WaveletStatusProps) {
  const { isLoading, error } = useWavelet(view)

  let status: 'connected' | 'loading' | 'error'
  let label: string

  if (error) {
    status = 'error'
    label = labels?.error ?? 'Offline'
  } else if (isLoading) {
    status = 'loading'
    label = labels?.loading ?? 'Connecting...'
  } else {
    status = 'connected'
    label = labels?.connected ?? 'Live'
  }

  return (
    <span className={`wv-status ${className ?? ''}`} data-wv-status={status}>
      <span className="wv-status-dot" />
      <span className="wv-status-label">{label}</span>
    </span>
  )
}
