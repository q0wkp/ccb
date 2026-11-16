import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { resolveStateDirPath } from '../accounts.js'

const KEYS = [
  'WEIXIN_STATE_DIR',
  'CCB_ACTIVE_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR',
] as const

describe('resolveStateDirPath', () => {
  const saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const key of KEYS) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  const legacy = () => join(homedir(), '.claude', 'channels', 'weixin')

  test('defaults to ~/.claude/channels/weixin (existing logins stay found)', () => {
    expect(resolveStateDirPath()).toBe(legacy())
  })

  test('keeps the channels/weixin segment under the active CCB profile dir', () => {
    process.env.CCB_ACTIVE_CONFIG_DIR = '/tmp/ccb-profile'
    expect(resolveStateDirPath()).toBe(
      join('/tmp/ccb-profile', 'channels', 'weixin'),
    )
  })

  test('compatible mode (active dir = official ~/.claude) resolves to the legacy path', () => {
    process.env.CCB_ACTIVE_CONFIG_DIR = join(homedir(), '.claude')
    expect(resolveStateDirPath()).toBe(legacy())
  })

  test('an explicit CLAUDE_CONFIG_DIR never moved this location', () => {
    process.env.CLAUDE_CONFIG_DIR = '/tmp/explicit-claude'
    expect(resolveStateDirPath()).toBe(legacy())
  })

  test('WEIXIN_STATE_DIR still wins', () => {
    process.env.WEIXIN_STATE_DIR = '/tmp/weixin-state'
    process.env.CCB_ACTIVE_CONFIG_DIR = '/tmp/ccb-profile'
    expect(resolveStateDirPath()).toBe('/tmp/weixin-state')
  })
})
