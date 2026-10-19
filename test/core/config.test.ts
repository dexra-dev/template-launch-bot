import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, loadConfig } from '../../src/core/config.js'

test('defaults are a safe dry run', () => {
  const c = loadConfig({})
  assert.equal(c.dexraBaseUrl, 'https://api.dexra.dev')
  assert.equal(c.live, false)
  assert.equal(c.dryRunRequested, true)
  assert.equal(c.maxTradeSol, 0.05)
  assert.equal(c.slippageBps, 100)
  assert.equal(c.allowCaution, false)
})

test('live needs DRY_RUN=false, a wallet and a Jupiter key', () => {
  const full = { DRY_RUN: 'false', SOLANA_PRIVATE_KEY: 'secret', JUPITER_API_KEY: 'jup' }
  assert.equal(loadConfig(full).live, true)
  assert.equal(loadConfig({ ...full, DRY_RUN: 'true' }).live, false)
  assert.equal(loadConfig({ ...full, SOLANA_PRIVATE_KEY: '' }).dryRunReason, 'SOLANA_PRIVATE_KEY is not set')
  assert.equal(loadConfig({ ...full, JUPITER_API_KEY: '' }).dryRunReason, 'JUPITER_API_KEY is not set')
})

test('invalid limits are refused', () => {
  assert.throws(() => loadConfig({ SLIPPAGE_BPS: '1001' }), ConfigError)
  assert.throws(() => loadConfig({ SLIPPAGE_BPS: '1.5' }), ConfigError)
  assert.throws(() => loadConfig({ MAX_TRADE_SOL: '0' }), ConfigError)
  assert.throws(() => loadConfig({ MAX_TRADE_SOL: 'lots' }), ConfigError)
  assert.throws(() => loadConfig({ DRY_RUN: 'maybe' }), ConfigError)
})

test('the secret key never serializes', () => {
  const c = loadConfig({ SOLANA_PRIVATE_KEY: 'super-secret-key' })
  assert.equal(c.secretKey(), 'super-secret-key')
  assert.equal(JSON.stringify(c).includes('super-secret-key'), false)
})
