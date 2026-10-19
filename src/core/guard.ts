import { loadConfig, type Config } from './config.js'
import { checkToken, errorText, preflight, type ToolResult, type Verdict } from './dexra.js'

export interface Decision {
  side: 'buy' | 'sell'
  mint: string
  /** SOL for a buy, token units for a sell. */
  amount: number
  allowed: boolean
  verdicts: { token: Verdict | null; preflight: Verdict | null }
  /** Why the trade is allowed or blocked, worst first; Dexra's own reasons are prefixed with the tool name. */
  reasons: string[]
  summaries: { token: string | null; preflight: string | null }
}

const MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

function verdictOf(result: ToolResult): Verdict {
  const v = result.verdict
  return v === 'ok' || v === 'caution' || v === 'avoid' ? v : 'unknown'
}

function passes(verdict: Verdict, allowCaution: boolean): boolean {
  return verdict === 'ok' || (verdict === 'caution' && allowCaution)
}

function dexraReasons(tool: string, result: ToolResult): string[] {
  return (result.reasons ?? []).map((reason) => `${tool}: ${reason}`)
}

/** Decides whether buying `amountSol` of `mint` is allowed; fails closed on any Dexra error. */
export async function decideBuy(mint: string, amountSol: number, config: Config = loadConfig()): Promise<Decision> {
  const decision: Decision = {
    side: 'buy',
    mint,
    amount: amountSol,
    allowed: false,
    verdicts: { token: null, preflight: null },
    reasons: [],
    summaries: { token: null, preflight: null },
  }

  if (!MINT_PATTERN.test(mint)) {
    decision.reasons.push('mint is not a valid Solana address')
    return decision
  }
  if (!Number.isFinite(amountSol) || amountSol <= 0) {
    decision.reasons.push('amount must be above 0 SOL')
    return decision
  }
  if (amountSol > config.maxTradeSol) {
    decision.reasons.push(`amount ${amountSol} SOL is above MAX_TRADE_SOL ${config.maxTradeSol}`)
    return decision
  }

  const [token, swap] = await Promise.allSettled([
    checkToken(mint, config),
    preflight(mint, 'buy', amountSol, config),
  ])

  const blockers: string[] = []
  const notes: string[] = []
  for (const [tool, outcome, key] of [
    ['token_deep_check', token, 'token'],
    ['swap_preflight', swap, 'preflight'],
  ] as const) {
    if (outcome.status === 'rejected') {
      blockers.push(`${tool} failed, blocking to be safe: ${errorText(outcome.reason)}`)
      continue
    }
    const verdict = verdictOf(outcome.value)
    decision.verdicts[key] = verdict
    decision.summaries[key] = typeof outcome.value.summary === 'string' ? outcome.value.summary : null
    if (passes(verdict, config.allowCaution)) {
      notes.push(`${tool} verdict ${verdict}`, ...dexraReasons(tool, outcome.value))
    } else {
      const hint = verdict === 'caution' ? ' (set ALLOW_CAUTION=true to accept caution)' : ''
      blockers.push(`${tool} verdict ${verdict} blocks the buy${hint}`, ...dexraReasons(tool, outcome.value))
    }
  }

  decision.allowed = blockers.length === 0
  decision.reasons = decision.allowed ? notes : blockers
  return decision
}

/** Reports the preflight verdict for selling `amountTokens` (null when unknown: no preflight); sells are never blocked so a position can always exit. */
export async function decideSell(
  mint: string,
  amountTokens: number | null,
  config: Config = loadConfig(),
): Promise<Decision> {
  const decision: Decision = {
    side: 'sell',
    mint,
    amount: amountTokens ?? 0,
    allowed: false,
    verdicts: { token: null, preflight: null },
    reasons: [],
    summaries: { token: null, preflight: null },
  }
  if (!MINT_PATTERN.test(mint)) {
    decision.reasons.push('mint is not a valid Solana address')
    return decision
  }
  if (amountTokens === null) {
    decision.allowed = true
    decision.reasons.push('token amount unknown (mint decimals unavailable), so no preflight was run; selling anyway')
    return decision
  }
  if (!Number.isFinite(amountTokens) || amountTokens <= 0) {
    decision.reasons.push('amount must be above 0 tokens')
    return decision
  }

  decision.allowed = true
  try {
    const result = await preflight(mint, 'sell', amountTokens, config)
    decision.verdicts.preflight = verdictOf(result)
    decision.summaries.preflight = typeof result.summary === 'string' ? result.summary : null
    decision.reasons.push(`swap_preflight verdict ${decision.verdicts.preflight}`, ...dexraReasons('swap_preflight', result))
  } catch (error) {
    decision.reasons.push(`swap_preflight failed, selling anyway: ${errorText(error)}`)
  }
  return decision
}
