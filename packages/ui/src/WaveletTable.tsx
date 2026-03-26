import React from 'react'
import { getClient } from '@risingwave/wavelet-sdk/react'
import { useWaveletDiff } from './useWaveletDiff.js'
import type { ChangeType } from './useWaveletDiff.js'

export interface WaveletTableColumn {
  key: string
  header: string
  align?: 'left' | 'center' | 'right'
  render?: (value: unknown, row: Record<string, unknown>) => React.ReactNode
}

export interface WaveletTableProps {
  view: string
  keyBy: string
  columns: WaveletTableColumn[]
  sortBy?: string
  sortDirection?: 'asc' | 'desc'
  limit?: number
  params?: Record<string, string>
  changeDuration?: number
  className?: string
  rowClassName?: string | ((row: Record<string, unknown>, change?: ChangeType) => string)
  onRowClick?: (row: Record<string, unknown>) => void
}

export function WaveletTable({
  view,
  keyBy,
  columns,
  sortBy,
  sortDirection = 'desc',
  limit,
  params,
  changeDuration,
  className,
  rowClassName,
  onRowClick,
}: WaveletTableProps) {
  const { data, changes, isLoading, error } = useWaveletDiff<Record<string, unknown>>(
    getClient(),
    view,
    { keyBy, params, changeDuration }
  )

  let rows = data
  if (sortBy) {
    rows = [...rows].sort((a, b) => {
      const av = a[sortBy] as any
      const bv = b[sortBy] as any
      if (av < bv) return sortDirection === 'asc' ? -1 : 1
      if (av > bv) return sortDirection === 'asc' ? 1 : -1
      return 0
    })
  }
  if (limit) {
    rows = rows.slice(0, limit)
  }

  if (error) {
    return <div className="wv-table-error">{error.message}</div>
  }

  if (isLoading) {
    return <div className="wv-table-loading">Loading...</div>
  }

  return (
    <table className={`wv-table ${className ?? ''}`}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} className="wv-table-th" style={{ textAlign: col.align }}>
              {col.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = row[keyBy]
          const change = changes.get(key)
          const rcn = typeof rowClassName === 'function'
            ? rowClassName(row, change)
            : rowClassName ?? ''

          return (
            <tr
              key={String(key)}
              className={`wv-table-row ${rcn}`}
              data-wv-change={change}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
            >
              {columns.map((col) => (
                <td key={col.key} className="wv-table-td" style={{ textAlign: col.align }}>
                  {col.render ? col.render(row[col.key], row) : String(row[col.key] ?? '')}
                </td>
              ))}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
