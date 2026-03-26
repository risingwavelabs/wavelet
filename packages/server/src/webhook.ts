import { createHmac } from 'node:crypto'
import type { QueryDef, SqlFragment } from '@risingwave/wavelet'
import type { ViewDiff } from './cursor-manager.js'

const TIMEOUT_MS = 10000

export class WebhookFanout {
  private webhooks: Map<string, string> = new Map() // queryName -> url

  constructor(
    queries: Record<string, QueryDef | SqlFragment>,
    private signingSecret?: string
  ) {
    for (const [name, def] of Object.entries(queries)) {
      if ('_tag' in def && def._tag === 'sql') continue
      const qd = def as QueryDef
      if (qd.webhook) {
        this.webhooks.set(name, qd.webhook)
      }
    }
  }

  async broadcast(queryName: string, diff: ViewDiff): Promise<void> {
    const url = this.webhooks.get(queryName)
    if (!url) return

    const body = JSON.stringify({
      query: queryName,
      cursor: diff.cursor,
      inserted: diff.inserted,
      updated: diff.updated,
      deleted: diff.deleted,
    })

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'User-Agent': 'Wavelet-Webhook/1.0',
    }

    if (this.signingSecret) {
      const signature = createHmac('sha256', this.signingSecret)
        .update(body)
        .digest('hex')
      headers['X-Wavelet-Signature'] = `sha256=${signature}`
    }

    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

      await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })

      clearTimeout(timeout)
    } catch (err: any) {
      if (err.name === 'AbortError') {
        console.error(`[webhook] Timeout sending to ${url} for query ${queryName}`)
      } else {
        console.error(`[webhook] Failed to send to ${url} for query ${queryName}:`, err.message)
      }
    }
  }
}
