// A pre-buy gate to copy into a bot you already have. It needs only @dexra-dev/client, not the
// trading core: call it right before your swap and buy only when `allowed` is true.
//
//   npx tsx examples/whitelist-gate.ts <mint> [sol]
import { pathToFileURL } from 'node:url'
import { Dexra, DexraError, type ToolResult, type Verdict } from '@dexra-dev/client'

export interface GateOptions {
  /** Without a key the gate is off and allows every buy, so adding it changes nothing until you opt in. */
  apiKey?: string
  baseUrl?: string
  /** Accept `caution` as well as `ok`. */
  allowCaution?: boolean
  /** On a Dexra error (402, 429, 5xx, network) allow the buy instead of blocking it. */
  failOpen?: boolean
}

export interface GateResult {
  allowed: boolean
  /** False when the gate is off (no key). */
  checked: boolean
  verdicts: { token: Verdict | null; preflight: Verdict | null }
  reasons: string[]
}

function verdictOf(result: ToolResult): Verdict {
  const v = result.verdict
  return v === 'ok' || v === 'caution' || v === 'avoid' ? v : 'unknown'
}

function errorText(error: unknown): string {
  if (error instanceof DexraError) return `${error.kind} (HTTP ${error.status})`
  return error instanceof Error ? error.message : String(error)
}

/** Whitelist check: the buy passes only if token_deep_check and swap_preflight both say `ok`. */
export async function dexraAllowsBuy(mint: string, amountSol: number, options: GateOptions = {}): Promise<GateResult> {
  const apiKey = options.apiKey ?? process.env.DEXRA_API_KEY
  const result: GateResult = { allowed: true, checked: false, verdicts: { token: null, preflight: null }, reasons: [] }
  if (!apiKey) {
    result.reasons.push('DEXRA_API_KEY is not set, gate is off')
    return result
  }

  const dexra = new Dexra({ apiKey, baseUrl: options.baseUrl ?? process.env.DEXRA_BASE_URL })
  const [token, swap] = await Promise.allSettled([
    dexra.tokenDeepCheck({ mint }),
    dexra.swapPreflight({ mint, side: 'buy', amount: amountSol }),
  ])
  result.checked = true

  for (const [tool, outcome, key] of [
    ['token_deep_check', token, 'token'],
    ['swap_preflight', swap, 'preflight'],
  ] as const) {
    if (outcome.status === 'rejected') {
      if (!options.failOpen) result.allowed = false
      result.reasons.push(`${tool} failed (${errorText(outcome.reason)}), ${options.failOpen ? 'allowing' : 'blocking'}`)
      continue
    }
    const verdict = verdictOf(outcome.value)
    result.verdicts[key] = verdict
    if (!(verdict === 'ok' || (verdict === 'caution' && options.allowCaution))) result.allowed = false
    result.reasons.push(`${tool}: ${verdict}`, ...(outcome.value.reasons ?? []).map((r) => `${tool}: ${r}`))
  }
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [mint, sol = '0.01'] = process.argv.slice(2)
  if (!mint) throw new Error('usage: npx tsx examples/whitelist-gate.ts <mint> [sol]')
  console.log(JSON.stringify(await dexraAllowsBuy(mint, Number(sol)), null, 2))
}
