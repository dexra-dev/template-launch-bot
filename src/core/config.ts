export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const LAMPORTS_PER_SOL = 1_000_000_000
export const SLIPPAGE_BPS_CAP = 1000

export interface Config {
  dexraApiKey?: string
  dexraBaseUrl: string
  jupiterApiKey?: string
  /** The wallet secret is behind a function so the config can be logged or serialized without leaking it. */
  secretKey: () => string | undefined
  /** True when SOLANA_PRIVATE_KEY is set. */
  hasWallet: boolean
  /** DRY_RUN as configured (true unless set to false/0/no). */
  dryRunRequested: boolean
  /** True when trades are actually sent: DRY_RUN=false and a wallet and a Jupiter key are present. */
  live: boolean
  /** Why the core is in dry run, or null when live. */
  dryRunReason: string | null
  maxTradeSol: number
  slippageBps: number
  allowCaution: boolean
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigError'
  }
}

type Env = Record<string, string | undefined>

function text(env: Env, name: string): string | undefined {
  const value = env[name]?.trim()
  return value ? value : undefined
}

function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = text(env, name)?.toLowerCase()
  if (value === undefined) return fallback
  if (['true', '1', 'yes', 'on'].includes(value)) return true
  if (['false', '0', 'no', 'off'].includes(value)) return false
  throw new ConfigError(`${name} must be true or false, got "${value}"`)
}

function number(env: Env, name: string, fallback: number): number {
  const value = text(env, name)
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new ConfigError(`${name} must be a number, got "${value}"`)
  return parsed
}

/** Reads the core's settings from the environment; throws ConfigError on invalid values. */
export function loadConfig(env: Env = process.env): Config {
  const maxTradeSol = number(env, 'MAX_TRADE_SOL', 0.05)
  if (maxTradeSol <= 0) throw new ConfigError('MAX_TRADE_SOL must be above 0')

  const slippageBps = number(env, 'SLIPPAGE_BPS', 100)
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > SLIPPAGE_BPS_CAP) {
    throw new ConfigError(`SLIPPAGE_BPS must be a whole number from 0 to ${SLIPPAGE_BPS_CAP}`)
  }

  const secret = text(env, 'SOLANA_PRIVATE_KEY')
  const jupiterApiKey = text(env, 'JUPITER_API_KEY')
  const dryRunRequested = flag(env, 'DRY_RUN', true)

  let dryRunReason: string | null = null
  if (dryRunRequested) dryRunReason = 'DRY_RUN is not false'
  else if (!secret) dryRunReason = 'SOLANA_PRIVATE_KEY is not set'
  else if (!jupiterApiKey) dryRunReason = 'JUPITER_API_KEY is not set'

  return {
    dexraApiKey: text(env, 'DEXRA_API_KEY'),
    dexraBaseUrl: (text(env, 'DEXRA_BASE_URL') ?? 'https://api.dexra.dev').replace(/\/$/, ''),
    jupiterApiKey,
    secretKey: () => secret,
    hasWallet: secret !== undefined,
    dryRunRequested,
    live: dryRunReason === null,
    dryRunReason,
    maxTradeSol,
    slippageBps,
    allowCaution: flag(env, 'ALLOW_CAUTION', false),
  }
}
