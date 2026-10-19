import type { Deps } from '../src/bot.js'
import { LaunchBot } from '../src/bot.js'
import type { Config } from '../src/core/config.js'
import type { TradeResult } from '../src/core/trade.js'
import type { Launch } from '../src/intake.js'
import { silent } from '../src/log.js'
import { PositionStore } from '../src/positions.js'
import { loadSettings } from '../src/settings.js'
import { config as coreConfig } from './core/helpers.js'

export const MINT_A = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
export const MINT_B = 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm'
export const MINT_C = 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN'
export const MINT_D = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'

export function launch(mint: string, extra: Partial<Launch> = {}): Launch {
  return { mint, platform: 'pump_fun', verdict: 'ok', reasons: [], token: { symbol: 'TEST' }, liquidity: { usd: 20_000 }, ...extra }
}

export function tradeResult(side: 'buy' | 'sell', mint: string, status: TradeResult['status'], extra: Partial<TradeResult> = {}): TradeResult {
  return {
    ok: status === 'dry_run' || status === 'executed',
    status,
    mode: 'dry_run',
    side,
    mint,
    input: { mint, amountAtomic: '10000000', amount: 0.01 },
    outputMint: mint,
    decision: { side, mint, amount: 0.01, allowed: status !== 'blocked', verdicts: { token: 'ok', preflight: 'ok' }, reasons: [], summaries: { token: null, preflight: null } },
    quote: { requestId: 'r', inAmount: '10000000', outAmount: '5000', minOutAmount: null, priceImpactPct: null, slippageBps: 100, router: null, feeBps: null },
    signature: null,
    explorerUrl: null,
    execution: null,
    message: status,
    ...extra,
  }
}

export interface Harness {
  bot: LaunchBot
  clock: { now: number }
  buys: string[]
  sells: { mint: string; amount: string }[]
  /** Lamports the next exit quote returns; null makes the quote fail. */
  value: { lamports: bigint | null }
}

export function harness(env: Record<string, string> = {}, overrides: Partial<Deps> = {}): Harness {
  const clock = { now: Date.UTC(2026, 9, 19, 12) }
  const buys: string[] = []
  const sells: { mint: string; amount: string }[] = []
  const value = { lamports: 10_000_000n as bigint | null }
  const config: Config = coreConfig({ JUPITER_API_KEY: 'jup', ...env })
  const deps: Deps = {
    buy: async (mint) => {
      buys.push(mint)
      return tradeResult('buy', mint, 'dry_run')
    },
    sell: async (mint, amount) => {
      sells.push({ mint, amount })
      return tradeResult('sell', mint, 'dry_run')
    },
    freshLaunches: async () => ({ launches: [] }),
    quoteValue: async () => {
      if (value.lamports === null) throw new Error('no route')
      return value.lamports
    },
    now: () => clock.now,
    ...overrides,
  }
  const bot = new LaunchBot(loadSettings({ ...env }, config), config, new PositionStore(null), deps, silent)
  return { bot, clock, buys, sells, value }
}
