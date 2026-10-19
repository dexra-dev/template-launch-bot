import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { SeenMints, rejectReason } from '../src/intake.js'
import { DEXRA, dexraResult, mockFetch, type Routes } from './core/helpers.js'
import { MINT_A, MINT_B, MINT_C, harness, launch } from './fakes.js'
import { LaunchBot } from '../src/bot.js'
import { config } from './core/helpers.js'
import { loadSettings } from '../src/settings.js'
import { PositionStore } from '../src/positions.js'
import { defaultDeps } from '../src/bot.js'
import { silent } from '../src/log.js'

let restore = () => {}
afterEach(() => restore())

test('SeenMints says yes once per mint and forgets the oldest past capacity', () => {
  const seen = new SeenMints(2)
  assert.equal(seen.add('a'), true)
  assert.equal(seen.add('a'), false)
  seen.add('b')
  seen.add('c')
  assert.equal(seen.has('a'), false)
  assert.equal(seen.size, 2)
})

test('only launches Dexra marks ok pass, with liquidity and platform filters', () => {
  const filters = { minLiquidityUsd: 5000, platforms: ['pump_fun'] }
  assert.equal(rejectReason(launch(MINT_A), filters), null)
  assert.equal(rejectReason(launch(MINT_A, { verdict: 'caution' }), filters), 'verdict caution')
  assert.equal(rejectReason(launch(MINT_A, { verdict: 'avoid' }), filters), 'verdict avoid')
  assert.equal(rejectReason(launch(MINT_A, { verdict: undefined }), filters), 'verdict missing')
  assert.match(rejectReason(launch(MINT_A, { liquidity: { usd: 100 } }), filters)!, /below \$5000/)
  assert.match(rejectReason(launch(MINT_A, { liquidity: { usd: 1e6, collapsed: true } }), filters)!, /collapsed/)
  assert.match(rejectReason(launch(MINT_A, { platform: 'letsbonk' }), filters)!, /not in PLATFORMS/)
})

test('a mint seen in two polls is bought once', async () => {
  const feed = [launch(MINT_A), launch(MINT_B, { verdict: 'avoid' })]
  const h = harness({}, { freshLaunches: async () => ({ launches: feed }) })
  assert.deepEqual(await h.bot.pollOnce(), ['bought', 'skipped'])
  assert.deepEqual(await h.bot.pollOnce(), ['duplicate', 'duplicate'])
  assert.deepEqual(h.buys, [MINT_A])
})

test('the same launch from poll and webhook at once is bought once', async () => {
  const h = harness()
  const [first, second] = await Promise.all([
    h.bot.handleLaunches([launch(MINT_C)], 'webhook'),
    h.bot.handleLaunches([launch(MINT_C)], 'poll'),
  ])
  assert.deepEqual([first, second], [['bought'], ['duplicate']])
  assert.equal(h.buys.length, 1)
})

test('poll sends the window, liquidity and platforms to new_launches', async () => {
  let seen: unknown
  const h = harness(
    { LAUNCH_MINUTES: '7', MIN_LIQUIDITY_USD: '2500', PLATFORMS: 'pump_fun, letsbonk' },
    { freshLaunches: async (options) => ((seen = options), { launches: [] }) },
  )
  await h.bot.pollOnce()
  assert.deepEqual(seen, { minutes: 7, min_liquidity_usd: 2500, platforms: 'pump_fun,letsbonk' })
})

test('a failed poll is logged and buys nothing', async () => {
  const h = harness({}, { freshLaunches: async () => Promise.reject(new Error('down')) })
  assert.deepEqual(await h.bot.pollOnce(), [])
})

// Wiring through the real core: an `ok` launch still goes through token_deep_check + swap_preflight.
test('an ok launch whose deep check says avoid is blocked by the core', async () => {
  const routes: Routes = {
    [`GET ${DEXRA}/new_launches`]: { body: { result: { summary: 's', launches: [launch(MINT_A)] } } },
    [`GET ${DEXRA}/token_deep_check`]: dexraResult('avoid', ['mint authority is live']),
    [`GET ${DEXRA}/swap_preflight`]: dexraResult('ok'),
  }
  const mock = mockFetch(routes)
  restore = mock.restore
  const cfg = config()
  const bot = new LaunchBot(loadSettings({}, cfg), cfg, new PositionStore(null), defaultDeps, silent)
  assert.deepEqual(await bot.pollOnce(), ['blocked'])
  assert.equal(bot.store.open('dry_run').length, 0)
  assert.deepEqual(
    mock.calls.map((c) => c.url.pathname).sort(),
    ['/new_launches', '/swap_preflight', '/token_deep_check'],
  )
})

test('an ok launch the core allows becomes a dry-run position', async () => {
  const mock = mockFetch({
    [`GET ${DEXRA}/new_launches`]: { body: { result: { launches: [launch(MINT_A)] } } },
    [`GET ${DEXRA}/token_deep_check`]: dexraResult('ok'),
    [`GET ${DEXRA}/swap_preflight`]: dexraResult('ok'),
  })
  restore = mock.restore
  const cfg = config()
  const bot = new LaunchBot(loadSettings({}, cfg), cfg, new PositionStore(null), defaultDeps, silent)
  assert.deepEqual(await bot.pollOnce(), ['bought'])
  const [position] = bot.store.open('dry_run')
  assert.equal(position?.mint, MINT_A)
  assert.equal(position?.costLamports, '10000000')
  assert.equal(mock.calls.some((c) => c.url.host === 'api.jup.ag'), false)
})
