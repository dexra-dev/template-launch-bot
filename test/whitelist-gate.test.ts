import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { dexraAllowsBuy } from '../examples/whitelist-gate.js'
import { BONK, DEXRA, dexraResult, mockFetch } from './core/helpers.js'

let restore = () => {}
afterEach(() => restore())

const on = { apiKey: 'dxr_test', baseUrl: `http://${DEXRA}` }

function dexra(token: unknown, preflight: unknown) {
  const m = mockFetch({
    [`GET ${DEXRA}/token_deep_check`]: token as never,
    [`GET ${DEXRA}/swap_preflight`]: preflight as never,
  })
  restore = m.restore
  return m
}

test('without a key the gate is off and makes no call', async () => {
  const m = dexra(dexraResult('avoid'), dexraResult('avoid'))
  const saved = process.env.DEXRA_API_KEY
  delete process.env.DEXRA_API_KEY
  try {
    const r = await dexraAllowsBuy(BONK, 0.01, { baseUrl: on.baseUrl })
    assert.equal(r.allowed, true)
    assert.equal(r.checked, false)
    assert.equal(m.calls.length, 0)
  } finally {
    if (saved !== undefined) process.env.DEXRA_API_KEY = saved
  }
})

test('ok and ok allows the buy and asks preflight for a buy in SOL', async () => {
  const m = dexra(dexraResult('ok', ['fine']), dexraResult('ok'))
  const r = await dexraAllowsBuy(BONK, 0.01, on)
  assert.equal(r.allowed, true)
  assert.deepEqual(r.verdicts, { token: 'ok', preflight: 'ok' })
  assert.ok(r.reasons.includes('token_deep_check: fine'))
  const pre = m.calls.find((c) => c.url.pathname === '/swap_preflight')!
  assert.equal(pre.url.searchParams.get('side'), 'buy')
  assert.equal(pre.url.searchParams.get('amount'), '0.01')
  assert.equal(pre.headers.authorization, 'Bearer dxr_test')
})

for (const [token, pre] of [
  ['avoid', 'ok'],
  ['ok', 'unknown'],
  ['caution', 'ok'],
  [undefined, 'ok'],
] as const) {
  test(`token ${token} + preflight ${pre} blocks`, async () => {
    dexra(dexraResult(token), dexraResult(pre))
    assert.equal((await dexraAllowsBuy(BONK, 0.01, on)).allowed, false)
  })
}

test('allowCaution lets caution pass but not avoid', async () => {
  dexra(dexraResult('caution'), dexraResult('ok'))
  assert.equal((await dexraAllowsBuy(BONK, 0.01, { ...on, allowCaution: true })).allowed, true)
  dexra(dexraResult('caution'), dexraResult('avoid'))
  assert.equal((await dexraAllowsBuy(BONK, 0.01, { ...on, allowCaution: true })).allowed, false)
})

test('a Dexra error blocks by default and allows with failOpen', async () => {
  const error = { status: 503, body: { error: { kind: 'upstream', message: 'down' } } }
  dexra(error, dexraResult('ok'))
  const closed = await dexraAllowsBuy(BONK, 0.01, on)
  assert.equal(closed.allowed, false)
  assert.match(closed.reasons[0]!, /token_deep_check failed .*blocking/)

  dexra(error, dexraResult('ok'))
  const open = await dexraAllowsBuy(BONK, 0.01, { ...on, failOpen: true })
  assert.equal(open.allowed, true)
  assert.match(open.reasons[0]!, /allowing/)
})
