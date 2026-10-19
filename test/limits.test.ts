import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PositionStore, limitReason } from '../src/positions.js'
import { loadSettings } from '../src/settings.js'
import { config } from './core/helpers.js'
import { MINT_A, MINT_B, MINT_C, MINT_D, harness, launch, tradeResult } from './fakes.js'

const HOUR = 60 * 60 * 1000

test('MAX_BUYS_PER_HOUR stops the third buy and frees up after an hour', async () => {
  const h = harness({ MAX_BUYS_PER_HOUR: '2', MAX_OPEN_POSITIONS: '10' })
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_A), launch(MINT_B), launch(MINT_C)], 'poll'), ['bought', 'bought', 'limited'])
  h.clock.now += HOUR
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_D)], 'poll'), ['bought'])
})

test('MAX_OPEN_POSITIONS counts open positions, not buys', async () => {
  const h = harness({ MAX_BUYS_PER_HOUR: '10', MAX_OPEN_POSITIONS: '1' })
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_A), launch(MINT_B)], 'poll'), ['bought', 'limited'])
  h.bot.store.close(MINT_A, 'dry_run', h.clock.now)
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_C)], 'poll'), ['bought'])
})

test('a blocked buy uses no slot', async () => {
  const h = harness({ MAX_BUYS_PER_HOUR: '1' }, { buy: async (mint) => tradeResult('buy', mint, 'blocked') })
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_A), launch(MINT_B)], 'poll'), ['blocked', 'blocked'])
  assert.equal(h.bot.store.buysInLastHour('dry_run', h.clock.now), 0)
})

test('limits are checked before the core is called, so no credits are spent', async () => {
  const h = harness({ MAX_OPEN_POSITIONS: '0' })
  assert.deepEqual(await h.bot.handleLaunches([launch(MINT_A)], 'poll'), ['limited'])
  assert.deepEqual(h.buys, [])
})

test('positions and recent buys survive a restart; dry-run positions do not count when live', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'launch-bot-')), 'positions.json')
  const now = Date.now()
  const store = new PositionStore(file)
  store.add({ mint: MINT_A, symbol: null, platform: null, mode: 'dry_run', openedAt: now, costLamports: '1', tokensAtomic: '1', signature: null })
  const reloaded = new PositionStore(file)
  assert.equal(reloaded.open('dry_run').length, 1)
  assert.equal(reloaded.buysInLastHour('dry_run', now), 1)
  assert.equal(reloaded.open('live').length, 0)
  assert.equal(limitReason(reloaded, { maxBuysPerHour: 1, maxOpenPositions: 5 }, 'dry_run', now)?.startsWith('MAX_BUYS_PER_HOUR'), true)
  assert.equal(limitReason(reloaded, { maxBuysPerHour: 1, maxOpenPositions: 5 }, 'live', now), null)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).positions[0].mint, MINT_A)
})

test('BUY_SOL above MAX_TRADE_SOL is refused at start', () => {
  assert.throws(() => loadSettings({ BUY_SOL: '0.1' }, config()), /above MAX_TRADE_SOL/)
  assert.throws(() => loadSettings({ MODE: 'snipe' }, config()), /MODE/)
})
