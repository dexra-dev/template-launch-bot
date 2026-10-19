import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { getBase64Encoder, getTransactionDecoder, getPublicKeyFromAddress, address, verifySignature } from '@solana/kit'
import { buy, sell } from '../../src/core/trade.js'
import { BONK, DEXRA, JUP, SOL, config, dexraResult, mockFetch, testWallet, unsignedTransaction, type Routes } from './helpers.js'

let restore = () => {}
afterEach(() => restore())

const okChecks: Routes = {
  [`GET ${DEXRA}/token_deep_check`]: dexraResult('ok'),
  [`GET ${DEXRA}/swap_preflight`]: dexraResult('ok'),
}

function quote(extra: Record<string, unknown> = {}) {
  return {
    body: {
      requestId: 'req-1',
      inputMint: SOL,
      outputMint: BONK,
      inAmount: '10000000',
      outAmount: '356918106200',
      otherAmountThreshold: '353000000000',
      slippageBps: 100,
      priceImpact: -0.01,
      router: 'metis',
      mode: 'manual',
      feeBps: 10,
      transaction: null,
      ...extra,
    },
  }
}

function use(routes: Routes) {
  const m = mockFetch(routes)
  restore = m.restore
  return m
}

const jupiterCalls = (m: ReturnType<typeof use>) => m.calls.filter((c) => c.url.host === JUP)

test('dry run without a Jupiter key never quotes, signs or executes', async () => {
  const m = use(okChecks)
  const r = await buy(BONK, 0.01, config())
  assert.equal(r.status, 'dry_run')
  assert.equal(r.ok, true)
  assert.equal(r.input.amountAtomic, '10000000')
  assert.equal(r.quote, null)
  assert.equal(r.signature, null)
  assert.equal(jupiterCalls(m).length, 0)
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(r)))
})

test('dry run with a Jupiter key quotes without a taker and never executes', async () => {
  const { secret } = await testWallet()
  const m = use({ ...okChecks, [`GET ${JUP}/swap/v2/order`]: quote() })
  const r = await buy(BONK, 0.01, config({ JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: secret }))
  assert.equal(r.status, 'dry_run')
  assert.equal(r.quote?.outAmount, '356918106200')
  const calls = jupiterCalls(m)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.url.searchParams.get('taker'), null)
  assert.equal(calls[0]!.url.searchParams.get('amount'), '10000000')
  assert.equal(calls[0]!.url.searchParams.get('slippageBps'), '100')
  assert.equal(calls[0]!.headers['x-api-key'], 'jup')
})

test('DRY_RUN=false without a wallet stays a dry run', async () => {
  const m = use({ ...okChecks, [`GET ${JUP}/swap/v2/order`]: quote() })
  const r = await buy(BONK, 0.01, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup' }))
  assert.equal(r.mode, 'dry_run')
  assert.match(r.message, /SOLANA_PRIVATE_KEY is not set/)
  assert.equal(m.calls.some((c) => c.url.pathname.endsWith('/execute')), false)
})

test('live buy orders with the wallet as taker, then executes the signed transaction', async () => {
  const wallet = await testWallet()
  const unsigned = unsignedTransaction(wallet.address)
  let executed: Record<string, string> | undefined
  const m = use({
    ...okChecks,
    [`GET ${JUP}/swap/v2/order`]: quote({ transaction: unsigned }),
    [`POST ${JUP}/swap/v2/execute`]: (call) => {
      executed = call.body as Record<string, string>
      return { body: { status: 'Success', signature: 'SIG123', code: 0, totalInputAmount: '10000000', totalOutputAmount: '356000000000' } }
    },
  })
  const r = await buy(BONK, 0.01, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: wallet.secret }))

  assert.equal(r.status, 'executed', r.message)
  assert.equal(r.signature, 'SIG123')
  assert.equal(r.explorerUrl, 'https://solscan.io/tx/SIG123')
  const jup = jupiterCalls(m)
  assert.deepEqual(jup.map((c) => `${c.method} ${c.url.pathname}`), ['GET /swap/v2/order', 'POST /swap/v2/execute'])
  assert.equal(jup[0]!.url.searchParams.get('taker'), wallet.address)
  assert.equal(jup[0]!.url.searchParams.get('inputMint'), SOL)
  assert.equal(jup[0]!.url.searchParams.get('outputMint'), BONK)
  assert.equal(executed?.requestId, 'req-1')
  assert.notEqual(executed?.signedTransaction, unsigned)

  const signed = getTransactionDecoder().decode(getBase64Encoder().encode(executed!.signedTransaction!))
  const signature = signed.signatures[address(wallet.address)]
  assert.ok(signature, 'wallet signature present')
  assert.equal(await verifySignature(await getPublicKeyFromAddress(address(wallet.address)), signature, signed.messageBytes), true)
  assert.equal(JSON.stringify(r).includes(wallet.secret), false)
})

test('live buy that Dexra blocks never reaches Jupiter', async () => {
  const wallet = await testWallet()
  const m = use({ [`GET ${DEXRA}/token_deep_check`]: dexraResult('avoid', ['mint authority active']), [`GET ${DEXRA}/swap_preflight`]: dexraResult('ok') })
  const r = await buy(BONK, 0.01, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: wallet.secret }))
  assert.equal(r.status, 'blocked')
  assert.equal(r.mode, 'live')
  assert.equal(jupiterCalls(m).length, 0)
})

test('live buy over the cap is blocked before anything is called', async () => {
  const wallet = await testWallet()
  const m = use({})
  const r = await buy(BONK, 0.5, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: wallet.secret }))
  assert.equal(r.status, 'blocked')
  assert.equal(m.calls.length, 0)
})

test('an order without a transaction fails without executing', async () => {
  const wallet = await testWallet()
  const m = use({ ...okChecks, [`GET ${JUP}/swap/v2/order`]: quote({ transaction: '', errorCode: 1, errorMessage: 'Insufficient funds' }) })
  const r = await buy(BONK, 0.01, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: wallet.secret }))
  assert.equal(r.status, 'failed')
  assert.match(r.message, /Insufficient funds/)
  assert.equal(m.calls.some((c) => c.url.pathname.endsWith('/execute')), false)
})

test('a bad private key is reported without echoing it', async () => {
  use({ ...okChecks })
  const r = await buy(BONK, 0.01, config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: 'not0base58!' }))
  assert.equal(r.status, 'error')
  assert.equal(r.message.includes('not0base58!'), false)
})

test('live sell converts atomic units for the preflight and sells into SOL even on avoid', async () => {
  const wallet = await testWallet()
  const m = use({
    [`GET ${DEXRA}/describe_address`]: { body: { result: { stats: { decimals: 5 } } } },
    [`GET ${DEXRA}/swap_preflight`]: dexraResult('avoid', ['transfer fee 50%']),
    [`GET ${JUP}/swap/v2/order`]: quote({ transaction: unsignedTransaction(wallet.address) }),
    [`POST ${JUP}/swap/v2/execute`]: { body: { status: 'Failed', signature: 'SIGF', code: -1000, error: 'Failed to land' } },
  })
  const r = await sell(BONK, '250000', config({ DRY_RUN: 'false', JUPITER_API_KEY: 'jup', SOLANA_PRIVATE_KEY: wallet.secret }))
  assert.equal(r.decision?.allowed, true)
  assert.equal(r.decision?.verdicts.preflight, 'avoid')
  assert.equal(r.input.amount, 2.5)
  const pre = m.calls.find((c) => c.url.pathname === '/swap_preflight')!
  assert.equal(pre.url.searchParams.get('amount'), '2.5')
  assert.equal(pre.url.searchParams.get('side'), 'sell')
  const order = m.calls.find((c) => c.url.pathname === '/swap/v2/order')!
  assert.equal(order.url.searchParams.get('inputMint'), BONK)
  assert.equal(order.url.searchParams.get('outputMint'), SOL)
  assert.equal(order.url.searchParams.get('amount'), '250000')
  assert.equal(r.status, 'failed')
  assert.equal(r.execution?.code, -1000)
})

test('buy and sell never throw, even on invalid config', async () => {
  const m = use({})
  process.env.SLIPPAGE_BPS = '5000'
  try {
    const b = await buy(BONK, 0.01)
    assert.equal(b.status, 'error')
    assert.match(b.message, /SLIPPAGE_BPS/)
    assert.equal((await sell(BONK, 'abc')).status, 'error')
  } finally {
    delete process.env.SLIPPAGE_BPS
  }
  assert.equal(m.calls.length, 0)
})
