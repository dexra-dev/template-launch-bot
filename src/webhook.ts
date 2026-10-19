import { readFileSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { verifyWebhook } from '@dexra-dev/client'
import type { Config } from './core/config.js'
import { dexraClient } from './core/dexra.js'
import { launchesOf, type Launch } from './intake.js'
import type { Logger } from './log.js'
import type { Settings } from './settings.js'

const MAX_BODY_BYTES = 1_000_000

export interface WatchInfo {
  id: number | null
  secret: string
}

/**
 * Finds the signing secret: DEXRA_WEBHOOK_SECRET, then the saved watch file, else creates a
 * `launches` watch. Dexra shows a watch's secret only once, so it is saved to WATCH_FILE.
 */
export async function ensureWatch(settings: Settings, config: Config, log: Logger): Promise<WatchInfo> {
  if (settings.webhookSecret) {
    log('info', 'watch', { source: 'DEXRA_WEBHOOK_SECRET' })
    return { id: null, secret: settings.webhookSecret }
  }
  try {
    const saved = JSON.parse(readFileSync(settings.watchFile, 'utf8')) as Partial<WatchInfo>
    if (typeof saved.secret === 'string' && saved.secret) {
      log('info', 'watch', { source: settings.watchFile, id: saved.id ?? null })
      return { id: typeof saved.id === 'number' ? saved.id : null, secret: saved.secret }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  if (!settings.webhookPublicUrl) throw new Error('webhook mode needs WEBHOOK_PUBLIC_URL (or DEXRA_WEBHOOK_SECRET for an existing watch)')
  if (!config.dexraApiKey) throw new Error('creating a watch needs DEXRA_API_KEY')
  const watch = await dexraClient(config).createWatch({
    kind: 'launches',
    webhook_url: settings.webhookPublicUrl,
    interval_minutes: settings.watchIntervalMinutes,
    options: settings.minLiquidityUsd > 0 ? { min_liquidity_usd: settings.minLiquidityUsd } : undefined,
  })
  writeFileSync(settings.watchFile, `${JSON.stringify({ id: watch.id, secret: watch.secret }, null, 2)}\n`, { mode: 0o600 })
  log('info', 'watch_created', { id: watch.id, webhook_url: settings.webhookPublicUrl, saved_to: settings.watchFile })
  return { id: watch.id, secret: watch.secret }
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        resolve(null)
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * A small server for Dexra watch webhooks. Nothing is acted on until X-Dexra-Signature checks out
 * against the raw body; then it answers 200 at once and hands the launches over.
 */
export function webhookServer(
  options: { path: string; secret: string },
  onLaunches: (launches: Launch[]) => unknown,
  log: Logger,
): Server {
  return createServer(async (request, response) => {
    const reply = (status: number, body: Record<string, unknown>) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    try {
      const path = new URL(request.url ?? '/', 'http://localhost').pathname
      if (path !== options.path) return reply(404, { error: 'not_found' })
      if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed' })

      const body = await readBody(request)
      if (body === null) return reply(413, { error: 'too_large' })
      const signature = request.headers['x-dexra-signature']
      if (typeof signature !== 'string' || !(await verifyWebhook(options.secret, signature, body))) {
        log('warn', 'webhook_rejected', { reason: 'bad or missing X-Dexra-Signature' })
        return reply(401, { error: 'bad_signature' })
      }

      let payload: { event?: string } & Record<string, unknown>
      try {
        payload = JSON.parse(body)
      } catch {
        return reply(400, { error: 'bad_json' })
      }
      const event = payload.event ?? request.headers['x-dexra-event']
      if (event === 'new_launches') {
        const launches = launchesOf(payload)
        log('info', 'webhook', { dexra_event: event, launches: launches.length })
        reply(200, { ok: true })
        onLaunches(launches)
        return
      }
      log('info', 'webhook', { dexra_event: event ?? null })
      return reply(200, { ok: true })
    } catch (error) {
      log('error', 'webhook_error', { error: error instanceof Error ? error.message : String(error) })
      if (!response.headersSent) reply(500, { error: 'internal' })
    }
  })
}
