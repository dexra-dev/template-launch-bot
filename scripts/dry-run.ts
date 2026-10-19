// One pass of the bot, forced into dry run whatever the environment says: a new_launches poll,
// then the buy path for BONK as if it had arrived as an `ok` launch. Positions stay in memory.
import { LaunchBot } from '../src/bot.js'
import { loadConfig } from '../src/core/config.js'
import { log } from '../src/log.js'
import { PositionStore } from '../src/positions.js'
import { loadSettings } from '../src/settings.js'

const BONK = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263'

const env = { ...process.env, DRY_RUN: 'true', BUY_SOL: process.env.BUY_SOL ?? '0.01' }
const config = loadConfig(env)
const bot = new LaunchBot(loadSettings(env, config), config, new PositionStore(null))

log('info', 'dry_run_check', { dexra: config.dexraBaseUrl, jupiter_quote: Boolean(config.jupiterApiKey) })
await bot.pollOnce()

const outcomes = await bot.handleLaunches(
  [{ mint: BONK, platform: 'manual', verdict: 'ok', token: { symbol: 'BONK' }, liquidity: { usd: 1e9 } }],
  'poll',
)
log('info', 'dry_run_done', { bonk: outcomes[0], open_positions: bot.store.open(bot.mode) })
await bot.checkExits()
if (bot.mode !== 'dry_run') throw new Error('expected a dry run')
