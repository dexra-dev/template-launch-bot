# Dexra launch bot

A TypeScript bot that watches new Solana launches and buys only the ones [Dexra](https://dexra.dev/docs/templates?utm_source=github&utm_medium=referral&utm_campaign=templates&utm_content=template-launch-bot) marks `ok`. Every candidate then goes through the Dexra trading core, which re-checks the token with `token_deep_check` and `swap_preflight` before it quotes or sends anything. Launches come in by polling `new_launches` or by a signed webhook from a Dexra `launches` watch. On top of the core, the bot caps buys per hour and open positions, and an optional exit loop sells after a hold time or at a take-profit or stop-loss level. There is no LLM: it is a plain bot with JSON logs.

## Safety

- It is a dry run by default. Trades are sent only with `DRY_RUN=false`, `SOLANA_PRIVATE_KEY` and `JUPITER_API_KEY` all set. In a dry run it logs what it would buy or sell.
- `MAX_TRADE_SOL` (default 0.05) caps each buy. A larger buy is refused, not reduced. `BUY_SOL` (default 0.01) above the cap stops the bot at start.
- `MAX_BUYS_PER_HOUR` (default 2) and `MAX_OPEN_POSITIONS` (default 3) are checked before any paid call. Positions and recent buys are kept in `positions.json`, so a restart doesn't reset them.
- What blocks a buy:
  - the launch's own verdict is not `ok` (`caution`, `avoid`, `unknown` or missing), its liquidity collapsed or is under `MIN_LIQUIDITY_USD`, or its platform is not in `PLATFORMS`;
  - the core's `token_deep_check` or `swap_preflight` verdict is not `ok` (`caution` passes only with `ALLOW_CAUTION=true`);
  - any Dexra error (402, 429, 5xx, network). The core fails closed;
  - a limit is reached, or the bot already holds the mint.
- In webhook mode nothing is acted on until `X-Dexra-Signature` checks out against the raw body. Unsigned, forged, changed or old (over 5 minutes) requests get 401.
- Sells are never blocked by a verdict, so a position can always exit.
- Use a dedicated wallet that holds little SOL. The caps limit each trade, not the total.

Not financial advice. A Dexra `ok` means launches like it survived more often in our published report, not that the price will go up.

## Quick start

Click **Use this template** on GitHub, or:

```sh
git clone https://github.com/dexra-dev/template-launch-bot
cd template-launch-bot
cp .env.example .env    # add DEXRA_API_KEY
npm install
npm run dry-run         # one poll, then the buy path for BONK, always a dry run
npm start               # runs the bot (dry run unless you switch live on)
```

Get a key at [dexra.dev/app/keys](https://dexra.dev/app/keys?utm_source=github&utm_medium=referral&utm_campaign=templates&utm_content=template-launch-bot). The free tier includes 100 credits a day; tools can also be paid per call over x402.

### Credits

Each `new_launches` poll is one call, and each candidate the core re-checks is a `token_deep_check` plus a `swap_preflight`. Polling every 60 seconds is 1,440 calls a day, more than the free tier covers, so raise `POLL_SECONDS` or use webhook mode on Free. Duplicate mints, filtered launches and launches over a limit cost nothing more.

### Webhook mode

```sh
MODE=webhook WEBHOOK_PUBLIC_URL=https://your-host.example/dexra npm start
```

On first start the bot creates a `launches` watch with `createWatch` and saves its id and signing secret to `watch.json` (Dexra shows the secret once). Later starts reuse it. To use a watch you made yourself, set `DEXRA_WEBHOOK_SECRET` instead. The server answers 200 right away and handles the launches in order. Platform and liquidity filters still apply on the bot side.

## Configuration

| Variable | Default | Meaning |
| - | - | - |
| `DEXRA_API_KEY` | unset | `dxr_…` key. Without it, paid checks answer 402, which blocks every buy. |
| `DEXRA_BASE_URL` | `https://api.dexra.dev` | Point at a local API for testing. |
| `DRY_RUN` | `true` | Only `false`/`0`/`no`/`off` turn it off. |
| `SOLANA_PRIVATE_KEY` | unset | Base58 64-byte secret key, live only. Never logged. |
| `JUPITER_API_KEY` | unset | Needed for live trading, dry-run quotes and the exit loop. |
| `MAX_TRADE_SOL` | `0.05` | Hard cap per buy. |
| `SLIPPAGE_BPS` | `100` | Jupiter slippage, 0 to 1000. |
| `ALLOW_CAUTION` | `false` | Lets a `caution` from the core's re-check pass. Intake still takes only `ok` launches. |
| `MODE` | `poll` | `poll` or `webhook`. |
| `BUY_SOL` | `0.01` | SOL per buy, at most `MAX_TRADE_SOL`. |
| `POLL_SECONDS` | `60` | Seconds between `new_launches` calls (at least 10). |
| `LAUNCH_MINUTES` | `5` | Launch window per poll, 1 to 60. |
| `MIN_LIQUIDITY_USD` | `5000` | Skip thinner launches. 0 turns it off. |
| `PLATFORMS` | all | Comma list: `pump_fun`, `letsbonk`, `raydium_launchlab`, `meteora_dbc`, `pump_swap`, `raydium_amm_v4`, `raydium_cpmm`. |
| `WEBHOOK_HOST` / `WEBHOOK_PORT` / `WEBHOOK_PATH` | `0.0.0.0` / `8787` / `/dexra` | Where the webhook server listens. |
| `WEBHOOK_PUBLIC_URL` | unset | Public URL Dexra posts to; needed to create the watch. |
| `WATCH_INTERVAL_MINUTES` | `2` | How often the watch runs on Dexra's side. |
| `WATCH_FILE` | `watch.json` | Saved watch id and secret. |
| `DEXRA_WEBHOOK_SECRET` | unset | Secret of an existing watch; skips creating one. |
| `MAX_BUYS_PER_HOUR` | `2` | Buys in any 60 minutes. |
| `MAX_OPEN_POSITIONS` | `3` | Positions held at once. |
| `POSITIONS_FILE` | `positions.json` | Positions and recent buys. Dry-run and live positions are kept apart. |
| `HOLD_MINUTES` | `30` | Sell after this long. 0 turns it off. |
| `TAKE_PROFIT_PCT` | `50` | Sell when the quoted value is this much above cost. 0 turns it off. |
| `STOP_LOSS_PCT` | `30` | Sell when it is this much below cost. 0 turns it off. |
| `EXIT_CHECK_SECONDS` | `30` | Seconds between exit checks. |

## How the guard works

1. Intake keeps a launch only if its `new_launches` verdict is `ok` and it passes the liquidity and platform filters. Each mint is considered once.
2. The risk limits are checked. If one is reached, the launch is skipped before any paid call.
3. The core's `buy` runs `token_deep_check` and `swap_preflight` in parallel. Both must say `ok`, or the buy is blocked. Then it quotes and, if live, signs and sends through Jupiter.
4. The exit loop prices each position with a Jupiter quote and calls the core's `sell` when a rule hits. A failed live sell stays open and is tried again.

The core's full rules are in [src/core/README.md](src/core/README.md). Don't edit `src/core/`; the bot builds on it so the guard can't be skipped.

Each log line is one JSON object (`ts`, `level`, `event`, fields). Useful events: `candidate`, `buy_result` (with verdicts and reasons), `launch_skipped`, `limit_reached`, `exit`, `webhook_rejected`.

## Project layout

```
src/
  core/          Dexra trading core, copied as is (guard, Dexra client, Jupiter, buy/sell)
  bot.ts         intake → limits → core buy; exit loop
  intake.ts      launch filter and mint dedupe
  positions.ts   positions file and risk limits
  exits.ts       hold time, take profit, stop loss
  webhook.ts     launches watch and signed webhook server
  settings.ts    bot settings from the environment
  log.ts         JSON logs
  main.ts        entry point
scripts/dry-run.ts   one poll plus the BONK buy path, forced dry run
test/            mocked tests (no network)
```

## Links

- [Dexra template docs](https://dexra.dev/docs/templates?utm_source=github&utm_medium=referral&utm_campaign=templates&utm_content=template-launch-bot)
- [API keys](https://dexra.dev/app/keys?utm_source=github&utm_medium=referral&utm_campaign=templates&utm_content=template-launch-bot)
- [Accuracy report](https://dexra.dev/accuracy?utm_source=github&utm_medium=referral&utm_campaign=templates&utm_content=template-launch-bot)
- [Jupiter Swap API v2](https://developers.jup.ag/docs/swap/order-and-execute)
- [@dexra-dev/client on npm](https://www.npmjs.com/package/@dexra-dev/client)

MIT licensed.
