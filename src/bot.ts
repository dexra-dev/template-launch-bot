import { SOL_MINT, type Config } from './core/config.js'
import { errorText, freshLaunches, DexraError, type LaunchOptions, type ToolResult } from './core/dexra.js'
import { order } from './core/jupiter.js'
import { buy, sell, type TradeResult } from './core/trade.js'
import { checkExit } from './exits.js'
import { SeenMints, launchesOf, rejectReason, type Launch } from './intake.js'
import { log as defaultLog, type Logger } from './log.js'
import { PositionStore, limitReason, type Position } from './positions.js'
import type { Settings } from './settings.js'

/** Everything the bot calls outside itself; tests swap these. */
export interface Deps {
  buy: (mint: string, amountSol: number, config: Config) => Promise<TradeResult>
  sell: (mint: string, amountAtomic: string, config: Config) => Promise<TradeResult>
  freshLaunches: (options: LaunchOptions, config: Config) => Promise<ToolResult>
  /** Lamports a Jupiter quote gives for selling `tokensAtomic` of `mint`. */
  quoteValue: (mint: string, tokensAtomic: string, config: Config) => Promise<bigint>
  now: () => number
}

export const defaultDeps: Deps = {
  buy,
  sell,
  freshLaunches,
  quoteValue: async (mint, tokensAtomic, config) => {
    const quote = await order({ inputMint: mint, outputMint: SOL_MINT, amount: tokensAtomic }, config)
    return BigInt(quote.outAmount)
  },
  now: Date.now,
}

export type Outcome = 'duplicate' | 'skipped' | 'held' | 'limited' | 'blocked' | 'bought' | 'failed'

export class LaunchBot {
  readonly seen = new SeenMints()
  readonly mode: Position['mode']
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    readonly settings: Settings,
    readonly config: Config,
    readonly store: PositionStore,
    readonly deps: Deps = defaultDeps,
    readonly log: Logger = defaultLog,
  ) {
    this.mode = config.live ? 'live' : 'dry_run'
  }

  /** Exits need a Jupiter quote to price a position. */
  get exitsEnabled(): boolean {
    return Boolean(this.config.jupiterApiKey)
  }

  /** Runs jobs one at a time, so two launches can't both take the last free slot. */
  private serial<T>(job: () => Promise<T>): Promise<T> {
    const next = this.chain.then(job)
    this.chain = next.catch(() => {})
    return next
  }

  /** Considers each launch once, in order. */
  handleLaunches(launches: Launch[], source: 'poll' | 'webhook'): Promise<Outcome[]> {
    return this.serial(async () => {
      const outcomes: Outcome[] = []
      for (const launch of launches) outcomes.push(await this.consider(launch, source))
      return outcomes
    })
  }

  private async consider(launch: Launch, source: 'poll' | 'webhook'): Promise<Outcome> {
    if (!this.seen.add(launch.mint)) return 'duplicate'
    const base = { mint: launch.mint, symbol: launch.token?.symbol ?? null, platform: launch.platform ?? null, source }

    const rejected = rejectReason(launch, this.settings)
    if (rejected) {
      this.log('info', 'launch_skipped', { ...base, reason: rejected })
      return 'skipped'
    }
    if (this.store.holds(launch.mint, this.mode)) {
      this.log('info', 'launch_skipped', { ...base, reason: 'already holding it' })
      return 'held'
    }
    const limited = limitReason(this.store, this.settings, this.mode, this.deps.now())
    if (limited) {
      this.log('info', 'limit_reached', { ...base, reason: limited })
      return 'limited'
    }

    this.log('info', 'candidate', { ...base, launch_verdict: launch.verdict, launch_reasons: launch.reasons ?? [] })
    // The core re-checks the token (token_deep_check + swap_preflight) and is the only path to a trade.
    const result = await this.deps.buy(launch.mint, this.settings.buySol, this.config)
    this.log(result.ok ? 'info' : 'warn', 'buy_result', {
      ...base,
      status: result.status,
      mode: result.mode,
      verdicts: result.decision?.verdicts ?? null,
      reasons: result.decision?.reasons ?? [],
      quote_out: result.quote?.outAmount ?? null,
      signature: result.signature,
      explorer: result.explorerUrl,
      message: result.message,
    })
    if (result.status === 'blocked') return 'blocked'
    if (!result.ok) return 'failed'

    this.store.add({
      mint: launch.mint,
      symbol: base.symbol,
      platform: base.platform,
      mode: this.mode,
      openedAt: this.deps.now(),
      costLamports: result.input.amountAtomic,
      tokensAtomic: result.execution?.totalOutputAmount ?? result.quote?.outAmount ?? null,
      signature: result.signature,
    })
    return 'bought'
  }

  /** One new_launches call; credits are spent per call, so the caller spaces these out. */
  async pollOnce(): Promise<Outcome[]> {
    const s = this.settings
    let result: ToolResult
    try {
      result = await this.deps.freshLaunches(
        {
          minutes: s.launchMinutes,
          min_liquidity_usd: s.minLiquidityUsd || undefined,
          platforms: s.platforms.length ? s.platforms.join(',') : undefined,
        },
        this.config,
      )
    } catch (error) {
      this.log('warn', 'poll_failed', {
        error: errorText(error),
        retry_after: error instanceof DexraError ? error.retryAfter : null,
      })
      return []
    }
    const launches = launchesOf(result)
    this.log('info', 'poll', { launches: launches.length, summary: result.summary ?? null })
    return this.handleLaunches(launches, 'poll')
  }

  /** Prices every open position with a Jupiter quote and sells the ones an exit rule says to. */
  checkExits(): Promise<void> {
    return this.serial(async () => {
      if (!this.exitsEnabled) return
      for (const position of this.store.open(this.mode)) {
        if (!position.tokensAtomic) {
          this.log('warn', 'exit_skipped', { mint: position.mint, reason: 'token amount unknown' })
          continue
        }
        let value: bigint | null = null
        try {
          value = await this.deps.quoteValue(position.mint, position.tokensAtomic, this.config)
        } catch (error) {
          this.log('warn', 'exit_quote_failed', { mint: position.mint, error: errorText(error) })
        }
        const now = this.deps.now()
        const check = checkExit(position, value, this.settings, now)
        if (!check.reason) continue

        const result = await this.deps.sell(position.mint, position.tokensAtomic, this.config)
        this.log(result.ok ? 'info' : 'warn', 'exit', {
          mint: position.mint,
          symbol: position.symbol,
          rule: check.reason,
          pnl_pct: check.pnlPct,
          held_minutes: check.heldMinutes,
          value_lamports: value,
          cost_lamports: position.costLamports,
          status: result.status,
          mode: result.mode,
          preflight: result.decision?.verdicts.preflight ?? null,
          signature: result.signature,
          message: result.message,
        })
        // A failed live sell stays open and is retried on the next check.
        if (result.ok) this.store.close(position.mint, this.mode, now)
      }
    })
  }
}
