import React from 'react';
import { Box, Dialog, wrappedRender as render, Text } from '@anthropic/ink';
import { KeybindingSetup } from '../keybindings/KeybindingProviderSetup.js';
import { AppStateProvider } from '../state/AppState.js';
import { isReadOnlyOfficialGlobalClaudeFile } from '../utils/env.js';
import type { ConfigParseError } from '../utils/errors.js';
import { getBaseRenderOptions } from '../utils/renderOptions.js';
import { resetInvalidConfigFile } from '../utils/resetInvalidConfig.js';
import type { ThemeName } from '../utils/theme.js';
import { Select } from './CustomSelect/index.js';

interface InvalidConfigHandlerProps {
  error: ConfigParseError;
}

interface InvalidConfigDialogProps {
  filePath: string;
  errorDescription: string;
  /** Hide the reset option: the file must never be written (official global config in CCB compatible mode). */
  readOnly?: boolean;
  onExit: () => void;
  onReset: () => void;
}

/**
 * Dialog shown when the Claude config file contains invalid JSON
 */
function InvalidConfigDialog({
  filePath,
  errorDescription,
  readOnly = false,
  onExit,
  onReset,
}: InvalidConfigDialogProps): React.ReactNode {
  // Handler for Select onChange
  const handleSelect = (value: string) => {
    if (value === 'exit') {
      onExit();
    } else {
      onReset();
    }
  };

  return (
    <Dialog title="Configuration Error" color="error" onCancel={onExit}>
      <Box flexDirection="column" gap={1}>
        <Text>
          The configuration file at <Text bold>{filePath}</Text> contains invalid JSON.
        </Text>
        <Text>{errorDescription}</Text>
      </Box>
      <Box flexDirection="column">
        <Text bold>Choose an option:</Text>
        <Select
          options={[
            { label: 'Exit and fix manually', value: 'exit' },
            ...(readOnly ? [] : [{ label: 'Reset with default configuration', value: 'reset' }]),
          ]}
          onChange={handleSelect}
          onCancel={onExit}
        />
      </Box>
    </Dialog>
  );
}

/**
 * Safe fallback theme name for error dialogs to avoid circular dependency.
 * Uses a hardcoded dark theme that doesn't require reading from config.
 */
const SAFE_ERROR_THEME_NAME: ThemeName = 'dark';

export async function showInvalidConfigDialog({ error }: InvalidConfigHandlerProps): Promise<void> {
  // Extend RenderOptions with theme property for this specific usage
  type SafeRenderOptions = Parameters<typeof render>[1] & { theme?: ThemeName };

  const renderOptions: SafeRenderOptions = {
    ...getBaseRenderOptions(false),
    // IMPORTANT: Use hardcoded theme name to avoid circular dependency with getGlobalConfig()
    // This allows the error dialog to show even when config file has JSON syntax errors
    theme: SAFE_ERROR_THEME_NAME,
  };

  const readOnly = isReadOnlyOfficialGlobalClaudeFile(error.filePath);

  // biome-ignore lint/suspicious/noAsyncPromiseExecutor: render must be awaited inside executor
  await new Promise<void>(async resolve => {
    const { unmount } = await render(
      <AppStateProvider>
        <KeybindingSetup>
          <InvalidConfigDialog
            filePath={error.filePath}
            errorDescription={error.message}
            readOnly={readOnly}
            onExit={() => {
              unmount();
              void resolve();
              process.exit(1);
            }}
            onReset={() => {
              // Refused (and the process exits non-zero) for the read-only
              // official global config; the reset option is also hidden then.
              const didReset = resetInvalidConfigFile(error.filePath, error.defaultConfig);
              if (!didReset) {
                unmount();
                void resolve();
                process.exit(1);
                return;
              }
              unmount();
              void resolve();
              process.exit(0);
            }}
          />
        </KeybindingSetup>
      </AppStateProvider>,
      renderOptions,
    );
  });
}
