import { describe, it, expect } from 'vitest'
import { sql } from '../sql.js'

describe('sql template tag', () => {
  it('produces a SqlFragment with _tag and text', () => {
    const frag = sql`SELECT 1`
    expect(frag._tag).toBe('sql')
    expect(frag.text).toBe('SELECT 1')
  })

  it('interpolates values', () => {
    const table = 'users'
    const frag = sql`SELECT * FROM ${table}`
    expect(frag.text).toBe('SELECT * FROM users')
  })

  it('trims whitespace', () => {
    const frag = sql`
      SELECT player_id, SUM(score) AS total_score
      FROM game_events
      GROUP BY player_id
    `
    expect(frag.text).toMatch(/^SELECT/)
    expect(frag.text).toMatch(/player_id$/)
    expect(frag.text).not.toMatch(/^\s/)
    expect(frag.text).not.toMatch(/\s$/)
  })

  it('handles empty template', () => {
    const frag = sql``
    expect(frag._tag).toBe('sql')
    expect(frag.text).toBe('')
  })

  it('handles multiple interpolations', () => {
    const col = 'score'
    const limit = 100
    const frag = sql`SELECT ${col} FROM events LIMIT ${limit}`
    expect(frag.text).toBe('SELECT score FROM events LIMIT 100')
  })
})
