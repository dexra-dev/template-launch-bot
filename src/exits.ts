import type { Position } from './positions.js'

export interface ExitRules {
  holdMinutes: number
  takeProfitPct: number
  stopLossPct: number
}

export interface ExitCheck {
  /** Null to keep holding. */
  reason: 'take_profit' | 'stop_loss' | 'hold_time' | null
  /** Change in SOL value against the cost, in percent; null without a quote. */
  pnlPct: number | null
  heldMinutes: number
}

/** Decides whether to sell, from what a Jupiter quote says the position is worth now. A rule set to 0 is off. */
export function checkExit(position: Position, valueLamports: bigint | null, rules: ExitRules, now: number): ExitCheck {
  const heldMinutes = (now - position.openedAt) / 60_000
  const cost = BigInt(position.costLamports)
  const pnlPct = valueLamports !== null && cost > 0n ? (Number(valueLamports - cost) / Number(cost)) * 100 : null

  let reason: ExitCheck['reason'] = null
  if (pnlPct !== null && rules.takeProfitPct > 0 && pnlPct >= rules.takeProfitPct) reason = 'take_profit'
  else if (pnlPct !== null && rules.stopLossPct > 0 && pnlPct <= -rules.stopLossPct) reason = 'stop_loss'
  else if (rules.holdMinutes > 0 && heldMinutes >= rules.holdMinutes) reason = 'hold_time'
  return { reason, pnlPct: pnlPct === null ? null : Math.round(pnlPct * 100) / 100, heldMinutes: Math.round(heldMinutes * 10) / 10 }
}
