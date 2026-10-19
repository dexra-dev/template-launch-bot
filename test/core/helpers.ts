import {
  address,
  appendTransactionMessageInstruction,
  blockhash,
  compileTransaction,
  createKeyPairFromPrivateKeyBytes,
  createTransactionMessage,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getAddressFromPublicKey,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from '@solana/kit'
import { loadConfig, type Config } from '../../src/core/config.js'

export const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'
export const SOL = 'So11111111111111111111111111111111111111112'

export interface Call {
  method: string
  url: URL
  headers: Record<string, string>
  body: unknown
}

type Reply = { status?: number; body: unknown } | (() => never)
export type Routes = Record<string, Reply | ((call: Call) => Reply)>

/** Replaces globalThis.fetch with a router keyed by "METHOD host/path"; records every call. */
export function mockFetch(routes: Routes): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch
  const calls: Call[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]))
    const call: Call = { method, url, headers, body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(call)
    const key = `${method} ${url.host}${url.pathname}`
    const route = routes[key]
    if (!route) throw new Error(`unexpected request ${key}`)
    let reply = typeof route === 'function' ? (route as (c: Call) => Reply)(call) : route
    if (typeof reply === 'function') reply = reply()
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  return { calls, restore: () => void (globalThis.fetch = original) }
}

export const DEXRA = 'dexra.test'
export const JUP = 'api.jup.ag'

export function config(env: Record<string, string> = {}): Config {
  return loadConfig({ DEXRA_BASE_URL: `http://${DEXRA}`, ...env })
}

export function dexraResult(verdict: string | undefined, reasons: string[] = [], extra: Record<string, unknown> = {}) {
  return { body: { result: { verdict, reasons, summary: `summary ${verdict}`, ...extra } } }
}

/** A throwaway wallet: base58 64-byte secret and its address. */
export async function testWallet(): Promise<{ secret: string; address: string }> {
  const seed = crypto.getRandomValues(new Uint8Array(32))
  const pair = await createKeyPairFromPrivateKeyBytes(seed, true)
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))
  const bytes = new Uint8Array(64)
  bytes.set(seed)
  bytes.set(publicKey, 32)
  return { secret: getBase58Decoder().decode(bytes), address: await getAddressFromPublicKey(pair.publicKey) }
}

/** An unsigned v0 transaction paid by `payer`, base64, like the one /order returns. */
export function unsignedTransaction(payer: string): string {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(address(payer), m),
    (m) =>
      setTransactionMessageLifetimeUsingBlockhash(
        { blockhash: blockhash('11111111111111111111111111111111'), lastValidBlockHeight: 100n },
        m,
      ),
    (m) =>
      appendTransactionMessageInstruction(
        { programAddress: address('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr'), data: new Uint8Array([1, 2, 3]) },
        m,
      ),
  )
  return getBase64EncodedWireTransaction(compileTransaction(message))
}
