import { describe, it, expect } from 'vitest'
import { defineConfig } from '../config.js'

describe('defineConfig', () => {
  it('returns the config object unchanged', () => {
    const config = {
      database: 'postgres://root@localhost:4566/dev',
      events: {
        game_events: {
          columns: { user_id: 'string' as const, score: 'int' as const },
        },
      },
      queries: {},
    }
    expect(defineConfig(config)).toBe(config)
  })

  it('accepts minimal config with only database', () => {
    const config = { database: 'postgres://localhost/test' }
    expect(defineConfig(config)).toEqual({ database: 'postgres://localhost/test' })
  })
})
