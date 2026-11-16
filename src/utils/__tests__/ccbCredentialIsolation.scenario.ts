/**
 * Subprocess scenarios for ccbCredentialIsolation.test.ts.
 *
 * These exercise the real config.ts / settings.ts / secureStorage / managedEnv
 * stacks. They run in a fresh Bun process (NODE_ENV=production, so the
 * profile-selection freeze in ccbConfigProfile.ts is active) because:
 *  - other test files replace modules on that stack (envUtils, slowOperations,
 *    fsOperations, config) with process-global mock.module() stubs that would
 *    leak into an in-process run of the full suite;
 *  - the freeze is deliberately bypassed under NODE_ENV=test.
 * Not a test file itself (no `.test.` in the name).
 *
 * Usage: bun run ccbCredentialIsolation.scenario.ts <scenario>
 * The parent prepares CCB_CONFIG_DIR / CCB_OFFICIAL_CONFIG_DIR temp trees and
 * fixtures. A scenario asserts with node:assert (non-zero exit on failure) and
 * prints its result as a final `RESULT:<json>` stdout line.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  utimesSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { getOauthConfig } from '../../constants/oauth.js'
import { setOriginalCwd } from '../../bootstrap/state.js'
import {
  getCcbCredentialStorageDir,
  getCcbProfileDir,
  getCcbRootDir,
  getExplicitClaudeConfigDir,
  getOfficialClaudeConfigDir,
  isCcbProfileRoutingEnabled,
} from '../ccbConfigProfile.js'
import {
  _readEffectiveGlobalConfigForTesting,
  _setGlobalConfigCacheForTesting,
  enableConfigs,
  getGlobalConfig,
  saveGlobalConfig,
  type GlobalConfig,
} from '../config.js'
import { getGlobalClaudeFile, getOfficialGlobalClaudeFile } from '../env.js'
import { getClaudeConfigHomeDir } from '../envUtils.js'
import { applySafeConfigEnvironmentVariables } from '../managedEnv.js'
import { resetInvalidConfigFile } from '../resetInvalidConfig.js'
import {
  CREDENTIALS_SERVICE_SUFFIX,
  getMacOsKeychainStorageServiceName,
} from '../secureStorage/macOsKeychainHelpers.js'
import { plainTextStorage } from '../secureStorage/plainTextStorage.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import {
  getSettingsForSource,
  getSettingsWithErrors,
  updateSettingsForSource,
} from '../settings/settings.js'

const officialDir = process.env.CCB_OFFICIAL_CONFIG_DIR!
const officialCredentialsFile = join(officialDir, '.credentials.json')

function plaintextCompatible(): unknown {
  const officialBefore = readFileSync(officialCredentialsFile, 'utf8')
  const ccbFile = join(getCcbProfileDir('compatible'), '.credentials.json')

  // The shared data root is official, but credentials are not.
  assert.equal(getClaudeConfigHomeDir(), officialDir)
  assert.equal(getCcbCredentialStorageDir(), getCcbProfileDir('compatible'))

  // No CCB credentials yet: must not fall back to the official file.
  assert.equal(plainTextStorage.read(), null)

  const result = plainTextStorage.update({
    claudeAiOauth: {
      accessToken: 'ccb',
      refreshToken: 'ccb',
      expiresAt: 0,
      scopes: [],
      subscriptionType: null,
      rateLimitTier: null,
    },
  })
  assert.equal(result.success, true)
  assert.equal(existsSync(ccbFile), true)
  assert.equal(plainTextStorage.read()?.claudeAiOauth?.refreshToken, 'ccb')

  assert.equal(plainTextStorage.delete(), true)
  assert.equal(existsSync(ccbFile), false)
  assert.equal(readFileSync(officialCredentialsFile, 'utf8'), officialBefore)
  return { ok: true }
}

function plaintextIsolated(): unknown {
  const officialBefore = readFileSync(officialCredentialsFile, 'utf8')
  assert.equal(getCcbCredentialStorageDir(), getCcbProfileDir('isolated'))
  assert.equal(plainTextStorage.read(), null)
  assert.equal(
    plainTextStorage.update({ trustedDeviceToken: 'x' }).success,
    true,
  )
  assert.equal(
    existsSync(join(getCcbProfileDir('isolated'), '.credentials.json')),
    true,
  )
  assert.equal(readFileSync(officialCredentialsFile, 'utf8'), officialBefore)
  return { ok: true }
}

function globalConfigCompatible(): unknown {
  const officialGlobalFile = getOfficialGlobalClaudeFile()
  writeFileSync(
    officialGlobalFile,
    `${JSON.stringify(
      {
        numStartups: 5,
        installMethod: 'native',
        oauthAccount: { accountUuid: 'official', emailAddress: 'o@x' },
        primaryApiKey: 'sk-official',
        workspaceApiKey: 'sk-ant-api03-official',
        customApiKeyResponses: { approved: ['official'], rejected: [] },
        apiKeyHelper: 'echo official',
        env: {
          ANTHROPIC_API_KEY: 'OFFICIAL-envkey',
          OPENAI_API_KEY: 'OFFICIAL-openai',
          AWS_SECRET_ACCESS_KEY: 'OFFICIAL-aws',
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          ANTHROPIC_MODEL: 'some-model',
        },
        unknownOfficialField: { keep: true },
      },
      null,
      2,
    )}\n`,
  )
  const officialBefore = readFileSync(officialGlobalFile, 'utf8')
  enableConfigs()

  // Official identity, API keys, approvals, and secret env are not exposed;
  // non-secret env and everything else is.
  const inherited = _readEffectiveGlobalConfigForTesting()
  assert.equal(inherited.numStartups, 5)
  assert.deepEqual(
    (inherited as unknown as Record<string, unknown>).unknownOfficialField,
    { keep: true },
  )
  assert.equal(inherited.oauthAccount, undefined)
  assert.equal(inherited.primaryApiKey, undefined)
  assert.equal(inherited.workspaceApiKey, undefined)
  assert.equal(inherited.apiKeyHelper, undefined)
  assert.deepEqual(inherited.customApiKeyResponses, {
    approved: [],
    rejected: [],
  })
  assert.deepEqual(inherited.env, {
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_MODEL: 'some-model',
  })

  // CCB's own values persist to the overlay only.
  const overlayFile = getGlobalClaudeFile()
  assert.ok(overlayFile.startsWith(getCcbProfileDir('compatible')))
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: {
      accountUuid: 'ccb',
      emailAddress: 'c@x',
      organizationUuid: 'org',
    },
    primaryApiKey: 'sk-ccb',
    env: { ...current.env, OPENAI_API_KEY: 'ccb-openai-key' },
  }))
  const overlay = JSON.parse(readFileSync(overlayFile, 'utf8'))
  const overlayValues = overlay.overrides
  assert.equal(overlayValues.oauthAccount.accountUuid, 'ccb')
  assert.equal(overlayValues.primaryApiKey, 'sk-ccb')
  assert.equal(overlayValues.env.OPENAI_API_KEY, 'ccb-openai-key')
  assert.equal(overlayValues.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(overlayValues.numStartups, undefined)

  _setGlobalConfigCacheForTesting(null)
  const afterLogin = _readEffectiveGlobalConfigForTesting()
  assert.equal(afterLogin.oauthAccount?.accountUuid, 'ccb')
  assert.equal(afterLogin.primaryApiKey, 'sk-ccb')
  assert.equal(afterLogin.env.OPENAI_API_KEY, 'ccb-openai-key')

  // Logout-style removal clears only CCB's overlay values and never
  // resurrects the official identity.
  saveGlobalConfig(current => ({
    ...current,
    oauthAccount: undefined,
    primaryApiKey: undefined,
  }))
  const afterLogout = JSON.parse(readFileSync(overlayFile, 'utf8'))
  assert.equal(afterLogout.oauthAccount, undefined)
  assert.equal(afterLogout.primaryApiKey, undefined)
  _setGlobalConfigCacheForTesting(null)
  assert.equal(_readEffectiveGlobalConfigForTesting().oauthAccount, undefined)

  // Official file untouched; overlay backups stay out of ~/.claude.
  assert.equal(readFileSync(officialGlobalFile, 'utf8'), officialBefore)
  assert.equal(existsSync(join(officialDir, 'backups')), false)
  return { ok: true }
}

function compatibleOverlaySemantics(): unknown {
  const official = {
    numStartups: 5,
    projects: {
      '/a': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
      '/b': { allowedTools: ['Bash'] },
    },
  }
  writeFileSync(getOfficialGlobalClaudeFile(), JSON.stringify(official))
  _setGlobalConfigCacheForTesting(null)
  enableConfigs()
  saveGlobalConfig(current => {
    const projectA = {
      ...current.projects?.['/a'],
      allowedTools: ['Edit'],
    } as NonNullable<GlobalConfig['projects']>[string]
    delete projectA.hasTrustDialogAccepted
    return {
      ...current,
      numStartups: undefined,
      projects: {
        ...current.projects,
        '/a': projectA,
      },
    } as unknown as GlobalConfig
  })
  const overlayFile = getGlobalClaudeFile()
  const overlay = JSON.parse(readFileSync(overlayFile, 'utf8'))
  assert.equal(overlay.__ccbCompatibleOverlayV1, true)

  // An official update made after the CCB override should flow through for
  // untouched nested projects, while CCB's deleted key and changed project
  // fields remain masked/overridden.
  writeFileSync(
    getOfficialGlobalClaudeFile(),
    JSON.stringify({
      numStartups: 6,
      projects: {
        '/a': { allowedTools: ['Read'], hasTrustDialogAccepted: true },
        '/b': { allowedTools: ['Bash'], hasTrustDialogAccepted: true },
        '/c': { allowedTools: ['Read'] },
      },
    }),
  )
  _setGlobalConfigCacheForTesting(null)
  const effective = _readEffectiveGlobalConfigForTesting()
  assert.equal(effective.numStartups, undefined)
  assert.deepEqual(effective.projects?.['/a'], {
    allowedTools: ['Edit'],
  })
  assert.deepEqual(effective.projects?.['/b'], {
    allowedTools: ['Bash'],
    hasTrustDialogAccepted: true,
  })
  assert.deepEqual(effective.projects?.['/c'], { allowedTools: ['Read'] })
  return { ok: true }
}

function settingsCompatible(): unknown {
  const officialSettingsFile = join(officialDir, 'settings.json')
  const officialBefore = readFileSync(officialSettingsFile, 'utf8')

  const effective = getSettingsForSource('userSettings') as Record<
    string,
    unknown
  > & { env?: Record<string, string> }

  // Non-credential official settings are inherited ...
  assert.equal(effective.model, 'opus')
  // ... credential-producing keys are not, unless CCB's overlay sets them.
  assert.equal(effective.apiKeyHelper, 'echo ccb-helper')
  assert.equal(effective.awsAuthRefresh, undefined)
  assert.equal(effective.awsCredentialExport, undefined)
  assert.equal(effective.gcpAuthRefresh, undefined)
  assert.equal(effective.otelHeadersHelper, undefined)
  assert.equal(effective.braveApiKey, undefined)
  // Secret env is dropped from the official layer; non-secret env survives;
  // CCB's own overlay env (including secrets) applies.
  assert.deepEqual(effective.env, {
    ANTHROPIC_BASE_URL: 'https://gateway.example',
    ANTHROPIC_MODEL: 'opus-x',
    CLAUDE_CODE_USE_BEDROCK: '1',
    OPENAI_API_KEY: 'ccb-openai-key',
    CCB_ONLY: '1',
  })

  // Writing user settings touches only the overlay file.
  updateSettingsForSource('userSettings', { language: 'german' })
  resetSettingsCache()
  assert.equal(readFileSync(officialSettingsFile, 'utf8'), officialBefore)
  const overlay = JSON.parse(
    readFileSync(join(getCcbProfileDir('compatible'), 'settings.json'), 'utf8'),
  )
  assert.equal(overlay.language, 'german')
  assert.equal(overlay.apiKeyHelper, 'echo ccb-helper')
  assert.equal(overlay.awsAuthRefresh, undefined)
  assert.equal(overlay.env.ANTHROPIC_API_KEY, undefined)
  return { ok: true }
}

function projectSettingsInOfficialHome(): unknown {
  // Reproduce cwd=$HOME, where ~/.claude/settings*.json is otherwise treated
  // as project/local settings and bypasses the official-user filter.
  setOriginalCwd(join(officialDir, '..'))
  resetSettingsCache()
  const project = getSettingsForSource('projectSettings') as Record<
    string,
    unknown
  >
  const local = getSettingsForSource('localSettings') as Record<string, unknown>
  for (const settings of [project, local]) {
    assert.equal(settings.apiKeyHelper, undefined)
    assert.deepEqual(settings.env, { ANTHROPIC_MODEL: 'opus-x' })
  }
  const merged = getSettingsWithErrors().settings
  assert.equal(merged.apiKeyHelper, undefined)
  assert.equal(merged.env?.ANTHROPIC_API_KEY, undefined)
  return { project, local }
}

type NameSnapshot = {
  routing: boolean
  explicit: string | undefined
  keychainCredentials: string
  keychainLegacy: string
  credentialDir: string
  homeDir: string
  globalFile: string
  officialGlobalFile: string
  ccbRoot: string
}

function snapshotNames(): NameSnapshot {
  return {
    routing: isCcbProfileRoutingEnabled(),
    explicit: getExplicitClaudeConfigDir(),
    keychainCredentials: getMacOsKeychainStorageServiceName(
      CREDENTIALS_SERVICE_SUFFIX,
    ),
    keychainLegacy: getMacOsKeychainStorageServiceName(),
    credentialDir: getCcbCredentialStorageDir(),
    homeDir: getClaudeConfigHomeDir(),
    globalFile: getGlobalClaudeFile(),
    officialGlobalFile: getOfficialGlobalClaudeFile(),
    ccbRoot: getCcbRootDir(),
  }
}

function names(): unknown {
  const snapshot = snapshotNames()
  // Upstream formulas, re-derived from the raw env, for explicit-dir parity.
  const raw = process.env.CLAUDE_CONFIG_DIR
  const upstreamHome = (raw ?? join(homedir(), '.claude')).normalize('NFC')
  const upstreamName = (suffix: string) =>
    `Claude Code${getOauthConfig().OAUTH_FILE_SUFFIX}${suffix}${
      raw
        ? `-${createHash('sha256').update(upstreamHome).digest('hex').substring(0, 8)}`
        : ''
    }`
  return {
    snapshot,
    upstream: {
      keychainCredentials: upstreamName(CREDENTIALS_SERVICE_SUFFIX),
      keychainLegacy: upstreamName(''),
      credentialPath: join(upstreamHome, '.credentials.json'),
      homeDir: upstreamHome,
      globalFile: join(raw || homedir(), '.claude.json'),
    },
    credentialPath: join(snapshot.credentialDir, '.credentials.json'),
    cwd: process.cwd(),
  }
}

/**
 * Config-file `env` must never retarget the profile, and even a late change of
 * the real process env must not (frozen at first evaluation).
 */
function envFreeze(): unknown {
  enableConfigs()
  const before = snapshotNames()
  assert.equal(before.routing, true)
  assert.equal(plainTextStorage.read(), null)

  // The official files (inherited in compatible mode) try to switch the
  // profile and inject credentials; the parent put these in their `env`.
  applySafeConfigEnvironmentVariables()

  assert.equal(process.env.CLAUDE_CONFIG_DIR, undefined)
  assert.equal(process.env.CCB_ACTIVE_CONFIG_DIR, undefined)
  assert.equal(process.env.CCB_CONFIG_DIR, before.ccbRoot)
  assert.equal(process.env.CCB_OFFICIAL_CONFIG_DIR, officialDir)
  // Non-secret env still applies (inheritance works) ...
  assert.equal(process.env.ANTHROPIC_BASE_URL, 'https://gateway.example')
  // ... secrets from the official files do not.
  assert.equal(process.env.ANTHROPIC_API_KEY, undefined)
  assert.equal(process.env.OPENAI_API_KEY, undefined)
  assert.deepEqual(snapshotNames(), before)
  assert.equal(plainTextStorage.read(), null)

  // Defence in depth: other late writers cannot flip the frozen decision.
  process.env.CLAUDE_CONFIG_DIR = officialDir
  process.env.CCB_CONFIG_DIR = join(officialDir, 'elsewhere')
  process.env.CCB_OFFICIAL_CONFIG_DIR = join(officialDir, 'other')
  assert.deepEqual(snapshotNames(), before)
  assert.equal(plainTextStorage.read(), null)
  assert.equal(getOfficialClaudeConfigDir(), officialDir)
  return { ok: true }
}

function corruptOfficial(): unknown {
  const officialGlobalFile = getOfficialGlobalClaudeFile()
  const corrupted = '{"oauthAccount": {"accountUuid": "official", '
  writeFileSync(officialGlobalFile, corrupted)

  // enableConfigs reads the effective config with throwOnInvalid; a corrupt
  // OFFICIAL file must not raise (that would offer to reset it) ...
  enableConfigs()
  _setGlobalConfigCacheForTesting(null)
  assert.equal(getGlobalConfig().oauthAccount, undefined)
  saveGlobalConfig(current => ({ ...current, theme: 'light' }))

  // ... nor be rewritten, backed up, or restored.
  assert.equal(readFileSync(officialGlobalFile, 'utf8'), corrupted)
  assert.equal(existsSync(join(officialDir, 'backups')), false)
  const ccbBackups = join(getCcbProfileDir('compatible'), 'backups')
  const corruptedBackups = existsSync(ccbBackups)
    ? readdirSync(ccbBackups).filter(name => name.includes('.corrupted.'))
    : []
  assert.deepEqual(corruptedBackups, [])
  const overlay = JSON.parse(
    readFileSync(join(getCcbProfileDir('compatible'), '.claude.json'), 'utf8'),
  )
  assert.equal(overlay.overrides.theme, 'light')

  // The InvalidConfigDialog "reset" action refuses the official file but
  // still works for CCB's own overlay file.
  assert.equal(resetInvalidConfigFile(officialGlobalFile, {}), false)
  assert.equal(readFileSync(officialGlobalFile, 'utf8'), corrupted)
  const overlayFile = getGlobalClaudeFile()
  assert.equal(resetInvalidConfigFile(overlayFile, { reset: true }), true)
  assert.deepEqual(JSON.parse(readFileSync(overlayFile, 'utf8')), {
    reset: true,
  })
  return { ok: true }
}

async function watchOfficialConfig(): Promise<unknown> {
  writeFileSync(
    getOfficialGlobalClaudeFile(),
    JSON.stringify({ theme: 'dark' }),
  )
  enableConfigs()
  assert.equal(getGlobalConfig().theme, 'dark')
  writeFileSync(
    getOfficialGlobalClaudeFile(),
    JSON.stringify({ theme: 'light' }),
  )
  const later = new Date(Date.now() + 2000)
  utimesSync(getOfficialGlobalClaudeFile(), later, later)
  await new Promise(resolve => setTimeout(resolve, 2200))
  assert.equal(getGlobalConfig().theme, 'light')
  return { ok: true }
}

const scenarios: Record<string, () => unknown> = {
  'plaintext-compatible': plaintextCompatible,
  'plaintext-isolated': plaintextIsolated,
  'global-config-compatible': globalConfigCompatible,
  'compatible-overlay-semantics': compatibleOverlaySemantics,
  'settings-compatible': settingsCompatible,
  'project-settings-official-home': projectSettingsInOfficialHome,
  names,
  'env-freeze': envFreeze,
  'corrupt-official': corruptOfficial,
  'watch-official': watchOfficialConfig,
}

const scenario = scenarios[process.argv[2] ?? '']
if (!scenario) {
  process.stderr.write(`unknown scenario: ${process.argv[2]}\n`)
  process.exit(2)
}
process.stdout.write(`RESULT:${JSON.stringify((await scenario()) ?? null)}\n`)
process.exit(0)
