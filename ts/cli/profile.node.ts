// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { homedir, platform } from 'node:os';

import { sync as writeFileAtomicSync } from 'write-file-atomic';

import { CliError } from './errors.node.ts';

const CONFIG_FILE = 'signalctl.json';

export type ProfileOptions = Readonly<{
  dataDir?: string;
  profile?: string;
}>;

export type CliProfile = Readonly<{
  name: string;
  userDataPath: string;
  configPath: string;
}>;

type CliProfileConfig = {
  sqlKey?: unknown;
};

function getDefaultBaseDir(): string {
  if (process.env.SIGNALCTL_HOME) {
    return resolve(process.env.SIGNALCTL_HOME);
  }

  const home = homedir();
  switch (platform()) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'signalctl');
    case 'win32':
      return join(
        process.env.APPDATA ?? join(home, 'AppData', 'Roaming'),
        'signalctl'
      );
    default:
      return join(
        process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'),
        'signalctl'
      );
  }
}

export function resolveProfile(options: ProfileOptions): CliProfile {
  if (options.dataDir) {
    const userDataPath = resolve(options.dataDir);
    return {
      name: options.profile ?? basename(userDataPath),
      userDataPath,
      configPath: join(userDataPath, CONFIG_FILE),
    };
  }

  const name = options.profile ?? 'default';
  const userDataPath = join(getDefaultBaseDir(), name);
  return {
    name,
    userDataPath,
    configPath: join(userDataPath, CONFIG_FILE),
  };
}

function readConfig(configPath: string): CliProfileConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  try {
    return JSON.parse(readFileSync(configPath, 'utf8')) as CliProfileConfig;
  } catch (error) {
    throw new CliError(
      'profile_config_invalid',
      'CLI profile config is invalid JSON',
      {
        details: {
          configPath,
          cause: error instanceof Error ? error.message : String(error),
        },
      }
    );
  }
}

function writeConfig(profile: CliProfile, config: CliProfileConfig): void {
  mkdirSync(profile.userDataPath, { recursive: true });
  writeFileAtomicSync(
    profile.configPath,
    JSON.stringify(config, null, 2),
    'utf8'
  );
}

export function getOrCreateSqlKey(profile: CliProfile): string {
  const config = readConfig(profile.configPath);
  if (typeof config.sqlKey === 'string') {
    return config.sqlKey;
  }

  const sqlKey = randomBytes(32).toString('hex');
  writeConfig(profile, { ...config, sqlKey });
  return sqlKey;
}

export async function resetProfileData(profile: CliProfile): Promise<void> {
  const userDataPath = resolve(profile.userDataPath);
  const { root } = parse(userDataPath);

  if (userDataPath === root || dirname(userDataPath) === root) {
    throw new CliError(
      'unsafe_profile_reset',
      'Refusing to delete an unsafe profile directory',
      {
        exitCode: 2,
        details: { userDataPath },
      }
    );
  }

  await rm(userDataPath, { force: true, recursive: true });
}
