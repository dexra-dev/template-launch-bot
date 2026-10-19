import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkExit } from '../src/exits.js'
import type { Position } from '../src/positions.js'
import { MINT_A, MINT_B, harness, launch, tradeResult } from './fakes.js'

const MIN = 60_000
const rules = { holdMinutes: 30, takeProfitPct: 50, stopLossPct: 30 }
const position: Position = {
  mint: MINT_A,
  symbol: null,
  platform: null,
  mode: 'dry_run',
  openedAt: 0,
  costLamports: '10000000',
  tokensAtomic: '5000',
  signature: null,
}

test('exit rules: take profit, stop loss, hold time, and keep holding', () => {
  assert.equal(checkExit(position, 15_000_000n, rules, 5 * MIN).reason, 'take_profit')
  assert.equal(checkExit(position, 7_000_000n, rules, 5 * MIN).reason, 'stop_loss')
  assert.equal(checkExit(position, 10_500_000n, rules, 31 * MIN).reason, 'hold_time')
  const hold = checkExit(position, 12_000_000n, rules, 5 * MIN)
  assert.equal(hold.reason, null)
  assert.equal(hold.pnlPct, 20)
})

test('a rule set to 0 is off; no quote still allows the hold-time exit', () => {
  const off = { holdMinutes: 0, takeProfitPct: 0, stopLossPct: 0 }
  assert.equal(checkExit(position, 1n, off, 999 * MIN).reason, null)
  assert.equal(checkExit(position, null, rules, 5 * MIN).reason, null)
  assert.equal(checkExit(position, null, rules, 30 * MIN).reason, 'hold_time')
})

test('checkExits sells a position at take profit and closes it', async () => {
  const h = harness({ TAKE_PROFIT_PCT: '50' })
  await h.bot.handleLaunches([launch(MINT_A)], 'poll')
  h.value.lamports = 16_000_000n
  await h.bot.checkExits()
  assert.deepEqual(h.sells, [{ mint: MINT_A, amount: '5000' }])
  assert.equal(h.bot.store.open('dry_run').length, 0)
})

test('checkExits keeps a position inside its rules', async () => {
  const h = harness()
  await h.bot.handleLaunches([launch(MINT_A)], 'poll')
  h.value.lamports = 11_000_000n
  h.clock.now += 5 * MIN
  await h.bot.checkExits()
  assert.deepEqual(h.sells, [])
  assert.equal(h.bot.store.open('dry_run').length, 1)
})

test('a failed sell keeps the position open for the next check', async () => {
  const h = harness({}, { sell: async (mint) => tradeResult('sell', mint, 'failed') })
  await h.bot.handleLaunches([launch(MINT_B)], 'poll')
  h.clock.now += 31 * MIN
  h.value.lamports = null
  await h.bot.checkExits()
  assert.equal(h.bot.store.open('dry_run').length, 1)
})

test('without JUPITER_API_KEY the exit loop does nothing', async () => {
  const h = harness({ JUPITER_API_KEY: '' })
  await h.bot.handleLaunches([launch(MINT_A)], 'poll')
  h.clock.now += 999 * MIN
  await h.bot.checkExits()
  assert.equal(h.bot.exitsEnabled, false)
  assert.deepEqual(h.sells, [])
})
