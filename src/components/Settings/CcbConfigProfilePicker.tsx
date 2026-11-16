import { Box, Dialog, Text } from '@anthropic/ink';
import React from 'react';
import {
  configureCcbConfigProfile,
  type CcbConfigMode,
  type IsolatedProfileInitialization,
  readPersistedCcbConfigMode,
} from '../../utils/ccbConfigProfile.js';
import { getOfficialGlobalClaudeFile } from '../../utils/env.js';
import { Select } from '../CustomSelect/index.js';

type ProfileChoice = 'compatible' | 'isolated-reuse' | 'isolated-import' | 'isolated-fresh';

type Props = {
  onComplete(label: string): void;
  onCancel(): void;
};

function modeLabel(mode: CcbConfigMode): string {
  return mode === 'compatible' ? 'Compatible (inherit official)' : 'Isolated';
}

export function CcbConfigProfilePicker({ onComplete, onCancel }: Props): React.ReactNode {
  const [pendingDestructiveChoice, setPendingDestructiveChoice] = React.useState<
    'isolated-import' | 'isolated-fresh' | null
  >(null);
  const [error, setError] = React.useState<string | null>(null);

  function apply(mode: CcbConfigMode, isolatedInitialization?: IsolatedProfileInitialization): void {
    try {
      configureCcbConfigProfile({
        mode,
        isolatedInitialization,
        officialGlobalConfigFile: getOfficialGlobalClaudeFile(),
      });
      onComplete(modeLabel(mode));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setPendingDestructiveChoice(null);
    }
  }

  if (pendingDestructiveChoice) {
    const importing = pendingDestructiveChoice === 'isolated-import';
    return (
      <Dialog
        title="Confirm isolated profile replacement"
        color="warning"
        onCancel={() => setPendingDestructiveChoice(null)}
      >
        <Box flexDirection="column" gap={1}>
          <Text>
            {importing
              ? 'Replace the isolated profile with a copy of ~/.claude and the official global config? Login credentials are not copied; you will log in to CCB separately.'
              : 'Replace the isolated profile with a completely new, empty profile?'}
          </Text>
          <Text dimColor>The current isolated profile will first be moved to ~/.ccb/backups/.</Text>
          <Select
            options={[
              { label: importing ? 'Import and replace' : 'Create new and replace', value: 'confirm' },
              { label: 'Cancel', value: 'cancel' },
            ]}
            onChange={value => {
              if (value === 'cancel') {
                setPendingDestructiveChoice(null);
                return;
              }
              apply('isolated', importing ? 'import' : 'fresh');
            }}
            onCancel={() => setPendingDestructiveChoice(null)}
          />
        </Box>
      </Dialog>
    );
  }

  return (
    <Dialog title="CCB configuration profile" onCancel={onCancel}>
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Active after restart: {modeLabel(readPersistedCcbConfigMode())}. Profile changes never modify the official
          config files.
        </Text>
        {error ? <Text color="error">Failed to change profile: {error}</Text> : null}
        <Select<ProfileChoice>
          options={[
            {
              label: 'Compatible · inherit official',
              value: 'compatible',
              description:
                'Reuse official preferences and share writable skills, agents, and plugins; save CCB settings in its own overlay. Login is separate (official credentials are never shared).',
            },
            {
              label: 'Isolated · reuse previous',
              value: 'isolated-reuse',
              description: 'Use the existing ~/.ccb/isolated profile without changing any of its files.',
            },
            {
              label: 'Isolated · import official',
              value: 'isolated-import',
              description: 'Copy the complete official profile except login credentials, then continue independently.',
            },
            {
              label: 'Isolated · start fresh',
              value: 'isolated-fresh',
              description: 'Create an empty profile containing none of the official user data.',
            },
          ]}
          onChange={choice => {
            if (choice === 'compatible') {
              apply('compatible');
            } else if (choice === 'isolated-reuse') {
              apply('isolated', 'reuse');
            } else {
              setPendingDestructiveChoice(choice);
            }
          }}
          onCancel={onCancel}
        />
      </Box>
    </Dialog>
  );
}
