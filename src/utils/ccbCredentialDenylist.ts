/**
 * Single source of truth for "credential-producing configuration" that CCB
 * must not inherit from official Claude Code.
 *
 * Policy (user decision): CCB never shares login credentials with official
 * Claude Code, in either profile mode. Besides the credential stores
 * themselves (keychain / `.credentials.json`, routed in ccbConfigProfile.ts),
 * the official config *files* can also carry credentials or commands that
 * obtain them:
 *
 *   - login identity / API-key fields in the global config (`~/.claude.json`);
 *   - `env` blocks (global config and `settings.json`) holding API keys,
 *     auth tokens, and cloud credentials;
 *   - settings keys that run a helper to produce credentials.
 *
 * These are removed
 *   1. when the compatible profile reads the OFFICIAL layer (the CCB overlay
 *      layer is never filtered: values CCB itself writes still apply), and
 *   2. when an isolated profile is imported from the official tree.
 *
 * Rationale: OAuth refresh tokens rotate, so two clients holding the same
 * token invalidate each other; and inheriting an identity/helper without its
 * tokens would make CCB display or invoke the official account.
 *
 * This module is pure (type-only imports) so it is safe to load from the
 * lightweight startup paths.
 */

import type { GlobalConfig } from './config.js'
import type { SettingsJson } from './settings/types.js'

/**
 * Global-config (`.claude.json`) keys that carry login identity, API-key
 * secrets, or API-key approval state.
 *
 * - oauthAccount: the logged-in account/org; inheriting it would show the
 *   official account while CCB holds no tokens for it.
 * - primaryApiKey: legacy API key secret stored in plaintext in .claude.json.
 * - workspaceApiKey: workspace API key secret saved via the /login UI.
 * - customApiKeyResponses: which ANTHROPIC_API_KEY values the user approved
 *   or rejected; approval of a key is an auth decision per client.
 * - apiKeyHelper: deprecated global-config command that produces an API key;
 *   inheriting it would make CCB obtain the official profile's credentials.
 */
export const CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS = [
  'oauthAccount',
  'primaryApiKey',
  'workspaceApiKey',
  'customApiKeyResponses',
  'apiKeyHelper',
] as const satisfies readonly (keyof GlobalConfig)[]

/**
 * `settings.json` keys that carry or produce credentials.
 *
 * - apiKeyHelper / awsCredentialExport / awsAuthRefresh / gcpAuthRefresh:
 *   user-supplied commands/scripts that emit or refresh Anthropic API keys,
 *   AWS credentials, or GCP auth (see auth.ts).
 * - otelHeadersHelper: command whose output becomes OpenTelemetry exporter
 *   headers, which routinely carry bearer tokens.
 * - workspaceApiKey: workspace API key secret (also declared in the schema).
 * - braveApiKey / exaApiKey: third-party search API key secrets that the
 *   settings schema stores in plaintext.
 */
export const CCB_CREDENTIAL_SETTINGS_KEYS = [
  'apiKeyHelper',
  'awsCredentialExport',
  'awsAuthRefresh',
  'gcpAuthRefresh',
  'otelHeadersHelper',
  'workspaceApiKey',
  'braveApiKey',
  'exaApiKey',
] as const satisfies readonly (keyof SettingsJson)[]

/**
 * Environment variable names (as set through the `env` block of the global
 * config or `settings.json`) that carry secrets. Compiled from an audit of
 * every `process.env.*` credential read in src/ and packages/. Matching is
 * case-insensitive (Windows env names are).
 *
 * This is a deliberate SUPERSET of GHA_SUBPROCESS_SCRUB in subprocessEnv.ts —
 * the repo's own list of credential-bearing variables — so the two cannot
 * drift apart in the dangerous direction (a test imports that list and checks
 * every entry is matched here). Differences are intentional: this list also
 * covers provider/cloud/service keys the GitHub-Actions scrub does not need,
 * and, like that list, it leaves GITHUB_TOKEN/GH_TOKEN out.
 *
 * Non-secret routing config (ANTHROPIC_BASE_URL, *_MODEL, OPENAI_AUTH_MODE,
 * AWS_REGION, AWS_PROFILE, CLAUDE_CODE_USE_*, CLAUDE_CODE_SKIP_*_AUTH, proxy
 * and mTLS key/cert paths such as CLAUDE_CODE_CLIENT_KEY, ...) is deliberately
 * NOT listed and stays inherited.
 */
export const CCB_CREDENTIAL_ENV_VARS: ReadonlySet<string> = new Set([
  // Anthropic / Claude Code auth (auth.ts, services/api/client.ts, oauth, bridge)
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_SESSION_ACCESS_TOKEN',
  'CLAUDE_BRIDGE_OAUTH_TOKEN',
  'CLAUDE_TRUSTED_DEVICE_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  // Gateway auth: custom request headers routinely carry
  // `Authorization: Bearer ...`; OTLP exporter headers are documented to carry
  // bearer tokens for monitoring backends (the env counterpart of the
  // otelHeadersHelper settings key below)
  'ANTHROPIC_CUSTOM_HEADERS',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',
  // AWS Bedrock (SDK default credential chain + Bedrock bearer token)
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  // Azure / Foundry (DefaultAzureCredential)
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',
  'AZURE_CLIENT_CERTIFICATE_PASSWORD',
  'AZURE_PASSWORD',
  // Google Vertex / Gemini (pointer to a service-account key file is a
  // credential in its own right)
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  // OpenAI-compatible and other provider keys this fork reads
  'OPENAI_API_KEY',
  'GROK_API_KEY',
  'XAI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'DASHSCOPE_API_KEY',
  // Third-party service keys read by built-in tools / services
  'BRAVE_API_KEY',
  'BRAVE_SEARCH_API_KEY',
  'CLAUDE_CODE_BALANCE_KEY',
  'LANGFUSE_SECRET_KEY',
  'DATADOG_API_KEY',
  // MCP OAuth client secrets
  'MCP_CLIENT_SECRET',
  'MCP_XAA_IDP_CLIENT_SECRET',
  // CCB service / remote-control tokens and mTLS key passphrase
  'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
  'CLAUDE_GB_ADAPTER_KEY',
  'CLAUDE_ARTIFACTS_TOKEN',
  'RCS_API_KEYS',
  'ACP_AUTH_TOKEN',
  'ACP_RCS_TOKEN',
  // GitHub Actions runtime/OIDC secrets and claude-code-action internals.
  // Present only so this list stays a SUPERSET of GHA_SUBPROCESS_SCRUB in
  // subprocessEnv.ts (enforced by a test); nobody sets them in settings env.
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',
])

/**
 * Name suffixes treated as secrets even when the exact name is not listed
 * above. This covers user-defined providers whose key variable is named in
 * providers.json (`apiKeyEnv`, conventionally `<PROVIDER>_API_KEY`) and
 * future provider variables. Deliberately narrow: bare `*_TOKEN` is NOT
 * matched so that e.g. GITHUB_TOKEN-style tokens for unrelated tools and
 * counters such as MAX_THINKING_TOKENS stay inherited.
 */
const CCB_CREDENTIAL_ENV_VAR_SUFFIXES = [
  '_API_KEY',
  '_API_KEYS',
  '_API_TOKEN',
  '_AUTH_TOKEN',
  '_ACCESS_TOKEN',
  '_REFRESH_TOKEN',
  '_OAUTH_TOKEN',
  '_BEARER_TOKEN',
  '_SESSION_TOKEN',
  '_SECRET',
  '_SECRET_KEY',
  '_SECRET_ACCESS_KEY',
  '_ACCESS_KEY_ID',
  '_PASSWORD',
  '_PASSPHRASE',
] as const

export function isCcbCredentialEnvVar(name: string): boolean {
  const upper = name.toUpperCase()
  return (
    CCB_CREDENTIAL_ENV_VARS.has(upper) ||
    CCB_CREDENTIAL_ENV_VAR_SUFFIXES.some(suffix => upper.endsWith(suffix))
  )
}

/** Drop secret-bearing entries from an `env` block; other entries survive. */
export function stripCcbCredentialEnv(env: unknown): unknown {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) {
    return env
  }
  const kept: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(env)) {
    if (!isCcbCredentialEnvVar(name)) kept[name] = value
  }
  return kept
}

function stripKeys(
  config: object,
  keys: readonly string[],
): Record<string, unknown> {
  const stripped = { ...config } as Record<string, unknown>
  for (const key of keys) delete stripped[key]
  if ('env' in stripped) stripped.env = stripCcbCredentialEnv(stripped.env)
  return stripped
}

/**
 * Official global config as CCB may see it: identity/API-key fields removed
 * and secret env entries dropped. Returns a copy; the input is not mutated.
 */
export function stripCcbCredentialGlobalConfig<T extends object>(config: T): T {
  return stripKeys(config, CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS) as T
}

/**
 * Official user settings as CCB may see them: credential-producing keys
 * removed and secret env entries dropped. Returns a copy.
 */
export function stripCcbCredentialSettings<T extends object>(settings: T): T {
  return stripKeys(settings, CCB_CREDENTIAL_SETTINGS_KEYS) as T
}

// ── Which official profile files are credential or config files ──────────────

/**
 * How an import/inherit step must treat a file of the official profile,
 * decided by file NAME only (so it holds at any depth and for any symlink
 * target):
 * - credential: never copied (OAuth tokens, ChatGPT tokens, backups of the
 *   global config, which contain the identity/API-key fields);
 * - settings: user/project settings JSON — copy only after
 *   stripCcbCredentialSettings();
 * - globalConfig: global config JSON (`.claude.json`, its OAuth-suffixed
 *   variants, legacy `.config.json`) — copy only after
 *   stripCcbCredentialGlobalConfig().
 */
export type CcbOfficialFileKind = 'credential' | 'settings' | 'globalConfig'

const OFFICIAL_CREDENTIAL_FILE_NAMES: ReadonlySet<string> = new Set([
  '.credentials.json',
  'openai-chatgpt-auth.json',
])
const OFFICIAL_SETTINGS_FILE_NAMES: ReadonlySet<string> = new Set([
  'settings.json',
  'cowork_settings.json',
  'settings.local.json',
])
// `.claude.json`, `.claude-custom-oauth.json`, `.claude-local-oauth.json`,
// `.claude-staging-oauth.json` (fileSuffixForOauthConfig()), `.config.json`.
const OFFICIAL_GLOBAL_CONFIG_FILE_RE =
  /^\.(?:config|claude(?:-[a-z0-9]+)*)\.json$/i
// Timestamped copies of the global config written by getConfig()/saveConfig().
const OFFICIAL_GLOBAL_CONFIG_BACKUP_RE =
  /^\.(?:config|claude(?:-[a-z0-9]+)*)\.json\.(?:backup|corrupted)(?:\..*)?$/i

export function classifyCcbOfficialFile(
  name: string,
): CcbOfficialFileKind | undefined {
  if (
    OFFICIAL_CREDENTIAL_FILE_NAMES.has(name) ||
    OFFICIAL_GLOBAL_CONFIG_BACKUP_RE.test(name)
  ) {
    return 'credential'
  }
  if (OFFICIAL_SETTINGS_FILE_NAMES.has(name)) return 'settings'
  if (OFFICIAL_GLOBAL_CONFIG_FILE_RE.test(name)) return 'globalConfig'
  return undefined
}

/** The sanitizer for a copied file of the given kind. */
export function getCcbCredentialSanitizer(
  kind: Exclude<CcbOfficialFileKind, 'credential'>,
): (parsed: object) => object {
  return kind === 'settings'
    ? stripCcbCredentialSettings
    : stripCcbCredentialGlobalConfig
}
