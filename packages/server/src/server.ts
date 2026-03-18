import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http'
import type { WaveletConfig } from 'wavelet'
import { CursorManager } from './cursor-manager.js'
import { WebSocketFanout } from './ws-fanout.js'
import { HttpApi } from './http-api.js'
import { JwtVerifier } from './jwt.js'

export class WaveletServer {
  private httpServer: ReturnType<typeof createServer> | null = null
  private cursorManager: CursorManager
  private fanout: WebSocketFanout
  private httpApi: HttpApi
  private jwt: JwtVerifier

  constructor(private config: WaveletConfig) {
    this.jwt = new JwtVerifier(config.jwt)
    this.cursorManager = new CursorManager(config.database, config.views ?? {})
    this.fanout = new WebSocketFanout(this.cursorManager, this.jwt, config.views ?? {})
    this.httpApi = new HttpApi(config.database, config.streams ?? {}, config.views ?? {})
  }

  async start(): Promise<void> {
    const port = this.config.server?.port ?? 8080
    const host = this.config.server?.host ?? '0.0.0.0'

    this.httpServer = createServer((req, res) => this.httpApi.handle(req, res))
    this.fanout.attach(this.httpServer)

    await this.cursorManager.initialize()
    this.cursorManager.startPolling((viewName, diffs) => {
      this.fanout.broadcast(viewName, diffs)
    })

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(port, host, () => {
        console.log(`Wavelet server listening on ${host}:${port}`)
        console.log(`WebSocket: ws://${host}:${port}/subscribe/{view}`)
        console.log(`HTTP API:  http://${host}:${port}/v1/`)
        resolve()
      })
    })
  }

  /**
   * Attach to an existing HTTP server instead of creating one.
   * Used by Wavelet Cloud to run multiple instances on a shared port.
   */
  async attachTo(server: Server, opts?: { pathPrefix?: string }): Promise<{
    handleHttp: (req: IncomingMessage, res: ServerResponse) => void
  }> {
    const prefix = opts?.pathPrefix ?? ''

    this.fanout.attach(server, prefix)

    await this.cursorManager.initialize()
    this.cursorManager.startPolling((viewName, diffs) => {
      this.fanout.broadcast(viewName, diffs)
    })

    const handleHttp = (req: IncomingMessage, res: ServerResponse) => {
      if (prefix && req.url?.startsWith(prefix)) {
        req.url = req.url.slice(prefix.length) || '/'
      }
      this.httpApi.handle(req, res)
    }

    return { handleHttp }
  }

  async stop(): Promise<void> {
    this.cursorManager.stopPolling()
    this.fanout.closeAll()
    await new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => resolve())
      } else {
        resolve()
      }
    })
  }
}
