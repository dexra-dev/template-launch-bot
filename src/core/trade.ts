import {
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  partiallySignTransaction,
  type KeyPairSigner,
} from '@solana/kit'
import { LAMPORTS_PER_SOL, SOL_MINT, loadConfig, type Config } from './config.js'
import { describeAddress, errorText } from './dexra.js'
import { decideBuy, decideSell, type Decision } from './guard.js'
import { execute, order, type ExecuteResponse, type OrderResponse } from './jupiter.js'

export type TradeStatus = 'blocked' | 'dry_run' | 'executed' | 'failed' | 'error'

/** Plain JSON: safe to show to an LLM or log as is. */
export interface TradeResult {
  /** True when the trade went through, or would have in a dry run. */
  ok: boolean
  status: TradeStatus
  mode: 'dry_run' | 'live'
  side: 'buy' | 'sell'
  mint: string
  /** What is spent: SOL for a buy, the token for a sell, in atomic units and in whole units when known. */
  input: { mint: string; amountAtomic: string; amount: number | null }
  outputMint: string
  decision: Decision | null
  quote: QuoteSummary | null
  signature: string | null
  explorerUrl: string | null
  execution: Pick<ExecuteResponse, 'status' | 'code' | 'error' | 'totalInputAmount' | 'totalOutputAmount'> | null
  /** One line that says what happened. */
  message: string
}

export interface QuoteSummary {
  requestId: string
  inAmount: string
  outAmount: string
  minOutAmount: string | null
  priceImpactPct: number | null
  slippageBps: number | null
  router: string | null
  feeBps: number | null
}

function summarizeQuote(o: OrderResponse): QuoteSummary {
  return {
    requestId: o.requestId,
    inAmount: o.inAmount,
    outAmount: o.outAmount,
    minOutAmount: o.otherAmountThreshold ?? null,
    priceImpactPct: typeof o.priceImpact === 'number' ? o.priceImpact : null,
    slippageBps: typeof o.slippageBps === 'number' ? o.slippageBps : null,
    router: o.router ?? null,
    feeBps: typeof o.feeBps === 'number' ? o.feeBps : null,
  }
}

/** Loads the wallet from SOLANA_PRIVATE_KEY (base58, 64 bytes). */
export async function loadSigner(config: Config = loadConfig()): Promise<KeyPairSigner> {
  const secret = config.secretKey()
  if (!secret) throw new Error('SOLANA_PRIVATE_KEY is not set')
  try {
    return await createKeyPairSignerFromBytes(getBase58Encoder().encode(secret))
  } catch {
    // Never echo the key or the decoder's message, which can contain it.
    throw new Error('SOLANA_PRIVATE_KEY is not a valid base58 64-byte secret key')
  }
}

/** Signs a base64 transaction from /order and returns it base64 again. */
export async function signOrderTransaction(transactionBase64: string, signer: KeyPairSigner): Promise<string> {
  const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(transactionBase64))
  // Partial: JupiterZ (RFQ) routes carry a market maker signature slot that /execute fills in.
  const signed = await partiallySignTransaction([signer.keyPair], transaction)
  return getBase64EncodedWireTransaction(signed)
}

interface Leg {
  side: 'buy' | 'sell'
  mint: string
  inputMint: string
  outputMint: string
  amountAtomic: bigint
  amount: number | null
  decision: Decision
}

function base(leg: Leg, config: Config): TradeResult {
  return {
    ok: false,
    status: 'error',
    mode: config.live ? 'live' : 'dry_run',
    side: leg.side,
    mint: leg.mint,
    input: { mint: leg.inputMint, amountAtomic: leg.amountAtomic.toString(), amount: leg.amount },
    outputMint: leg.outputMint,
    decision: leg.decision,
    quote: null,
    signature: null,
    explorerUrl: null,
    execution: null,
    message: '',
  }
}

async function run(leg: Leg, config: Config): Promise<TradeResult> {
  const result = base(leg, config)
  if (!leg.decision.allowed) {
    result.status = 'blocked'
    result.message = `${leg.side} blocked: ${leg.decision.reasons[0] ?? 'no reason given'}`
    return result
  }

  if (!config.live) {
    result.status = 'dry_run'
    result.ok = true
    if (config.jupiterApiKey) {
      try {
        const quote = await order(
          { inputMint: leg.inputMint, outputMint: leg.outputMint, amount: leg.amountAtomic, slippageBps: config.slippageBps },
          config,
        )
        result.quote = summarizeQuote(quote)
      } catch (error) {
        result.message = `would ${leg.side}, but the Jupiter quote failed: ${errorText(error)} (dry run: ${config.dryRunReason})`
        return result
      }
    }
    const quoted = result.quote ? ` for about ${result.quote.outAmount} atomic units of ${leg.outputMint}` : ''
    result.message = `would ${leg.side} ${leg.amountAtomic} atomic units of ${leg.inputMint}${quoted} (dry run: ${config.dryRunReason})`
    return result
  }

  try {
    const signer = await loadSigner(config)
    const quote = await order(
      {
        inputMint: leg.inputMint,
        outputMint: leg.outputMint,
        amount: leg.amountAtomic,
        taker: signer.address,
        slippageBps: config.slippageBps,
      },
      config,
    )
    result.quote = summarizeQuote(quote)
    if (!quote.transaction) {
      result.status = 'failed'
      result.message = `Jupiter returned no transaction (${quote.router ?? 'router?'} error ${quote.errorCode ?? '?'}: ${quote.errorMessage ?? 'no message'})`
      return result
    }
    const signedTransaction = await signOrderTransaction(quote.transaction, signer)
    const outcome = await execute({ signedTransaction, requestId: quote.requestId }, config)
    result.signature = outcome.signature ?? null
    result.explorerUrl = outcome.signature ? `https://solscan.io/tx/${outcome.signature}` : null
    result.execution = {
      status: outcome.status,
      code: outcome.code,
      error: outcome.error,
      totalInputAmount: outcome.totalInputAmount,
      totalOutputAmount: outcome.totalOutputAmount,
    }
    result.ok = outcome.status === 'Success'
    result.status = result.ok ? 'executed' : 'failed'
    result.message = result.ok
      ? `${leg.side} landed: ${outcome.signature}`
      : `${leg.side} failed with code ${outcome.code}: ${outcome.error ?? 'no error message'}`
    return result
  } catch (error) {
    result.status = 'error'
    result.message = `${leg.side} not sent: ${errorText(error)}`
    return result
  }
}

function errorResult(side: 'buy' | 'sell', mint: string, inputMint: string, outputMint: string, error: unknown): TradeResult {
  return {
    ok: false,
    status: 'error',
    mode: 'dry_run',
    side,
    mint,
    input: { mint: inputMint, amountAtomic: '0', amount: null },
    outputMint,
    decision: null,
    quote: null,
    signature: null,
    explorerUrl: null,
    execution: null,
    message: `${side} not sent: ${errorText(error)}`,
  }
}

/** Buys `mint` with `amountSol` SOL if Dexra allows it; never throws. */
export async function buy(mint: string, amountSol: number, config?: Config): Promise<TradeResult> {
  try {
    const cfg = config ?? loadConfig()
    const decision = await decideBuy(mint, amountSol, cfg)
    const lamports = Number.isFinite(amountSol) && amountSol > 0 ? BigInt(Math.round(amountSol * LAMPORTS_PER_SOL)) : 0n
    return await run(
      { side: 'buy', mint, inputMint: SOL_MINT, outputMint: mint, amountAtomic: lamports, amount: amountSol, decision },
      cfg,
    )
  } catch (error) {
    return errorResult('buy', mint, SOL_MINT, mint, error)
  }
}

async function decimalsOf(mint: string, config: Config): Promise<number | null> {
  try {
    const described = await describeAddress(mint, config)
    const stats = described.stats as { decimals?: unknown } | undefined
    return typeof stats?.decimals === 'number' ? stats.decimals : null
  } catch {
    return null
  }
}

/** Sells `amountAtomic` (smallest units) of `mint` for SOL; logs the preflight verdict but never blocks; never throws. */
export async function sell(mint: string, amountAtomic: string | bigint | number, config?: Config): Promise<TradeResult> {
  try {
    const cfg = config ?? loadConfig()
    const atomic = BigInt(amountAtomic)
    if (atomic <= 0n) throw new Error('amount must be above 0')
    const decimals = await decimalsOf(mint, cfg)
    const tokens = decimals === null ? null : Number(atomic) / 10 ** decimals
    const decision = await decideSell(mint, tokens, cfg)
    return await run(
      { side: 'sell', mint, inputMint: mint, outputMint: SOL_MINT, amountAtomic: atomic, amount: tokens, decision },
      cfg,
    )
  } catch (error) {
    return errorResult('sell', mint, mint, SOL_MINT, error)
  }
}
