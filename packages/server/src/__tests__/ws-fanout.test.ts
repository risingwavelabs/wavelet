import { EventEmitter } from 'node:events'
import { describe, it, expect, vi } from 'vitest'
import { WebSocket } from 'ws'
import { WebSocketFanout } from '../ws-fanout.js'
import type { BootstrapResult, ViewDiff } from '../cursor-manager.js'

class MockSocket extends EventEmitter {
  readyState: number = WebSocket.OPEN
  sent: string[] = []

  send(message: string): void {
    this.sent.push(message)
  }

  ping(): void {}

  close(): void {
    this.readyState = WebSocket.CLOSED
    this.emit('close')
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('WebSocketFanout', () => {
  it('drops queued shared diffs that are already covered by bootstrap', async () => {
    const bootstrapDeferred = deferred<BootstrapResult>()
    const cursorManager = {
      bootstrap: vi.fn().mockReturnValue(bootstrapDeferred.promise),
    } as any
    const jwt = {
      isConfigured: () => false,
    } as any

    const fanout = new WebSocketFanout(cursorManager, jwt, {
      leaderboard: {} as any,
    })

    const ws = new MockSocket()
    const req = {
      url: '/subscribe/leaderboard',
      headers: { host: 'localhost' },
    } as any

    const connectionPromise = (fanout as any).handleConnection(ws, req)

    fanout.broadcast('leaderboard', {
      cursor: '150',
      inserted: [{ player_id: 'alice', score: 10 }],
      updated: [],
      deleted: [],
    })
    fanout.broadcast('leaderboard', {
      cursor: '300',
      inserted: [{ player_id: 'bob', score: 20 }],
      updated: [],
      deleted: [],
    })

    bootstrapDeferred.resolve({
      snapshotRows: [{ player_id: 'alice', score: 10 }],
      diffs: [{
        cursor: '200',
        inserted: [],
        updated: [{ player_id: 'alice', score: 15 }],
        deleted: [],
      }],
      lastCursor: '200',
    })

    await connectionPromise

    const messages = ws.sent.map((message) => JSON.parse(message))
    expect(messages).toEqual([
      { type: 'connected', query: 'leaderboard' },
      {
        type: 'snapshot',
        query: 'leaderboard',
        rows: [{ player_id: 'alice', score: 10 }],
      },
      {
        type: 'diff',
        query: 'leaderboard',
        cursor: '200',
        inserted: [],
        updated: [{ player_id: 'alice', score: 15 }],
        deleted: [],
      },
      {
        type: 'diff',
        query: 'leaderboard',
        cursor: '300',
        inserted: [{ player_id: 'bob', score: 20 }],
        updated: [],
        deleted: [],
      },
    ])
  })

  it('filters snapshot rows with the same claim rule as diffs', async () => {
    const cursorManager = {
      bootstrap: vi.fn().mockResolvedValue({
        snapshotRows: [
          { user_id: 'u1', total: 10 },
          { user_id: 'u2', total: 20 },
        ],
        diffs: [] as ViewDiff[],
        lastCursor: null,
      }),
    } as any
    const jwt = {
      isConfigured: () => true,
      verify: vi.fn().mockResolvedValue({ user_id: 'u1' }),
    } as any

    const fanout = new WebSocketFanout(cursorManager, jwt, {
      totals: { filterBy: 'user_id' } as any,
    })

    const ws = new MockSocket()
    const req = {
      url: '/subscribe/totals?token=test-token',
      headers: { host: 'localhost' },
    } as any

    await (fanout as any).handleConnection(ws, req)

    const snapshotMessage = JSON.parse(ws.sent[1])
    expect(snapshotMessage).toEqual({
      type: 'snapshot',
      query: 'totals',
      rows: [{ user_id: 'u1', total: 10 }],
    })
  })
})
