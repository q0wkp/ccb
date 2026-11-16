import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

export interface AccountData {
  token: string
  baseUrl: string
  userId?: string
  savedAt: string
}

/**
 * Where Weixin state (account.json with the bot token, cursor, access lists)
 * lives, without touching the filesystem:
 * 1. WEIXIN_STATE_DIR when set;
 * 2. `<active CCB profile dir>/channels/weixin` — CCB_ACTIVE_CONFIG_DIR is
 *    published by the CLI entrypoint only while CCB profile routing is
 *    active: ~/.claude in compatible mode (where existing logins already
 *    live), ~/.ccb/isolated in isolated mode;
 * 3. otherwise `~/.claude/channels/weixin`, exactly as before CCB profiles —
 *    including when an explicit CLAUDE_CONFIG_DIR is set, which never
 *    influenced this location.
 */
export function resolveStateDirPath(): string {
  const activeProfileDir = process.env.CCB_ACTIVE_CONFIG_DIR
  return (
    process.env.WEIXIN_STATE_DIR ||
    (activeProfileDir
      ? join(activeProfileDir, 'channels', 'weixin')
      : join(homedir(), '.claude', 'channels', 'weixin'))
  )
}

export function getStateDir(): string {
  const dir = resolveStateDirPath()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function accountPath(): string {
  return join(getStateDir(), 'account.json')
}

export function loadAccount(): AccountData | null {
  const path = accountPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccountData
  } catch {
    return null
  }
}

export function saveAccount(data: AccountData): void {
  const path = accountPath()
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  chmodSync(path, 0o600)
}

export function clearAccount(): void {
  const path = accountPath()
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
