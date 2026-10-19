import { ConfigError, loadConfig, type Config } from './core/config.js'

export type Mode = 'poll' | 'webhook'

export interface Settings {
  mode: Mode
  /** SOL spent per buy; must not exceed the core's MAX_TRADE_SOL. */
  buySol: number
  // Intake
  pollSeconds: number
  launchMinutes: number
  minLiquidityUsd: number
  /** Empty means every platform Dexra tracks. */
  platforms: string[]
  // Webhook
  webhookHost: string
  webhookPort: number
  webhookPath: string
  webhookPublicUrl?: string
  webhookSecret?: string
  watchIntervalMinutes: number
  watchFile: string
  // Risk limits on top of the core
  maxBuysPerHour: number
  maxOpenPositions: number
  positionsFile: string
  // Exits
  holdMinutes: number
  takeProfitPct: number
  stopLossPct: number
  exitCheckSeconds: number
}

type Env = Record<string, string | undefined>

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function number(env: Env, name: string, fallback: number, check: (n: number) => boolean, rule: string): number {
  const raw = text(env, name)
  const value = raw === undefined ? fallback : Number(raw)
  if (!Number.isFinite(value) || !check(value)) throw new ConfigError(`${name} must be ${rule}, got "${raw}"`)
  return value
}

const positive = (n: number) => n > 0
const nonNegative = (n: number) => n >= 0
const wholePositive = (n: number) => Number.isInteger(n) && n > 0
const wholeNonNegative = (n: number) => Number.isInteger(n) && n >= 0

/** Reads the bot's own settings; the core's settings come from loadConfig(). Throws ConfigError. */
export function loadSettings(env: Env = process.env, core: Config = loadConfig(env)): Settings {
  const mode = (text(env, 'MODE') ?? 'poll').toLowerCase()
  if (mode !== 'poll' && mode !== 'webhook') throw new ConfigError(`MODE must be poll or webhook, got "${mode}"`)

  const buySol = number(env, 'BUY_SOL', 0.01, positive, 'above 0')
  if (buySol > core.maxTradeSol) {
    throw new ConfigError(`BUY_SOL ${buySol} is above MAX_TRADE_SOL ${core.maxTradeSol}; the core would refuse every buy`)
  }

  const webhookPath = text(env, 'WEBHOOK_PATH') ?? '/dexra'
  return {
    mode,
    buySol,
    pollSeconds: number(env, 'POLL_SECONDS', 60, (n) => n >= 10, 'at least 10'),
    launchMinutes: number(env, 'LAUNCH_MINUTES', 5, (n) => wholePositive(n) && n <= 60, 'a whole number from 1 to 60'),
    minLiquidityUsd: number(env, 'MIN_LIQUIDITY_USD', 5000, nonNegative, '0 or more'),
    platforms: (text(env, 'PLATFORMS') ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean),
    webhookHost: text(env, 'WEBHOOK_HOST') ?? '0.0.0.0',
    webhookPort: number(env, 'WEBHOOK_PORT', 8787, (n) => wholePositive(n) && n < 65536, 'a port number'),
    webhookPath: webhookPath.startsWith('/') ? webhookPath : `/${webhookPath}`,
    webhookPublicUrl: text(env, 'WEBHOOK_PUBLIC_URL'),
    webhookSecret: text(env, 'DEXRA_WEBHOOK_SECRET'),
    watchIntervalMinutes: number(env, 'WATCH_INTERVAL_MINUTES', 2, (n) => wholePositive(n) && n <= 1440, 'a whole number from 1 to 1440'),
    watchFile: text(env, 'WATCH_FILE') ?? 'watch.json',
    maxBuysPerHour: number(env, 'MAX_BUYS_PER_HOUR', 2, wholeNonNegative, 'a whole number, 0 or more'),
    maxOpenPositions: number(env, 'MAX_OPEN_POSITIONS', 3, wholeNonNegative, 'a whole number, 0 or more'),
    positionsFile: text(env, 'POSITIONS_FILE') ?? 'positions.json',
    holdMinutes: number(env, 'HOLD_MINUTES', 30, nonNegative, '0 or more (0 turns it off)'),
    takeProfitPct: number(env, 'TAKE_PROFIT_PCT', 50, nonNegative, '0 or more (0 turns it off)'),
    stopLossPct: number(env, 'STOP_LOSS_PCT', 30, (n) => n >= 0 && n <= 100, 'from 0 to 100 (0 turns it off)'),
    exitCheckSeconds: number(env, 'EXIT_CHECK_SECONDS', 30, (n) => n >= 5, 'at least 5'),
  }
}
