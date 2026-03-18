import * as jose from 'jose'

export type JwtClaims = Record<string, unknown>

export class JwtVerifier {
  private secret: Uint8Array | null = null
  private jwksUrl: string | null = null
  private issuer: string | undefined
  private audience: string | undefined

  constructor(config?: { secret?: string; jwksUrl?: string; issuer?: string; audience?: string }) {
    if (config?.secret) {
      this.secret = new TextEncoder().encode(config.secret)
    }
    if (config?.jwksUrl) {
      this.jwksUrl = config.jwksUrl
    }
    this.issuer = config?.issuer
    this.audience = config?.audience
  }

  isConfigured(): boolean {
    return this.secret !== null || this.jwksUrl !== null
  }

  async verify(token: string): Promise<JwtClaims> {
    try {
      if (this.secret) {
        const { payload } = await jose.jwtVerify(token, this.secret, {
          issuer: this.issuer,
          audience: this.audience,
        })
        return payload as JwtClaims
      }

      if (this.jwksUrl) {
        const jwks = jose.createRemoteJWKSet(new URL(this.jwksUrl))
        const { payload } = await jose.jwtVerify(token, jwks, {
          issuer: this.issuer,
          audience: this.audience,
        })
        return payload as JwtClaims
      }

      throw new Error('JWT verification not configured')
    } catch (err: any) {
      if (err.code === 'ERR_JWT_EXPIRED') {
        throw new Error('Token expired. Please refresh your authentication token.')
      }
      if (err.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
        throw new Error('Invalid token signature. Check your JWT secret configuration.')
      }
      throw new Error(`Authentication failed: ${err.message}`)
    }
  }
}
