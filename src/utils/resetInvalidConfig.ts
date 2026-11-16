import { isReadOnlyOfficialGlobalClaudeFile } from './env.js'
import { jsonStringify, writeFileSync_DEPRECATED } from './slowOperations.js'

/**
 * Overwrite an invalid config file with its default contents (the
 * InvalidConfigDialog "Reset with default configuration" action).
 *
 * Refuses, returning false, for the official global config in CCB compatible
 * mode: that file belongs to official Claude Code and CCB never writes it.
 */
export function resetInvalidConfigFile(
  filePath: string,
  defaultConfig: unknown,
): boolean {
  if (isReadOnlyOfficialGlobalClaudeFile(filePath)) return false
  writeFileSync_DEPRECATED(filePath, jsonStringify(defaultConfig, null, 2), {
    flush: false,
    encoding: 'utf8',
  })
  return true
}
