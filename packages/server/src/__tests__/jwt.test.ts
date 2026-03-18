import { describe, it, expect } from 'vitest'
import { JwtVerifier } from '../jwt.js'
import * as jose from 'jose'

describe('JwtVerifier', () => {
  it('isConfigured returns false with no config', () => {
    const v = new JwtVerifier()
    expect(v.isConfigured()).toBe(false)
  })

  it('isConfigured returns true with secret', () => {
    const v = new JwtVerifier({ secret: 'test-secret' })
    expect(v.isConfigured()).toBe(true)
  })

  it('isConfigured returns true with jwksUrl', () => {
    const v = new JwtVerifier({ jwksUrl: 'https://example.com/.well-known/jwks.json' })
    expect(v.isConfigured()).toBe(true)
  })

  it('verifies a valid HS256 JWT', async () => {
    const secret = 'my-test-secret-that-is-long-enough'
    const v = new JwtVerifier({ secret })

    const encodedSecret = new TextEncoder().encode(secret)
    const token = await new jose.SignJWT({ tenant_id: 't1', role: 'user' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(encodedSecret)

    const claims = await v.verify(token)
    expect(claims.tenant_id).toBe('t1')
    expect(claims.role).toBe('user')
  })

  it('rejects expired tokens', async () => {
    const secret = 'my-test-secret-that-is-long-enough'
    const v = new JwtVerifier({ secret })

    const encodedSecret = new TextEncoder().encode(secret)
    const token = await new jose.SignJWT({ tenant_id: 't1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(encodedSecret)

    await expect(v.verify(token)).rejects.toThrow('expired')
  })

  it('rejects tokens with wrong secret', async () => {
    const v = new JwtVerifier({ secret: 'correct-secret-that-is-long-enough' })

    const wrongSecret = new TextEncoder().encode('wrong-secret-that-is-long-enough')
    const token = await new jose.SignJWT({ tenant_id: 't1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setExpirationTime('1h')
      .sign(wrongSecret)

    await expect(v.verify(token)).rejects.toThrow()
  })
})
