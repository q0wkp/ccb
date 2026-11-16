import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  configureCcbConfigProfile,
  getActiveCcbConfigMode,
  getCcbProfileDir,
  readPersistedCcbConfigMode,
  resetCcbConfigProfileForTesting,
} from '../ccbConfigProfile.js'

describe('CCB configuration profiles', () => {
  let root: string
  let officialDir: string
  let officialGlobal: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccb-profile-test-'))
    officialDir = join(root, 'official', '.claude')
    officialGlobal = join(root, 'official', '.claude.json')
    process.env.CCB_CONFIG_DIR = join(root, '.ccb')
    process.env.CCB_OFFICIAL_CONFIG_DIR = officialDir
    delete process.env.CLAUDE_CONFIG_DIR
    resetCcbConfigProfileForTesting()
  })

  afterEach(() => {
    delete process.env.CCB_CONFIG_DIR
    delete process.env.CCB_OFFICIAL_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    resetCcbConfigProfileForTesting()
    rmSync(root, { recursive: true, force: true })
  })

  test('defaults to compatible mode without creating files', () => {
    expect(readPersistedCcbConfigMode()).toBe('compatible')
    expect(getActiveCcbConfigMode()).toBe('compatible')
    expect(existsSync(process.env.CCB_CONFIG_DIR!)).toBe(false)
  })

  test('imports the complete official tree into an independent copy', () => {
    mkdirSync(join(officialDir, 'skills', 'review'), { recursive: true })
    mkdirSync(join(officialDir, 'plugins'), { recursive: true })
    writeFileSync(join(officialDir, 'settings.json'), '{"model":"opus"}\n')
    writeFileSync(join(officialDir, 'skills', 'review', 'SKILL.md'), 'review')
    writeFileSync(join(officialDir, 'plugins', 'installed.json'), '{"x":1}')
    writeFileSync(
      officialGlobal,
      '{"numStartups":3,"oauthAccount":{"accountUuid":"a"}}',
    )

    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'import',
      officialGlobalConfigFile: officialGlobal,
    })

    const isolated = getCcbProfileDir('isolated')
    expect(readFileSync(join(isolated, 'settings.json'), 'utf8')).toContain(
      'opus',
    )
    expect(
      readFileSync(join(isolated, 'skills', 'review', 'SKILL.md'), 'utf8'),
    ).toBe('review')
    expect(existsSync(join(isolated, 'plugins', 'installed.json'))).toBe(true)
    // The global config is imported, minus login identity (credentials are
    // never shared with official Claude Code).
    const importedGlobal = readFileSync(join(isolated, '.claude.json'), 'utf8')
    expect(importedGlobal).toContain('numStartups')
    expect(importedGlobal).not.toContain('oauthAccount')
    expect(readPersistedCcbConfigMode()).toBe('isolated')
  })

  test('sanitizes every global config file in the imported tree', () => {
    mkdirSync(officialDir, { recursive: true })
    writeFileSync(
      join(officialDir, '.claude.json'),
      '{"oauthAccount":{"id":"leak"},"numStartups":2}',
    )
    writeFileSync(
      join(officialDir, '.config.json'),
      '{"primaryApiKey":"legacy-secret","safe":true}',
    )
    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'import',
      officialGlobalConfigFile: officialGlobal,
    })
    const isolated = getCcbProfileDir('isolated')
    expect(readFileSync(join(isolated, '.claude.json'), 'utf8')).not.toContain(
      'leak',
    )
    expect(readFileSync(join(isolated, '.config.json'), 'utf8')).not.toContain(
      'legacy-secret',
    )
  })

  test('does not import credential files through renamed symlinks', () => {
    mkdirSync(officialDir, { recursive: true })
    writeFileSync(
      join(officialDir, '.credentials.json'),
      '{"refreshToken":"secret"}',
    )
    symlinkSync(
      join(officialDir, '.credentials.json'),
      join(officialDir, 'notes.json'),
    )
    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'import',
      officialGlobalConfigFile: officialGlobal,
    })
    expect(existsSync(join(getCcbProfileDir('isolated'), 'notes.json'))).toBe(
      false,
    )
  })

  test('backs up an old isolated profile before import replaces it', () => {
    const isolated = getCcbProfileDir('isolated')
    mkdirSync(isolated, { recursive: true })
    writeFileSync(join(isolated, 'old-marker'), 'old')
    mkdirSync(officialDir, { recursive: true })
    writeFileSync(join(officialDir, 'new-marker'), 'new')

    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'import',
      officialGlobalConfigFile: officialGlobal,
    })

    expect(existsSync(join(isolated, 'new-marker'))).toBe(true)
    const backups = readdirSync(join(process.env.CCB_CONFIG_DIR!, 'backups'))
    expect(backups).toHaveLength(1)
    expect(
      existsSync(
        join(process.env.CCB_CONFIG_DIR!, 'backups', backups[0]!, 'old-marker'),
      ),
    ).toBe(true)
  })

  test('creates a fresh profile without copying official user data', () => {
    mkdirSync(join(officialDir, 'skills'), { recursive: true })
    writeFileSync(join(officialDir, 'skills', 'private.md'), 'official')
    writeFileSync(officialGlobal, '{"oauthAccount":{"accountUuid":"a"}}')

    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'fresh',
      officialGlobalConfigFile: officialGlobal,
    })

    const isolated = getCcbProfileDir('isolated')
    expect(existsSync(join(isolated, 'skills'))).toBe(false)
    expect(readFileSync(join(isolated, '.claude.json'), 'utf8')).toBe('{}\n')
  })

  test('reuses an old isolated profile without modifying it', () => {
    const isolated = getCcbProfileDir('isolated')
    mkdirSync(isolated, { recursive: true })
    writeFileSync(join(isolated, 'marker'), 'keep')

    configureCcbConfigProfile({
      mode: 'isolated',
      isolatedInitialization: 'reuse',
      officialGlobalConfigFile: officialGlobal,
    })

    expect(readFileSync(join(isolated, 'marker'), 'utf8')).toBe('keep')
    expect(readPersistedCcbConfigMode()).toBe('isolated')
  })
})
