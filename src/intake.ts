/** The fields of a new_launches entry the bot reads. Dexra sends many more. */
export interface Launch {
  mint: string
  platform?: string
  verdict?: string
  reasons?: string[]
  age_secs?: number
  token?: { symbol?: string | null; name?: string | null }
  liquidity?: { usd?: number | null; collapsed?: boolean }
  [field: string]: unknown
}

export interface Filters {
  minLiquidityUsd: number
  platforms: string[]
}

/** Remembers mints already handled, oldest dropped first, so one launch is considered once. */
export class SeenMints {
  private readonly seen = new Set<string>()
  constructor(private readonly capacity = 5000) {}

  /** True the first time a mint is offered, false after. */
  add(mint: string): boolean {
    if (this.seen.has(mint)) return false
    this.seen.add(mint)
    if (this.seen.size > this.capacity) {
      const oldest = this.seen.values().next().value
      if (oldest !== undefined) this.seen.delete(oldest)
    }
    return true
  }

  has(mint: string): boolean {
    return this.seen.has(mint)
  }

  get size(): number {
    return this.seen.size
  }
}

/** Why a launch is not a candidate, or null when it is one. Only a launch Dexra marks `ok` passes. */
export function rejectReason(launch: Launch, filters: Filters): string | null {
  if (typeof launch.mint !== 'string' || !launch.mint) return 'no mint'
  if (launch.verdict !== 'ok') return `verdict ${launch.verdict ?? 'missing'}`
  if (launch.liquidity?.collapsed) return 'liquidity collapsed'
  const usd = launch.liquidity?.usd
  if (filters.minLiquidityUsd > 0 && (typeof usd !== 'number' || usd < filters.minLiquidityUsd)) {
    return `liquidity ${typeof usd === 'number' ? `$${Math.round(usd)}` : 'unknown'} below $${filters.minLiquidityUsd}`
  }
  if (filters.platforms.length > 0 && !filters.platforms.includes(launch.platform ?? '')) {
    return `platform ${launch.platform ?? 'unknown'} not in PLATFORMS`
  }
  return null
}

/** Reads the launches array from a new_launches result or a webhook payload. */
export function launchesOf(value: unknown): Launch[] {
  const launches = (value as { launches?: unknown } | null)?.launches
  return Array.isArray(launches) ? launches.filter((l): l is Launch => typeof l?.mint === 'string') : []
}
