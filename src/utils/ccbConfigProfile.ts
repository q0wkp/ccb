import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'fs'
import { homedir } from 'os'
import { basename, dirname, join, relative, sep } from 'path'
import {
  classifyCcbOfficialFile,
  getCcbCredentialSanitizer,
  stripCcbCredentialGlobalConfig,
  stripCcbCredentialSettings,
} from './ccbCredentialDenylist.js'

export type CcbConfigMode = 'compatible' | 'isolated'
export type IsolatedProfileInitialization = 'reuse' | 'import' | 'fresh'

type CcbProfileControl = {
  version: 1
  mode: CcbConfigMode
}

const DEFAULT_MODE: CcbConfigMode = 'compatible'

// ── Frozen profile-selection environment ────────────────────────────────────
//
// Which profile a process uses must be decided once, from the REAL process
// environment at startup, and then never change: the `env` blocks of config
// files (which in compatible mode include the inherited official files) are
// applied into process.env later (managedEnv.ts), and a late CLAUDE_CONFIG_DIR
// would otherwise flip CCB from its own credential namespace onto an explicit
// directory — e.g. the official ~/.claude. Defence in depth with
// CCB_PROFILE_SELECTION_ENV_VARS, which managedEnv.ts refuses to apply.
//
// An empty value means "not set", as upstream treats it for the keychain
// service name and the global config file location.
//
// Tests mutate these variables between cases and share one process, so under
// `bun test` the values are read live. The test-runtime flag is captured at
// module load (before any config env can be applied) so later env changes
// cannot switch the freeze off.
const IS_TEST_RUNTIME = process.env.NODE_ENV === 'test'

type ProfileSelectionEnv = {
  explicitConfigDir: string | undefined
  ccbRootDir: string
  officialConfigDir: string
}

function readProfileSelectionEnv(): ProfileSelectionEnv {
  return {
    explicitConfigDir: process.env.CLAUDE_CONFIG_DIR || undefined,
    ccbRootDir: process.env.CCB_CONFIG_DIR || join(homedir(), '.ccb'),
    officialConfigDir:
      process.env.CCB_OFFICIAL_CONFIG_DIR || join(homedir(), '.claude'),
  }
}

let frozenProfileSelectionEnv: ProfileSelectionEnv | undefined

function getProfileSelectionEnv(): ProfileSelectionEnv {
  if (IS_TEST_RUNTIME) return readProfileSelectionEnv()
  frozenProfileSelectionEnv ??= readProfileSelectionEnv()
  return frozenProfileSelectionEnv
}

/**
 * Environment variables that select the profile. They may only come from the
 * real process environment: config-file `env` blocks must never set them.
 * CCB_ACTIVE_CONFIG_DIR is an output published for workspace packages.
 */
export const CCB_PROFILE_SELECTION_ENV_VARS: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CCB_CONFIG_DIR',
  'CCB_OFFICIAL_CONFIG_DIR',
  'CCB_ACTIVE_CONFIG_DIR',
])

export function isCcbProfileSelectionEnvVar(name: string): boolean {
  return CCB_PROFILE_SELECTION_ENV_VARS.has(name.toUpperCase())
}

/**
 * The explicit CLAUDE_CONFIG_DIR (non-empty), frozen at first evaluation.
 * undefined means CCB profile routing is active.
 */
export function getExplicitClaudeConfigDir(): string | undefined {
  return getProfileSelectionEnv().explicitConfigDir
}

/**
 * The selector deliberately lives outside either profile. Otherwise changing
 * profiles would also change the file used to decide which profile is active.
 */
export function getCcbRootDir(): string {
  return getProfileSelectionEnv().ccbRootDir
}

export function getCcbProfileControlPath(): string {
  return join(getCcbRootDir(), 'config.json')
}

export function getCcbProfileDir(mode: CcbConfigMode): string {
  return join(getCcbRootDir(), mode)
}

export function getCcbWritableConfigDir(): string {
  return (
    getExplicitClaudeConfigDir() ?? getCcbProfileDir(getActiveCcbConfigMode())
  )
}

export function getOfficialClaudeConfigDir(): string {
  return getProfileSelectionEnv().officialConfigDir
}

export function readPersistedCcbConfigMode(): CcbConfigMode {
  try {
    const parsed = JSON.parse(
      readFileSync(getCcbProfileControlPath(), 'utf8'),
    ) as Partial<CcbProfileControl>
    return parsed.version === 1 &&
      (parsed.mode === 'compatible' || parsed.mode === 'isolated')
      ? parsed.mode
      : DEFAULT_MODE
  } catch {
    return DEFAULT_MODE
  }
}

// A process must use one stable profile. Switching profiles is applied on the
// next launch so module-level caches cannot mix data from two profiles.
let activeMode: CcbConfigMode | undefined

export function getActiveCcbConfigMode(): CcbConfigMode {
  activeMode ??= readPersistedCcbConfigMode()
  return activeMode
}

export function resetCcbConfigProfileForTesting(): void {
  activeMode = undefined
  frozenProfileSelectionEnv = undefined
}

export function isCcbProfileRoutingEnabled(): boolean {
  // Preserve the upstream escape hatch exactly: an explicit
  // CLAUDE_CONFIG_DIR is already a fully independent configuration.
  return getExplicitClaudeConfigDir() === undefined
}

export function isCompatibleCcbConfigMode(): boolean {
  return (
    isCcbProfileRoutingEnabled() && getActiveCcbConfigMode() === 'compatible'
  )
}

// ── Credential isolation ─────────────────────────────────────────────────────
//
// CCB never shares login credentials with official Claude Code, in either
// mode: it must not read, write, refresh, or delete official credentials.
// Sharing is unsafe because OAuth refresh tokens rotate — when two clients
// hold the same refresh token, whichever refreshes first invalidates the
// other. Every credential store therefore resolves to a CCB-owned namespace
// (files under the active CCB profile dir, a CCB-specific keychain service).
//
// This module must stay lightweight (fs/os/path and the pure
// ccbCredentialDenylist.ts only): it is reached from
// secureStorage/macOsKeychainHelpers.ts, which keychainPrefetch.ts loads at
// the very top of startup.

/**
 * Directory holding credential files (`.credentials.json`, OAuth refresh
 * lock, CCB provider auth files) for the active profile:
 * - explicit CLAUDE_CONFIG_DIR: that directory (upstream behavior, identical
 *   to getClaudeConfigHomeDir());
 * - compatible: `~/.ccb/compatible` — NOT the shared official `~/.claude`;
 * - isolated: `~/.ccb/isolated`.
 */
export function getCcbCredentialStorageDir(): string {
  return getCcbWritableConfigDir().normalize('NFC')
}

/**
 * Files/directories at the top of the official `~/.claude` tree that an
 * isolated import must not copy:
 * - .credentials.json: OAuth tokens, MCP OAuth tokens, plugin secrets.
 * - openai-chatgpt-auth.json: CCB ChatGPT OAuth tokens (rotating refresh).
 * - backups: timestamped copies of the global config, which contain the
 *   identity/API-key fields stripped by ccbCredentialDenylist.ts.
 * Keychain entries are never copied.
 */
const ISOLATED_IMPORT_EXCLUDED_ENTRIES = new Set([
  '.credentials.json',
  'openai-chatgpt-auth.json',
  'backups',
])

function writeControl(mode: CcbConfigMode): void {
  const path = getCcbProfileControlPath()
  mkdirSync(dirname(path), { recursive: true })
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`
  const control: CcbProfileControl = { version: 1, mode }
  writeFileSync(temporaryPath, `${JSON.stringify(control, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  renameSync(temporaryPath, path)
}

function createProfileBackup(profileDir: string): string | null {
  if (!existsSync(profileDir)) return null
  const backupDir = join(
    getCcbRootDir(),
    'backups',
    `${basename(profileDir)}-${Date.now()}`,
  )
  mkdirSync(dirname(backupDir), { recursive: true })
  renameSync(profileDir, backupDir)
  return backupDir
}

function replaceIsolatedProfile(stagedDir: string): void {
  const isolatedDir = getCcbProfileDir('isolated')
  const backupDir = createProfileBackup(isolatedDir)
  try {
    renameSync(stagedDir, isolatedDir)
  } catch (error) {
    if (backupDir && !existsSync(isolatedDir)) {
      renameSync(backupDir, isolatedDir)
    }
    throw error
  }
}

function createStagingDir(kind: 'import' | 'fresh'): string {
  const root = getCcbRootDir()
  mkdirSync(root, { recursive: true })
  const stagingDir = join(
    root,
    `.isolated-${kind}-${process.pid}-${Date.now()}.tmp`,
  )
  rmSync(stagingDir, { recursive: true, force: true })
  mkdirSync(stagingDir, { recursive: true, mode: 0o700 })
  return stagingDir
}

/**
 * Copy an official JSON config file with credential-producing configuration
 * removed (`sanitize`). Missing files are skipped. A file that is not a JSON
 * object is not copied at all: its raw contents may hold secrets we cannot
 * filter (an empty file is harmless and copied as-is).
 */
function copySanitizedJsonFile(
  source: string,
  destination: string,
  sanitize: (parsed: object) => object,
): void {
  if (!existsSync(source)) return
  const raw = readFileSync(source, 'utf8').replace(/^\uFEFF/, '')
  if (raw.trim() === '') {
    writeFileSync(destination, raw, { encoding: 'utf8', mode: 0o600 })
    return
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return
  }
  writeFileSync(destination, `${JSON.stringify(sanitize(parsed), null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
}

/**
 * Symlinks inside the official tree are DEREFERENCED during import (their
 * targets are copied as real files/directories). Preserving them would make
 * the isolated profile write through into the official tree or the user's
 * dotfiles repository — the opposite of "diverge independently". Dangling
 * links and links that point back to one of their own ancestors (which would
 * recurse forever) are skipped instead of failing the whole import.
 */
function shouldCopyImportEntry(source: string): boolean {
  try {
    if (!lstatSync(source).isSymbolicLink()) return true
    const target = realpathSync(source)
    const parent = realpathSync(dirname(source))
    return !(parent === target || parent.startsWith(`${target}${sep}`))
  } catch {
    return false
  }
}

function importOfficialProfile(officialGlobalConfigFile: string): void {
  const stagingDir = createStagingDir('import')
  try {
    // A symlinked ~/.claude (dotfiles setups) must be resolved first:
    // cpSync refuses to copy a symlink-to-directory onto a directory.
    let officialDir: string | undefined
    try {
      officialDir = realpathSync(getOfficialClaudeConfigDir())
    } catch {
      officialDir = undefined // missing or dangling: nothing to copy
    }
    if (officialDir !== undefined) {
      const root = officialDir
      // Copy the complete user data tree: skills, agents, plugins, commands,
      // sessions, caches, and any future upstream additions — except
      // credentials (ISOLATED_IMPORT_EXCLUDED_ENTRIES) and the JSON config
      // files copied below in sanitized form. Copying rotating refresh
      // tokens would make two clients hold one token, and whichever
      // refreshes first would invalidate the other.
      cpSync(root, stagingDir, {
        recursive: true,
        force: true,
        preserveTimestamps: true,
        dereference: true,
        filter: (source, destination) => {
          const resolvedSource = (() => {
            try {
              return realpathSync(source)
            } catch {
              return source
            }
          })()
          const sourceName = basename(source)
          const targetName = basename(resolvedSource)
          if (resolvedSource.split(sep).includes('backups')) return false
          // Links into excluded credential files must not smuggle their contents
          // into the imported profile. Config files are copied via sanitizers.
          const sourceKind = classifyCcbOfficialFile(sourceName)
          const targetKind = classifyCcbOfficialFile(targetName)
          if (sourceKind === 'credential' || targetKind === 'credential')
            return false
          if (sourceKind || targetKind) {
            // Sanitize config files at any depth; aliases targeting config
            // files are skipped rather than copying credential-bearing bytes.
            if (lstatSync(source).isSymbolicLink()) return false
            const kind = sourceKind ?? targetKind
            if (kind) {
              mkdirSync(dirname(destination), { recursive: true })
              copySanitizedJsonFile(
                source,
                destination,
                getCcbCredentialSanitizer(kind),
              )
            }
            return false
          }
          const topLevel = relative(root, source).split(sep)[0] ?? ''
          return (
            !ISOLATED_IMPORT_EXCLUDED_ENTRIES.has(topLevel) &&
            !classifyCcbOfficialFile(topLevel) &&
            shouldCopyImportEntry(source)
          )
        },
      })
      for (const name of readdirSync(root)) {
        const kind = classifyCcbOfficialFile(name)
        if (!kind || kind === 'credential') continue
        const target = realpathSync(join(root, name))
        if (
          target.split(sep).includes('backups') ||
          classifyCcbOfficialFile(basename(target)) === 'credential'
        )
          continue
        copySanitizedJsonFile(
          join(root, name),
          join(stagingDir, name),
          getCcbCredentialSanitizer(kind),
        )
      }
    }
    copySanitizedJsonFile(
      officialGlobalConfigFile,
      join(stagingDir, basename(officialGlobalConfigFile)),
      stripCcbCredentialGlobalConfig,
    )
    replaceIsolatedProfile(stagingDir)
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

function createFreshIsolatedProfile(officialGlobalConfigFile: string): void {
  const stagingDir = createStagingDir('fresh')
  try {
    writeFileSync(
      join(stagingDir, basename(officialGlobalConfigFile)),
      '{}\n',
      { encoding: 'utf8', mode: 0o600 },
    )
    replaceIsolatedProfile(stagingDir)
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true })
    throw error
  }
}

export function configureCcbConfigProfile(options: {
  mode: CcbConfigMode
  isolatedInitialization?: IsolatedProfileInitialization
  officialGlobalConfigFile: string
}): void {
  if (options.mode === 'isolated') {
    const initialization = options.isolatedInitialization ?? 'reuse'
    if (initialization === 'import') {
      importOfficialProfile(options.officialGlobalConfigFile)
    } else if (initialization === 'fresh') {
      createFreshIsolatedProfile(options.officialGlobalConfigFile)
    }
  }
  writeControl(options.mode)
}
