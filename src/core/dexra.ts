import { Dexra, DexraError, type ToolResult, type Verdict } from '@dexra-dev/client'
import { loadConfig, type Config } from './config.js'

export { DexraError, type ToolResult, type Verdict }

export interface LaunchOptions {
  minutes?: number
  limit?: number
  min_liquidity_usd?: number
  platforms?: string
  include_collapsed?: boolean
}

/** Builds a Dexra SDK client from the config. */
export function dexraClient(config: Config = loadConfig()): Dexra {
  // Resolve fetch per call so tests (and agents) can swap globalThis.fetch after the client exists.
  return new Dexra({
    apiKey: config.dexraApiKey,
    baseUrl: config.dexraBaseUrl,
    fetch: (input, init) => globalThis.fetch(input, init),
  })
}

/** Runs token_deep_check for a mint: holder graph, authorities, Token-2022 extensions. */
export function checkToken(mint: string, config: Config = loadConfig()): Promise<ToolResult> {
  return dexraClient(config).tokenDeepCheck({ mint })
}

/** Runs swap_preflight; amount is SOL for a buy and token units for a sell. */
export function preflight(
  mint: string,
  side: 'buy' | 'sell',
  amount: number,
  config: Config = loadConfig(),
): Promise<ToolResult> {
  return dexraClient(config).swapPreflight({ mint, side, amount })
}

/** Lists fresh launches from new_launches, each with its own verdict. */
export function freshLaunches(options: LaunchOptions = {}, config: Config = loadConfig()): Promise<ToolResult> {
  return dexraClient(config).newLaunches(options)
}

/** Describes any address (free); used here to read a mint's decimals. */
export function describeAddress(address: string, config: Config = loadConfig()): Promise<ToolResult> {
  return dexraClient(config).describeAddress({ address })
}

/** Turns any thrown value into one line that names the Dexra error kind when there is one. */
export function errorText(error: unknown): string {
  if (error instanceof DexraError) return `${error.kind} (HTTP ${error.status}): ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
