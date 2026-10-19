import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export interface Position {
  mint: string
  symbol: string | null
  platform: string | null
  /** dry_run positions are simulated; a live bot ignores them. */
  mode: 'dry_run' | 'live'
  openedAt: number
  /** Lamports spent. */
  costLamports: string
  /** Token atomic units received (or quoted, in a dry run); null when no quote was taken. */
  tokensAtomic: string | null
  signature: string | null
}

export interface BuyRecord {
  mint: string
  mode: 'dry_run' | 'live'
  at: number
}

interface FileShape {
  positions: Position[]
  buys: BuyRecord[]
}

const HOUR_MS = 60 * 60 * 1000

/** Open positions and recent buys, kept in a JSON file so limits survive a restart. */
export class PositionStore {
  private data: FileShape = { positions: [], buys: [] }

  /** `path` null keeps everything in memory (tests). */
  constructor(private readonly path: string | null) {
    if (!path) return
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<FileShape>
      this.data = {
        positions: Array.isArray(parsed.positions) ? parsed.positions : [],
        buys: Array.isArray(parsed.buys) ? parsed.buys : [],
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }

  open(mode: Position['mode']): Position[] {
    return this.data.positions.filter((p) => p.mode === mode)
  }

  holds(mint: string, mode: Position['mode']): boolean {
    return this.open(mode).some((p) => p.mint === mint)
  }

  buysInLastHour(mode: Position['mode'], now: number): number {
    return this.data.buys.filter((b) => b.mode === mode && now - b.at < HOUR_MS).length
  }

  add(position: Position): void {
    this.data.positions.push(position)
    this.data.buys.push({ mint: position.mint, mode: position.mode, at: position.openedAt })
    this.save(position.openedAt)
  }

  close(mint: string, mode: Position['mode'], now: number): void {
    this.data.positions = this.data.positions.filter((p) => !(p.mint === mint && p.mode === mode))
    this.save(now)
  }

  private save(now: number): void {
    this.data.buys = this.data.buys.filter((b) => now - b.at < HOUR_MS)
    if (!this.path) return
    // Write then rename, so a crash mid-write can't leave a half file.
    const temp = `${this.path}.tmp`
    writeFileSync(temp, `${JSON.stringify(this.data, null, 2)}\n`)
    renameSync(temp, this.path)
  }
}

export interface Limits {
  maxBuysPerHour: number
  maxOpenPositions: number
}

/** Why another buy is not allowed right now, or null when it is. */
export function limitReason(store: PositionStore, limits: Limits, mode: Position['mode'], now: number): string | null {
  const open = store.open(mode).length
  if (open >= limits.maxOpenPositions) return `MAX_OPEN_POSITIONS reached (${open}/${limits.maxOpenPositions})`
  const recent = store.buysInLastHour(mode, now)
  if (recent >= limits.maxBuysPerHour) return `MAX_BUYS_PER_HOUR reached (${recent}/${limits.maxBuysPerHour})`
  return null
}
