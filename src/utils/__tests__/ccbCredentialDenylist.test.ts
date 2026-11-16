import { describe, expect, test } from 'bun:test'
import {
  CCB_CREDENTIAL_ENV_VARS,
  CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS,
  CCB_CREDENTIAL_SETTINGS_KEYS,
  isCcbCredentialEnvVar,
  stripCcbCredentialEnv,
  stripCcbCredentialGlobalConfig,
  stripCcbCredentialSettings,
} from '../ccbCredentialDenylist.js'

describe('credential denylist', () => {
  test('preserves MCP server authentication configuration', () => {
    const mcpServers = {
      local: { command: 'mcp', env: { SERVICE_API_KEY: 'service-key' } },
      remote: {
        type: 'http',
        url: 'https://mcp.example',
        headers: { Authorization: 'Bearer service-token' },
        headersHelper: 'get-service-headers',
      },
    }
    expect(stripCcbCredentialGlobalConfig({ mcpServers }).mcpServers).toEqual(
      mcpServers,
    )
  })

  describe('env var names', () => {
    // The names the codebase actually consumes as credentials (see audit in
    // ccbCredentialDenylist.ts) — every one must be treated as a secret.
    test.each([
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
      'ANTHROPIC_FOUNDRY_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GROK_API_KEY',
      'XAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'GROQ_API_KEY',
      'CEREBRAS_API_KEY',
      'DASHSCOPE_API_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_BEARER_TOKEN_BEDROCK',
      'AZURE_CLIENT_SECRET',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'BRAVE_API_KEY',
      'BRAVE_SEARCH_API_KEY',
      'MCP_CLIENT_SECRET',
      'CLAUDE_CODE_CLIENT_KEY_PASSPHRASE',
    ])('%s is a credential env var', name => {
      expect(isCcbCredentialEnvVar(name)).toBe(true)
    })

    test('every explicitly listed name matches (case-insensitively)', () => {
      for (const name of CCB_CREDENTIAL_ENV_VARS) {
        expect(isCcbCredentialEnvVar(name)).toBe(true)
        expect(isCcbCredentialEnvVar(name.toLowerCase())).toBe(true)
      }
    })

    test('user-defined provider key variables are matched by suffix', () => {
      expect(isCcbCredentialEnvVar('MYPROVIDER_API_KEY')).toBe(true)
      expect(isCcbCredentialEnvVar('ACME_AUTH_TOKEN')).toBe(true)
      expect(isCcbCredentialEnvVar('SOMETHING_CLIENT_SECRET')).toBe(true)
    })

    test.each([
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL',
      'OPENAI_BASE_URL',
      'OPENAI_MODEL',
      'OPENAI_AUTH_MODE',
      'GEMINI_BASE_URL',
      'AWS_REGION',
      'AWS_PROFILE',
      'CLAUDE_CODE_USE_BEDROCK',
      'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
      'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
      'CLAUDE_CODE_CLIENT_KEY',
      'ANTHROPIC_AUTH_NONCE',
      'MAX_THINKING_TOKENS',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'HTTPS_PROXY',
      'DISABLE_TELEMETRY',
    ])('%s (non-secret config) stays inherited', name => {
      expect(isCcbCredentialEnvVar(name)).toBe(false)
    })
  })

  test('stripCcbCredentialEnv keeps non-secret entries only', () => {
    expect(
      stripCcbCredentialEnv({
        ANTHROPIC_API_KEY: 'k',
        ANTHROPIC_BASE_URL: 'https://x',
        OPENAI_API_KEY: 'k',
        FOO: 'bar',
      }),
    ).toEqual({ ANTHROPIC_BASE_URL: 'https://x', FOO: 'bar' })
    expect(stripCcbCredentialEnv(undefined)).toBeUndefined()
    expect(stripCcbCredentialEnv(null)).toBeNull()
  })

  test('stripCcbCredentialGlobalConfig drops identity keys and secret env, without mutating', () => {
    const input: Record<string, unknown> = {
      numStartups: 3,
      oauthAccount: { accountUuid: 'a' },
      primaryApiKey: 'p',
      workspaceApiKey: 'w',
      customApiKeyResponses: { approved: ['x'], rejected: [] },
      apiKeyHelper: 'echo',
      env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_MODEL: 'm' },
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    const output = stripCcbCredentialGlobalConfig(input)
    expect(output).toEqual({ numStartups: 3, env: { ANTHROPIC_MODEL: 'm' } })
    expect(input).toEqual(snapshot)
    expect(CCB_CREDENTIAL_GLOBAL_CONFIG_KEYS).toEqual([
      'oauthAccount',
      'primaryApiKey',
      'workspaceApiKey',
      'customApiKeyResponses',
      'apiKeyHelper',
    ])
  })

  test('stripCcbCredentialSettings drops credential-producing keys and secret env, without mutating', () => {
    const input: Record<string, unknown> = {
      model: 'opus',
      apiKeyHelper: 'a',
      awsCredentialExport: 'b',
      awsAuthRefresh: 'c',
      gcpAuthRefresh: 'd',
      otelHeadersHelper: 'e',
      workspaceApiKey: 'f',
      braveApiKey: 'g',
      exaApiKey: 'h',
      env: { AWS_SECRET_ACCESS_KEY: 's', AWS_REGION: 'us-east-1' },
    }
    const snapshot = JSON.parse(JSON.stringify(input))
    expect(stripCcbCredentialSettings(input)).toEqual({
      model: 'opus',
      env: { AWS_REGION: 'us-east-1' },
    })
    expect(input).toEqual(snapshot)
    for (const key of CCB_CREDENTIAL_SETTINGS_KEYS) {
      expect(stripCcbCredentialSettings({ [key]: 'x' })).toEqual({})
    }
  })
})
