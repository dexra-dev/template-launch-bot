import { loadConfig, type Config } from './config.js'

// Jupiter Swap API v2, Meta-Aggregator path: https://developers.jup.ag/docs/swap/order-and-execute
export const JUPITER_BASE_URL = 'https://api.jup.ag/swap/v2'

export interface OrderParams {
  inputMint: string
  outputMint: string
  /** Atomic units of the input token (lamports for SOL). */
  amount: string | bigint | number
  /** Wallet that signs; without it Jupiter returns a quote and `transaction: null`. */
  taker?: string
  slippageBps?: number
}

export interface OrderResponse {
  requestId: string
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  /** Minimum output after slippage. */
  otherAmountThreshold?: string
  slippageBps?: number
  /** Percentage points, e.g. -0.1 = -0.1%. */
  priceImpact?: number
  router?: string
  mode?: string
  feeBps?: number
  feeMint?: string
  /** Base64 unsigned transaction; null without taker, "" when the route can't be built (see errorCode). */
  transaction: string | null
  transactionVersion?: number
  lastValidBlockHeight?: string
  gasless?: boolean
  errorCode?: number
  errorMessage?: string
  [field: string]: unknown
}

export interface ExecuteResponse {
  status: 'Success' | 'Failed'
  signature?: string
  slot?: string
  /** 0 = success; negative codes are documented at /docs/swap/order-and-execute#execute-error-codes. */
  code: number
  error?: string
  totalInputAmount?: string
  totalOutputAmount?: string
  inputAmountResult?: string
  outputAmountResult?: string
  [field: string]: unknown
}

export class JupiterError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly body: unknown,
  ) {
    super(message)
    this.name = 'JupiterError'
  }
}

function apiKey(config: Config): string {
  if (!config.jupiterApiKey) throw new JupiterError(0, 'JUPITER_API_KEY is not set', null)
  return config.jupiterApiKey
}

async function call<T>(response: Response, what: string): Promise<T> {
  const text = await response.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? String(body.error) : text.slice(0, 200)
    throw new JupiterError(response.status, `${what} failed with HTTP ${response.status}: ${detail}`, body)
  }
  return body as T
}

/** GET /order: a quote, plus an unsigned transaction when `taker` is given. */
export async function order(params: OrderParams, config: Config = loadConfig()): Promise<OrderResponse> {
  const query = new URLSearchParams({
    inputMint: params.inputMint,
    outputMint: params.outputMint,
    amount: String(params.amount),
  })
  if (params.taker) query.set('taker', params.taker)
  if (params.slippageBps !== undefined) query.set('slippageBps', String(params.slippageBps))
  const response = await globalThis.fetch(`${JUPITER_BASE_URL}/order?${query}`, {
    headers: { 'x-api-key': apiKey(config), accept: 'application/json' },
  })
  return call<OrderResponse>(response, 'Jupiter /order')
}

/** POST /execute: lands a signed /order transaction and reports the outcome. */
export async function execute(
  args: { signedTransaction: string; requestId: string },
  config: Config = loadConfig(),
): Promise<ExecuteResponse> {
  const response = await globalThis.fetch(`${JUPITER_BASE_URL}/execute`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey(config), 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ signedTransaction: args.signedTransaction, requestId: args.requestId }),
  })
  return call<ExecuteResponse>(response, 'Jupiter /execute')
}
