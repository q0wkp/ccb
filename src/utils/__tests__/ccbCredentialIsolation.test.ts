import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  configureCcbConfigProfile,
  getCcbProfileDir,
  resetCcbConfigProfileForTesting,
} from '../ccbConfigProfile.js'
import { CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS } from '../ccbCredentialDenylist.js'

type ScenarioResult = { result: unknown; stderr: string }

/**
 * Run a scenario from ccbCredentialIsolation.scenario.ts in a fresh Bun
 * process with NODE_ENV=production (profile-selection freeze active). The real
 * config / settings / secureStorage / managedEnv stacks must be used, and
 * other test files install process-global mock.module() stubs for parts of
 * them (envUtils, slowOperations, fsOperations, config) that would otherwise
 * leak into this file during a full `bun test` run.
 */
function runScenario(
  name: string,
  envOverrides: Record<string, string | undefined> = {},
): ScenarioResult {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries({
    ...process.env,
    NODE_ENV: 'production',
    ...envOverrides,
  })) {
    if (value !== undefined) env[key] = value
  }
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      'run',
      join(import.meta.dir, 'ccbCredentialIsolation.scenario.ts'),
      name,
    ],
    cwd: join(import.meta.dir, '..', '..', '..'),
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) {
    throw new Error(
      `scenario ${name} failed (exit ${result.exitCode}):\n${stdout}${stderr}`,
    )
  }
  const line = stdout.split('\n').find(l => l.startsWith('RESULT:'))
  if (line === undefined) throw new Error(`no RESULT from ${name}:\n${stdout}`)
  return { result: JSON.parse(line.slice('RESULT:'.length)), stderr }
}

type Names = {
  snapshot: {
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
  upstream: {
    keychainCredentials: string
    keychainLegacy: string
    credentialPath: string
    homeDir: string
    globalFile: string
  }
  credentialPath: string
  cwd: string
}

const OFFICIAL_CREDENTIALS = '{"claudeAiOauth":{"refreshToken":"official"}}'

describe('CCB credential isolation', () => {
  let root: string
  let officialDir: string
  let officialGlobal: string

  function setMode(mode: 'compatible' | 'isolated'): void {
    const control = join(process.env.CCB_CONFIG_DIR!, 'config.json')
    mkdirSync(dirname(control), { recursive: true })
    writeFileSync(control, JSON.stringify({ version: 1, mode }))
    resetCcbConfigProfileForTesting()
  }

  function childEnv(
    extra: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      CCB_CONFIG_DIR: process.env.CCB_CONFIG_DIR,
      CCB_OFFICIAL_CONFIG_DIR: officialDir,
      CLAUDE_CONFIG_DIR: undefined,
      ...extra,
    }
  }

  function names(extra: Record<string, string | undefined> = {}): Names {
    return runScenario('names', childEnv(extra)).result as Names
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'ccb-credential-test-'))
    officialDir = join(root, 'official', '.claude')
    officialGlobal = join(root, 'official', '.claude.json')
    mkdirSync(officialDir, { recursive: true })
    writeFileSync(join(officialDir, '.credentials.json'), OFFICIAL_CREDENTIALS)
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

  describe('keychain service names and routing (subprocess)', () => {
    test('official, compatible, and isolated names are all distinct and stable', () => {
      setMode('compatible')
      const compatible = names()
      expect(names().snapshot).toEqual(compatible.snapshot) // stable
      setMode('isolated')
      const isolated = names()

      // The unsuffixed upstream names are the official keychain entries.
      const officialCredentials = compatible.upstream.keychainCredentials
      const officialLegacy = compatible.upstream.keychainLegacy
      const all = [
        officialCredentials,
        officialLegacy,
        compatible.snapshot.keychainCredentials,
        compatible.snapshot.keychainLegacy,
        isolated.snapshot.keychainCredentials,
        isolated.snapshot.keychainLegacy,
      ]
      expect(new Set(all).size).toBe(all.length)
      expect(compatible.snapshot.keychainCredentials).toStartWith(
        `${officialCredentials}-ccb-`,
      )
      expect(isolated.snapshot.keychainCredentials).toStartWith(
        `${officialCredentials}-ccb-`,
      )
      expect(compatible.snapshot.routing).toBe(true)
      expect(isolated.snapshot.credentialDir).toBe(getCcbProfileDir('isolated'))
    })

    test.each([
      ['plain', (r: string) => join(r, 'explicit')],
      ['trailing slash', (r: string) => `${join(r, 'explicit')}/`],
      ['NFD unicode', (r: string) => join(r, 'caf\u0065\u0301-dir')],
    ])('explicit CLAUDE_CONFIG_DIR (%s) equals the upstream formulas', (_label, dirFor) => {
      const explicit = dirFor(root)
      const { snapshot, upstream, credentialPath } = names({
        CLAUDE_CONFIG_DIR: explicit,
      })
      expect(snapshot.routing).toBe(false)
      expect(snapshot.explicit).toBe(explicit)
      expect(snapshot.keychainCredentials).toBe(upstream.keychainCredentials)
      expect(snapshot.keychainLegacy).toBe(upstream.keychainLegacy)
      expect(snapshot.keychainCredentials).toMatch(/-[0-9a-f]{8}$/)
      expect(snapshot.keychainCredentials).not.toContain('-ccb-')
      expect(snapshot.homeDir).toBe(upstream.homeDir)
      expect(credentialPath).toBe(upstream.credentialPath)
      expect(snapshot.globalFile).toBe(upstream.globalFile)
    })

    test('empty CLAUDE_CONFIG_DIR means "not set": routing stays enabled', () => {
      setMode('compatible')
      const { snapshot, cwd } = names({ CLAUDE_CONFIG_DIR: '' })
      expect(snapshot.routing).toBe(true)
      expect(snapshot.explicit).toBeUndefined()
      // CCB keychain namespace, never the official entry
      expect(snapshot.keychainCredentials).toMatch(
        /-credentials-ccb-[0-9a-f]{8}$/,
      )
      expect(snapshot.keychainLegacy).toMatch(/-ccb-[0-9a-f]{8}$/)
      expect(snapshot.credentialDir).toBe(getCcbProfileDir('compatible'))
      // Never cwd-relative (join('', '.claude.json') would be ./.claude.json)
      expect(snapshot.homeDir).toBe(officialDir)
      expect(snapshot.globalFile).toBe(
        join(getCcbProfileDir('compatible'), '.claude.json'),
      )
      expect(snapshot.globalFile.startsWith(cwd)).toBe(false)
      expect(snapshot.officialGlobalFile).toBe(officialGlobal)
      // Same routing as when the variable is absent altogether.
      expect(snapshot).toEqual(names().snapshot)
    })
  })

  describe('plaintext credential storage (subprocess)', () => {
    test('compatible mode stores under ~/.ccb/compatible and never touches official', () => {
      setMode('compatible')
      runScenario('plaintext-compatible', childEnv())
      expect(readFileSync(join(officialDir, '.credentials.json'), 'utf8')).toBe(
        OFFICIAL_CREDENTIALS,
      )
    })

    test('isolated mode stores under ~/.ccb/isolated', () => {
      setMode('isolated')
      runScenario('plaintext-isolated', childEnv())
      expect(
        existsSync(join(getCcbProfileDir('isolated'), '.credentials.json')),
      ).toBe(true)
    })
  })

  describe('compatible global config (subprocess)', () => {
    test('hides official identity and secret env, persists CCB values to the overlay only', () => {
      setMode('compatible')
      runScenario('global-config-compatible', childEnv())
      expect(
        existsSync(join(getCcbProfileDir('compatible'), '.claude.json')),
      ).toBe(true)
    })

    test('a corrupt official global config is never written, backed up, or reset', () => {
      setMode('compatible')
      const { stderr } = runScenario('corrupt-official', childEnv())
      // Warned exactly once even though the invalid file is re-read on every
      // read and save (it stays invalid: CCB never repairs it).
      expect(
        stderr.match(/CCB ignores it and never modifies or backs it up/g),
      ).toHaveLength(1)
      expect(existsSync(join(officialDir, 'backups'))).toBe(false)
    })

    test('observes changes to the read-only official global file', () => {
      setMode('compatible')
      expect(runScenario('watch-official', childEnv()).result).toEqual({
        ok: true,
      })
    })

    test('overlay masks deleted official keys and preserves untouched nested updates', () => {
      setMode('compatible')
      expect(
        runScenario('compatible-overlay-semantics', childEnv()).result,
      ).toEqual({
        ok: true,
      })
    })
  })

  describe('compatible user settings (subprocess)', () => {
    test('official credential-producing settings and secret env are not inherited; overlay values apply', () => {
      setMode('compatible')
      const officialSettings = {
        model: 'opus',
        apiKeyHelper: 'echo OFFICIAL-helper',
        awsAuthRefresh: 'aws sso login',
        awsCredentialExport: 'echo creds',
        gcpAuthRefresh: 'gcloud auth login',
        otelHeadersHelper: 'echo headers',
        braveApiKey: 'OFFICIAL-brave',
        env: {
          ANTHROPIC_API_KEY: 'OFFICIAL-key',
          ANTHROPIC_AUTH_TOKEN: 'OFFICIAL-token',
          OPENAI_API_KEY: 'OFFICIAL-openai',
          AWS_SECRET_ACCESS_KEY: 'OFFICIAL-aws',
          MYPROVIDER_API_KEY: 'OFFICIAL-custom-provider',
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          ANTHROPIC_MODEL: 'opus-x',
          CLAUDE_CODE_USE_BEDROCK: '1',
        },
      }
      writeFileSync(
        join(officialDir, 'settings.json'),
        JSON.stringify(officialSettings, null, 2),
      )
      const overlayDir = getCcbProfileDir('compatible')
      mkdirSync(overlayDir, { recursive: true })
      writeFileSync(
        join(overlayDir, 'settings.json'),
        JSON.stringify({
          apiKeyHelper: 'echo ccb-helper',
          env: { OPENAI_API_KEY: 'ccb-openai-key', CCB_ONLY: '1' },
        }),
      )
      runScenario('settings-compatible', childEnv())
    })
  })

  describe('official settings loaded as project/local settings (subprocess)', () => {
    test('credential settings are stripped in compatible and isolated modes', () => {
      const content = JSON.stringify({
        apiKeyHelper: 'echo official-secret',
        env: {
          ANTHROPIC_API_KEY: 'official-key',
          ANTHROPIC_MODEL: 'opus-x',
        },
      })
      writeFileSync(join(officialDir, 'settings.json'), content)
      writeFileSync(join(officialDir, 'settings.local.json'), content)
      for (const mode of ['compatible', 'isolated'] as const) {
        setMode(mode)
        expect(
          runScenario('project-settings-official-home', childEnv()).result,
        ).toEqual({
          project: { env: { ANTHROPIC_MODEL: 'opus-x' } },
          local: { env: { ANTHROPIC_MODEL: 'opus-x' } },
        })
      }
    })
  })

  describe('profile selection from config env (subprocess)', () => {
    test('inherited official env cannot switch back to official credentials', () => {
      setMode('compatible')
      // Official settings.json / .claude.json `env` try to retarget the
      // profile at the official dir (where tokens exist) and inject keys.
      writeFileSync(
        join(officialDir, 'settings.json'),
        JSON.stringify({
          env: {
            CLAUDE_CONFIG_DIR: officialDir,
            CCB_CONFIG_DIR: join(root, 'hijacked-ccb'),
            CCB_OFFICIAL_CONFIG_DIR: join(root, 'hijacked-official'),
            CCB_ACTIVE_CONFIG_DIR: join(root, 'hijacked-active'),
            ANTHROPIC_API_KEY: 'OFFICIAL-key',
            OPENAI_API_KEY: 'OFFICIAL-openai',
            ANTHROPIC_BASE_URL: 'https://gateway.example',
          },
        }),
      )
      writeFileSync(
        officialGlobal,
        JSON.stringify({
          env: { CLAUDE_CONFIG_DIR: '', ANTHROPIC_API_KEY: 'OFFICIAL-envkey' },
        }),
      )
      runScenario('env-freeze', childEnv())
      expect(readFileSync(join(officialDir, '.credentials.json'), 'utf8')).toBe(
        OFFICIAL_CREDENTIALS,
      )
    })
  })

  describe('isolated import', () => {
    test('excludes credentials and strips identity fields, copies the rest', () => {
      mkdirSync(join(officialDir, 'skills', 'review'), { recursive: true })
      mkdirSync(join(officialDir, 'backups'), { recursive: true })
      writeFileSync(join(officialDir, 'skills', 'review', 'SKILL.md'), 'review')
      writeFileSync(join(officialDir, 'settings.json'), '{"model":"opus"}')
      writeFileSync(join(officialDir, 'openai-chatgpt-auth.json'), '{}')
      writeFileSync(
        join(officialDir, 'backups', '.claude.json.backup.1'),
        '{"primaryApiKey":"sk-official"}',
      )
      const officialGlobalContent = JSON.stringify({
        numStartups: 7,
        oauthAccount: { accountUuid: 'official' },
        primaryApiKey: 'sk-official',
        workspaceApiKey: 'sk-ant-api03-official',
        customApiKeyResponses: { approved: ['official'], rejected: [] },
        apiKeyHelper: 'echo official',
        projects: { '/repo': { allowedTools: [] } },
      })
      writeFileSync(officialGlobal, officialGlobalContent)

      configureCcbConfigProfile({
        mode: 'isolated',
        isolatedInitialization: 'import',
        officialGlobalConfigFile: officialGlobal,
      })

      const isolated = getCcbProfileDir('isolated')
      expect(existsSync(join(isolated, '.credentials.json'))).toBe(false)
      expect(existsSync(join(isolated, 'openai-chatgpt-auth.json'))).toBe(false)
      expect(existsSync(join(isolated, 'backups'))).toBe(false)
      expect(
        readFileSync(join(isolated, 'skills', 'review', 'SKILL.md'), 'utf8'),
      ).toBe('review')
      expect(readFileSync(join(isolated, 'settings.json'), 'utf8')).toContain(
        'opus',
      )

      const imported = JSON.parse(
        readFileSync(join(isolated, '.claude.json'), 'utf8'),
      )
      for (const key of CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS) {
        expect(imported[key]).toBeUndefined()
      }
      expect(imported.numStartups).toBe(7)
      expect(imported.projects).toEqual({ '/repo': { allowedTools: [] } })

      // Official files are untouched.
      expect(readFileSync(officialGlobal, 'utf8')).toBe(officialGlobalContent)
      expect(readFileSync(join(officialDir, '.credentials.json'), 'utf8')).toBe(
        OFFICIAL_CREDENTIALS,
      )
    })

    test('strips credential-producing settings and secret env from settings and global config', () => {
      const settings = {
        model: 'opus',
        apiKeyHelper: 'echo OFFICIAL-helper',
        awsAuthRefresh: 'aws sso login',
        awsCredentialExport: 'echo creds',
        gcpAuthRefresh: 'gcloud auth login',
        otelHeadersHelper: 'echo headers',
        workspaceApiKey: 'sk-ant-api03-official',
        braveApiKey: 'OFFICIAL-brave',
        exaApiKey: 'OFFICIAL-exa',
        env: {
          ANTHROPIC_API_KEY: 'OFFICIAL-key',
          CLAUDE_CODE_OAUTH_TOKEN: 'OFFICIAL-oauth',
          AWS_ACCESS_KEY_ID: 'OFFICIAL-aws-id',
          MYPROVIDER_API_KEY: 'OFFICIAL-custom',
          ANTHROPIC_BASE_URL: 'https://gateway.example',
          ANTHROPIC_MODEL: 'opus-x',
        },
      }
      writeFileSync(
        join(officialDir, 'settings.json'),
        JSON.stringify(settings),
      )
      writeFileSync(
        join(officialDir, 'cowork_settings.json'),
        JSON.stringify(settings),
      )
      writeFileSync(
        officialGlobal,
        JSON.stringify({
          numStartups: 1,
          env: {
            OPENAI_API_KEY: 'OFFICIAL-openai',
            OPENAI_BASE_URL: 'https://openai.example',
          },
        }),
      )

      configureCcbConfigProfile({
        mode: 'isolated',
        isolatedInitialization: 'import',
        officialGlobalConfigFile: officialGlobal,
      })

      const isolated = getCcbProfileDir('isolated')
      for (const file of ['settings.json', 'cowork_settings.json']) {
        const imported = JSON.parse(readFileSync(join(isolated, file), 'utf8'))
        expect(imported).toEqual({
          model: 'opus',
          env: {
            ANTHROPIC_BASE_URL: 'https://gateway.example',
            ANTHROPIC_MODEL: 'opus-x',
          },
        })
      }
      expect(
        JSON.parse(readFileSync(join(isolated, '.claude.json'), 'utf8')),
      ).toEqual({
        numStartups: 1,
        env: { OPENAI_BASE_URL: 'https://openai.example' },
      })
      // The official settings file is untouched.
      expect(
        JSON.parse(readFileSync(join(officialDir, 'settings.json'), 'utf8')),
      ).toEqual(settings)
    })

    test('does not copy a settings file it cannot parse (it may hold secrets)', () => {
      writeFileSync(
        join(officialDir, 'settings.json'),
        '{"env": {"ANTHROPIC_API_KEY": "OFFICIAL-key"',
      )
      configureCcbConfigProfile({
        mode: 'isolated',
        isolatedInitialization: 'import',
        officialGlobalConfigFile: officialGlobal,
      })
      expect(
        existsSync(join(getCcbProfileDir('isolated'), 'settings.json')),
      ).toBe(false)
    })

    test('strips identity fields from a legacy .config.json in the tree', () => {
      const legacy = join(officialDir, '.config.json')
      writeFileSync(
        legacy,
        JSON.stringify({
          numStartups: 1,
          oauthAccount: { accountUuid: 'o' },
          env: { ANTHROPIC_API_KEY: 'OFFICIAL-key', FOO: 'bar' },
        }),
      )
      configureCcbConfigProfile({
        mode: 'isolated',
        isolatedInitialization: 'import',
        officialGlobalConfigFile: officialGlobal,
      })
      const imported = JSON.parse(
        readFileSync(
          join(getCcbProfileDir('isolated'), '.config.json'),
          'utf8',
        ),
      )
      expect(imported.oauthAccount).toBeUndefined()
      expect(imported.numStartups).toBe(1)
      expect(imported.env).toEqual({ FOO: 'bar' })
    })

    describe('symlinked official tree', () => {
      test('imports a symlinked ~/.claude (dotfiles setup) and leaves the real tree untouched', () => {
        const realDir = join(root, 'dotfiles', 'claude')
        mkdirSync(join(realDir, 'skills', 'review'), { recursive: true })
        writeFileSync(join(realDir, 'skills', 'review', 'SKILL.md'), 'review')
        writeFileSync(join(realDir, '.credentials.json'), OFFICIAL_CREDENTIALS)
        writeFileSync(
          join(realDir, 'settings.json'),
          '{"model":"opus","apiKeyHelper":"echo x"}',
        )
        rmSync(officialDir, { recursive: true, force: true })
        symlinkSync(realDir, officialDir, 'dir')
        expect(lstatSync(officialDir).isSymbolicLink()).toBe(true)

        configureCcbConfigProfile({
          mode: 'isolated',
          isolatedInitialization: 'import',
          officialGlobalConfigFile: officialGlobal,
        })

        const isolated = getCcbProfileDir('isolated')
        expect(
          readFileSync(join(isolated, 'skills', 'review', 'SKILL.md'), 'utf8'),
        ).toBe('review')
        expect(existsSync(join(isolated, '.credentials.json'))).toBe(false)
        expect(
          JSON.parse(readFileSync(join(isolated, 'settings.json'), 'utf8')),
        ).toEqual({ model: 'opus' })
        expect(readFileSync(join(realDir, '.credentials.json'), 'utf8')).toBe(
          OFFICIAL_CREDENTIALS,
        )
        // No staging directory is left behind.
        expect(
          readdirSync(process.env.CCB_CONFIG_DIR!).filter(n =>
            n.endsWith('.tmp'),
          ),
        ).toEqual([])
      })

      test('dereferences nested symlinks so the isolated copy is independent; skips dangling and cyclic links', () => {
        const external = join(root, 'dotfiles')
        mkdirSync(join(external, 'shared-skills'), { recursive: true })
        writeFileSync(join(external, 'shared-skills', 'a.md'), 'skill-a')
        writeFileSync(join(external, 'notes.md'), 'notes')
        symlinkSync(
          join(external, 'shared-skills'),
          join(officialDir, 'skills'),
        )
        symlinkSync(join(external, 'notes.md'), join(officialDir, 'notes.md'))
        symlinkSync(join(root, 'does-not-exist'), join(officialDir, 'dangling'))
        mkdirSync(join(officialDir, 'sub'), { recursive: true })
        symlinkSync(officialDir, join(officialDir, 'sub', 'loop'), 'dir')

        configureCcbConfigProfile({
          mode: 'isolated',
          isolatedInitialization: 'import',
          officialGlobalConfigFile: officialGlobal,
        })

        const isolated = getCcbProfileDir('isolated')
        expect(lstatSync(join(isolated, 'skills')).isSymbolicLink()).toBe(false)
        expect(readFileSync(join(isolated, 'skills', 'a.md'), 'utf8')).toBe(
          'skill-a',
        )
        expect(lstatSync(join(isolated, 'notes.md')).isSymbolicLink()).toBe(
          false,
        )
        expect(existsSync(join(isolated, 'dangling'))).toBe(false)
        expect(existsSync(join(isolated, 'sub', 'loop'))).toBe(false)

        // Writing into the isolated copy cannot write through to the source.
        writeFileSync(join(isolated, 'notes.md'), 'changed')
        expect(readFileSync(join(external, 'notes.md'), 'utf8')).toBe('notes')
      })
    })
  })
})
