export type Level = 'info' | 'warn' | 'error'
export type Logger = (level: Level, event: string, fields?: Record<string, unknown>) => void

/** One JSON object per line on stdout, so logs can be piped into jq or a log shipper. */
export const log: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }, (_key, value) =>
    typeof value === 'bigint' ? value.toString() : value,
  )
  if (level === 'error') console.error(line)
  else console.log(line)
}

/** Drops log lines; handy in tests. */
export const silent: Logger = () => {}
