import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { decideBuy, decideSell } from '../../src/core/guard.js'
import { BONK, DEXRA, config, dexraResult, mockFetch } from './helpers.js'

let restore = () => {}
afterEach(() => restore())

function dexra(token: unknown, preflight: unknown) {
  const m = mockFetch({
    [`GET ${DEXRA}/token_deep_check`]: token as never,
    [`GET ${DEXRA}/swap_preflight`]: preflight as never,
  })
  restore = m.restore
  return m
}

test('ok and ok allows the buy and sends amount in SOL', async () => {
  const m = dexra(dexraResult('ok', ['fine']), dexraResult('ok'))
  const d = await decideBuy(BONK, 0.01, config())
  assert.equal(d.allowed, true)
  assert.deepEqual(d.verdicts, { token: 'ok', preflight: 'ok' })
  const pre = m.calls.find((c) => c.url.pathname === '/swap_preflight')!
  assert.equal(pre.url.searchParams.get('side'), 'buy')
  assert.equal(pre.url.searchParams.get('amount'), '0.01')
  assert.equal(pre.url.searchParams.get('mint'), BONK)
})

for (const [token, pre] of [
  ['avoid', 'ok'],
  ['ok', 'avoid'],
  ['unknown', 'ok'],
  ['ok', 'unknown'],
  ['caution', 'ok'],
  ['ok', 'caution'],
  [undefined, 'ok'],
] as const) {
  test(`token ${token} + preflight ${pre} blocks by default`, async () => {
    dexra(dexraResult(token, ['why']), dexraResult(pre, ['why']))
    const d = await decideBuy(BONK, 0.01, config())
    assert.equal(d.allowed, false)
    assert.ok(d.reasons.some((r) => r.includes('blocks the buy')))
    assert.ok(d.reasons.some((r) => r.endsWith(': why')))
  })
}

test('ALLOW_CAUTION lets caution through but never avoid or unknown', async () => {
  dexra(dexraResult('caution'), dexraResult('caution'))
  assert.equal((await decideBuy(BONK, 0.01, config({ ALLOW_CAUTION: 'true' }))).allowed, true)
  restore()
  dexra(dexraResult('caution'), dexraResult('avoid'))
  assert.equal((await decideBuy(BONK, 0.01, config({ ALLOW_CAUTION: 'true' }))).allowed, false)
  restore()
  dexra(dexraResult('unknown'), dexraResult('caution'))
  assert.equal((await decideBuy(BONK, 0.01, config({ ALLOW_CAUTION: 'true' }))).allowed, false)
})

test('amount caps are checked before any Dexra call', async () => {
  const m = dexra(dexraResult('ok'), dexraResult('ok'))
  for (const amount of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.0500001, 1]) {
    const d = await decideBuy(BONK, amount, config())
    assert.equal(d.allowed, false, `amount ${amount}`)
  }
  assert.equal((await decideBuy(BONK, 0.2, config({ MAX_TRADE_SOL: '0.1' }))).reasons[0], 'amount 0.2 SOL is above MAX_TRADE_SOL 0.1')
  assert.equal((await decideBuy('not-a-mint', 0.01, config())).allowed, false)
  assert.equal(m.calls.length, 0)
  assert.equal((await decideBuy(BONK, 0.05, config())).allowed, true)
})

test('a Dexra error blocks (fail closed)', async () => {
  dexra(
    { status: 402, body: { error: 'payment_required', context: 'This call needs a payment' } },
    dexraResult('ok'),
  )
  const d = await decideBuy(BONK, 0.01, config())
  assert.equal(d.allowed, false)
  assert.equal(d.verdicts.token, null)
  assert.match(d.reasons[0]!, /token_deep_check failed.*payment_required \(HTTP 402\)/)
})

test('a network failure blocks (fail closed)', async () => {
  dexra(dexraResult('ok'), () => {
    throw new TypeError('fetch failed')
  })
  const d = await decideBuy(BONK, 0.01, config())
  assert.equal(d.allowed, false)
  assert.match(d.reasons.join('\n'), /swap_preflight failed.*fetch failed/)
})

test('sells are allowed even on avoid, with the verdict reported', async () => {
  const m = dexra(dexraResult('ok'), dexraResult('avoid', ['token is non-transferable']))
  const d = await decideSell(BONK, 1000, config())
  assert.equal(d.allowed, true)
  assert.equal(d.verdicts.preflight, 'avoid')
  assert.ok(d.reasons.includes('swap_preflight: token is non-transferable'))
  assert.equal(m.calls[0]!.url.searchParams.get('side'), 'sell')
})

test('sells go ahead when Dexra fails, and refuse a zero amount', async () => {
  dexra(dexraResult('ok'), { status: 500, body: { error: 'internal', context: 'boom' } })
  const d = await decideSell(BONK, 5, config())
  assert.equal(d.allowed, true)
  assert.match(d.reasons[0]!, /selling anyway/)
  assert.equal((await decideSell(BONK, 0, config())).allowed, false)
})
