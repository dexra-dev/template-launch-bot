import { loadConfig } from './core/config.js'
import { LaunchBot } from './bot.js'
import { log } from './log.js'
import { PositionStore } from './positions.js'
import { loadSettings } from './settings.js'
import { ensureWatch, webhookServer } from './webhook.js'

async function main(): Promise<void> {
  const config = loadConfig()
  const settings = loadSettings(process.env, config)
  const store = new PositionStore(settings.positionsFile)
  const bot = new LaunchBot(settings, config, store)

  log('info', 'start', {
    mode: settings.mode,
    trading: bot.mode,
    dry_run_reason: config.dryRunReason,
    dexra: config.dexraBaseUrl,
    dexra_key: Boolean(config.dexraApiKey),
    buy_sol: settings.buySol,
    max_trade_sol: config.maxTradeSol,
    allow_caution: config.allowCaution,
    max_buys_per_hour: settings.maxBuysPerHour,
    max_open_positions: settings.maxOpenPositions,
    open_positions: store.open(bot.mode).length,
    exits: bot.exitsEnabled
      ? { hold_minutes: settings.holdMinutes, take_profit_pct: settings.takeProfitPct, stop_loss_pct: settings.stopLossPct }
      : 'off (no JUPITER_API_KEY)',
  })
  if (!config.dexraApiKey) log('warn', 'no_dexra_key', { note: 'without a key, paid checks on api.dexra.dev answer 402, which blocks every buy' })

  const timers: NodeJS.Timeout[] = []
  let server: ReturnType<typeof webhookServer> | null = null

  if (settings.mode === 'poll') {
    const tick = () => void bot.pollOnce()
    tick()
    timers.push(setInterval(tick, settings.pollSeconds * 1000))
  } else {
    const watch = await ensureWatch(settings, config, log)
    server = webhookServer({ path: settings.webhookPath, secret: watch.secret }, (launches) => void bot.handleLaunches(launches, 'webhook'), log)
    server.listen(settings.webhookPort, settings.webhookHost, () =>
      log('info', 'listening', { host: settings.webhookHost, port: settings.webhookPort, path: settings.webhookPath, watch: watch.id }),
    )
  }

  if (bot.exitsEnabled) timers.push(setInterval(() => void bot.checkExits(), settings.exitCheckSeconds * 1000))

  const stop = (signal: string) => {
    log('info', 'stop', { signal })
    for (const timer of timers) clearInterval(timer)
    server?.close()
    process.exit(0)
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
}

main().catch((error) => {
  log('error', 'fatal', { error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
