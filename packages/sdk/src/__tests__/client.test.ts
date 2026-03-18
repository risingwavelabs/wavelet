import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WaveletClient } from '../client.js'
import { WaveletError } from '../types.js'

describe('WaveletClient', () => {
  describe('URL construction', () => {
    it('normalizes HTTP URL', () => {
      const client = new WaveletClient({ url: 'http://localhost:8080/' })
      // Access private fields for testing
      expect((client as any).baseUrl).toBe('http://localhost:8080')
      expect((client as any).wsBaseUrl).toBe('ws://localhost:8080')
    })

    it('normalizes HTTPS URL', () => {
      const client = new WaveletClient({ url: 'https://app.wavelet.dev' })
      expect((client as any).baseUrl).toBe('https://app.wavelet.dev')
      expect((client as any).wsBaseUrl).toBe('wss://app.wavelet.dev')
    })

    it('handles path-prefixed URLs (for Wavelet Cloud)', () => {
      const client = new WaveletClient({ url: 'https://wavelet-cloud.fly.dev/p/abc123' })
      expect((client as any).baseUrl).toBe('https://wavelet-cloud.fly.dev/p/abc123')
      expect((client as any).wsBaseUrl).toBe('wss://wavelet-cloud.fly.dev/p/abc123')
    })

    it('strips trailing slash', () => {
      const client = new WaveletClient({ url: 'http://localhost:8080/' })
      expect((client as any).baseUrl).toBe('http://localhost:8080')
    })
  })

  describe('token provider', () => {
    it('handles string token', async () => {
      const client = new WaveletClient({ url: 'http://localhost', token: 'my-token' })
      const provider = (client as any).tokenProvider
      expect(provider).not.toBeNull()
      expect(await provider()).toBe('my-token')
    })

    it('handles sync function token', async () => {
      const client = new WaveletClient({ url: 'http://localhost', token: () => 'dynamic-token' })
      const provider = (client as any).tokenProvider
      expect(await provider()).toBe('dynamic-token')
    })

    it('handles async function token', async () => {
      const client = new WaveletClient({
        url: 'http://localhost',
        token: async () => 'async-token',
      })
      const provider = (client as any).tokenProvider
      expect(await provider()).toBe('async-token')
    })

    it('handles no token', () => {
      const client = new WaveletClient({ url: 'http://localhost' })
      expect((client as any).tokenProvider).toBeNull()
    })
  })

  describe('view().get()', () => {
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('fetches view data', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [{ id: 1, name: 'test' }] }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })
      const result = await client.view('leaderboard').get()

      expect(result).toEqual([{ id: 1, name: 'test' }])
      expect(fetchSpy).toHaveBeenCalledOnce()

      const calledUrl = fetchSpy.mock.calls[0][0]
      expect(calledUrl).toBe('http://localhost:8080/v1/views/leaderboard')
    })

    it('passes query params as filters', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [] }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })
      await client.view('usage').get({ tenant_id: 't1' })

      const calledUrl = fetchSpy.mock.calls[0][0]
      expect(calledUrl).toContain('tenant_id=t1')
    })

    it('sends Authorization header when token is set', async () => {
      fetchSpy.mockResolvedValue({
        ok: true,
        json: async () => ({ rows: [] }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080', token: 'my-jwt' })
      await client.view('leaderboard').get()

      const headers = fetchSpy.mock.calls[0][1].headers
      expect(headers['Authorization']).toBe('Bearer my-jwt')
    })

    it('throws VIEW_NOT_FOUND on 404', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 404,
        json: async () => ({ error: "View 'nope' not found" }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })

      await expect(client.view('nope').get()).rejects.toThrow(WaveletError)
      await expect(client.view('nope').get()).rejects.toMatchObject({
        code: 'VIEW_NOT_FOUND',
      })
    })

    it('throws AUTH_ERROR on 401', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'Unauthorized' }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })

      await expect(client.view('leaderboard').get()).rejects.toMatchObject({
        code: 'AUTH_ERROR',
      })
    })

    it('throws SERVER_ERROR on 500', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal error' }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })

      await expect(client.view('leaderboard').get()).rejects.toMatchObject({
        code: 'SERVER_ERROR',
      })
    })
  })

  describe('stream().emit()', () => {
    let fetchSpy: ReturnType<typeof vi.fn>

    beforeEach(() => {
      fetchSpy = vi.fn()
      vi.stubGlobal('fetch', fetchSpy)
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('posts event to correct URL', async () => {
      fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ ok: true }) })

      const client = new WaveletClient({ url: 'http://localhost:8080' })
      await client.stream('events').emit({ user_id: 'u1', score: 42 })

      expect(fetchSpy).toHaveBeenCalledOnce()
      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toBe('http://localhost:8080/v1/streams/events')
      expect(opts.method).toBe('POST')
      expect(JSON.parse(opts.body)).toEqual({ user_id: 'u1', score: 42 })
    })

    it('posts batch to correct URL', async () => {
      fetchSpy.mockResolvedValue({ ok: true, json: async () => ({ ok: true, count: 2 }) })

      const client = new WaveletClient({ url: 'http://localhost:8080' })
      await client.stream('events').emitBatch([{ a: 1 }, { a: 2 }])

      const [url, opts] = fetchSpy.mock.calls[0]
      expect(url).toBe('http://localhost:8080/v1/streams/events/batch')
      expect(JSON.parse(opts.body)).toEqual([{ a: 1 }, { a: 2 }])
    })

    it('throws on error response', async () => {
      fetchSpy.mockResolvedValue({
        ok: false,
        json: async () => ({ error: "Stream 'nope' not found" }),
      })

      const client = new WaveletClient({ url: 'http://localhost:8080' })
      await expect(client.stream('nope').emit({ x: 1 })).rejects.toThrow(WaveletError)
    })
  })
})
