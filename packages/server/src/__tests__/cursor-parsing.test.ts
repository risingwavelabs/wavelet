import { describe, it, expect } from 'vitest'
import { CursorManager } from '../cursor-manager.js'

// Access private parseDiffs via cast
function parseDiffs(rows: any[]) {
  const cm = new CursorManager('postgres://dummy', {})
  return (cm as any).parseDiffs(rows)
}

describe('parseDiffs', () => {
  it('parses Insert ops (string form)', () => {
    const rows = [
      { op: 'Insert', rw_timestamp: '100', player_id: 'alice', score: 42 },
    ]
    const diff = parseDiffs(rows)
    expect(diff.inserted).toHaveLength(1)
    expect(diff.inserted[0]).toEqual({ player_id: 'alice', score: 42 })
    expect(diff.deleted).toHaveLength(0)
    expect(diff.updated).toHaveLength(0)
  })

  it('parses Insert ops (numeric form)', () => {
    const rows = [
      { op: '1', rw_timestamp: '100', name: 'bob' },
    ]
    const diff = parseDiffs(rows)
    expect(diff.inserted).toHaveLength(1)
    expect(diff.inserted[0]).toEqual({ name: 'bob' })
  })

  it('parses Delete ops', () => {
    const rows = [
      { op: 'Delete', rw_timestamp: '200', player_id: 'alice' },
    ]
    const diff = parseDiffs(rows)
    expect(diff.deleted).toHaveLength(1)
    expect(diff.deleted[0]).toEqual({ player_id: 'alice' })
  })

  it('parses Update ops (UpdateDelete + UpdateInsert)', () => {
    const rows = [
      { op: 'UpdateDelete', rw_timestamp: '300', player_id: 'alice', score: 10 },
      { op: 'UpdateInsert', rw_timestamp: '300', player_id: 'alice', score: 20 },
    ]
    const diff = parseDiffs(rows)
    expect(diff.deleted).toHaveLength(1)
    expect(diff.deleted[0]).toEqual({ player_id: 'alice', score: 10 })
    expect(diff.updated).toHaveLength(1)
    expect(diff.updated[0]).toEqual({ player_id: 'alice', score: 20 })
  })

  it('returns empty diff for no rows', () => {
    const diff = parseDiffs([])
    expect(diff.inserted).toHaveLength(0)
    expect(diff.updated).toHaveLength(0)
    expect(diff.deleted).toHaveLength(0)
    expect(diff.cursor).toBe('')
  })

  it('extracts cursor from last rw_timestamp', () => {
    const rows = [
      { op: 'Insert', rw_timestamp: '100', x: 1 },
      { op: 'Insert', rw_timestamp: '200', x: 2 },
    ]
    const diff = parseDiffs(rows)
    expect(diff.cursor).toBe('200')
  })
})
