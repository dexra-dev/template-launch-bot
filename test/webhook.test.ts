import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, test } from 'node:test'
import type { Launch } from '../src/intake.js'
import { silent } from '../src/log.js'
import { loadSettings } from '../src/settings.js'
import { ensureWatch, webhookServer } from '../src/webhook.js'
import { DEXRA, config, mockFetch } from './core/helpers.js'
import { MINT_A, launch } from './fakes.js'

const SECRET = 'whsec_test'
let cleanup: Array<() => void> = []
afterEach(() => {
  for (const fn of cleanup) fn()
  cleanup = []
})

function sign(body: string, secret = SECRET, at = Math.floor(Date.now() / 1000)): string {
  return `t=${at},v1=${createHmac('sha256', secret).update(`${at}.${body}`).digest('hex')}`
}

async function serve(): Promise<{ url: string; received: Launch[][] }> {
  const received: Launch[][] = []
  const server = webhookServer({ path: '/dexra', secret: SECRET }, (launches) => received.push(launches), silent)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanup.push(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/dexra`, received }
}

const payload = JSON.stringify({ event: 'new_launches', launches: [launch(MINT_A)], watch: { id: 1, kind: 'launches' } })

async function post(url: string, body: string, signature?: string): Promise<number> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (signature !== undefined) headers['x-dexra-signature'] = signature
  return (await fetch(url, { method: 'POST', headers, body })).status
}

test('a correctly signed new_launches webhook hands its launches over', async () => {
  const { url, received } = await serve()
  assert.equal(await post(url, payload, sign(payload)), 200)
  assert.equal(received[0]?.[0]?.mint, MINT_A)
})

test('a missing signature is rejected and nothing is acted on', async () => {
  const { url, received } = await serve()
  assert.equal(await post(url, payload), 401)
  assert.equal(received.length, 0)
})

test('a signature from another secret is rejected', async () => {
  const { url, received } = await serve()
  assert.equal(await post(url, payload, sign(payload, 'wrong')), 401)
  assert.equal(received.length, 0)
})

test('a body changed after signing is rejected', async () => {
  const { url, received } = await serve()
  const tampered = payload.replace(MINT_A, 'So11111111111111111111111111111111111111112')
  assert.equal(await post(url, tampered, sign(payload)), 401)
  assert.equal(received.length, 0)
})

test('an old signature is rejected (replay)', async () => {
  const { url, received } = await serve()
  assert.equal(await post(url, payload, sign(payload, SECRET, Math.floor(Date.now() / 1000) - 3600)), 401)
  assert.equal(received.length, 0)
})

test('a signed ping is answered and starts nothing; other paths 404', async () => {
  const { url, received } = await serve()
  const ping = JSON.stringify({ event: 'ping' })
  assert.equal(await post(url, ping, sign(ping)), 200)
  assert.equal(await post(url.replace('/dexra', '/other'), ping, sign(ping)), 404)
  assert.equal(received.length, 0)
})

test('ensureWatch creates a launches watch once and keeps its secret in WATCH_FILE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launch-bot-'))
  const watchFile = join(dir, 'watch.json')
  const mock = mockFetch({ [`POST ${DEXRA}/account/watches`]: { body: { result: { id: 42, secret: SECRET, kind: 'launches' } } } })
  cleanup.push(mock.restore)
  const cfg = config({ DEXRA_API_KEY: 'dxr_test' })
  const settings = loadSettings({ MODE: 'webhook', WEBHOOK_PUBLIC_URL: 'https://bot.example/dexra', WATCH_FILE: watchFile, MIN_LIQUIDITY_USD: '3000' }, cfg)

  assert.deepEqual(await ensureWatch(settings, cfg, silent), { id: 42, secret: SECRET })
  assert.deepEqual(mock.calls[0]?.body, {
    kind: 'launches',
    webhook_url: 'https://bot.example/dexra',
    interval_minutes: 2,
    options: { min_liquidity_usd: 3000 },
  })
  assert.equal(JSON.parse(readFileSync(watchFile, 'utf8')).secret, SECRET)
  assert.equal(statSync(watchFile).mode & 0o777, 0o600)

  assert.deepEqual(await ensureWatch(settings, cfg, silent), { id: 42, secret: SECRET })
  assert.equal(mock.calls.length, 1)
})

test('ensureWatch without a public URL or secret fails clearly', async () => {
  const cfg = config({ DEXRA_API_KEY: 'dxr_test' })
  const settings = loadSettings({ MODE: 'webhook', WATCH_FILE: join(mkdtempSync(join(tmpdir(), 'lb-')), 'w.json') }, cfg)
  await assert.rejects(ensureWatch(settings, cfg, silent), /WEBHOOK_PUBLIC_URL/)
})
