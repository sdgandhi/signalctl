// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { parseArgs } from 'node:util';

import { CliError } from './errors.node.ts';
import type { CliEnvironmentName } from './config.node.ts';
import type { ProfileOptions } from './profile.node.ts';

type GlobalOptions = ProfileOptions &
  Readonly<{
    environmentName: CliEnvironmentName;
  }>;

export type CliCommand =
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'version' }>
  | Readonly<{ kind: 'profile-info'; profileOptions: GlobalOptions }>
  | Readonly<{
      kind: 'conversations-list';
      profileOptions: GlobalOptions;
      includeArchived: boolean;
      limit: number;
    }>
  | Readonly<{
      kind: 'conversations-get';
      profileOptions: GlobalOptions;
      conversation: string;
    }>
  | Readonly<{
      kind: 'messages-list';
      profileOptions: GlobalOptions;
      conversation: string;
      before?: string;
      limit: number;
    }>
  | Readonly<{
      kind: 'messages-search';
      profileOptions: GlobalOptions;
      query: string;
      conversation?: string;
      limit: number;
    }>
  | Readonly<{
      kind: 'link';
      profileOptions: GlobalOptions;
      deviceName?: string;
      deleteExistingData: boolean;
      qr: boolean;
    }>
  | Readonly<{ kind: 'sync'; profileOptions: GlobalOptions }>
  | Readonly<{ kind: 'daemon'; profileOptions: GlobalOptions }>
  | Readonly<{
      kind: 'send';
      profileOptions: GlobalOptions;
      conversation: string;
      message: string;
      attachments: ReadonlyArray<string>;
      wait: boolean;
    }>;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function booleanValue(value: unknown): boolean {
  return value === true;
}

function stringArrayValue(value: unknown): ReadonlyArray<string> {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }
  if (typeof value === 'string') {
    return [value];
  }
  return [];
}

function parseLimit(value: unknown): number {
  if (value === undefined) {
    return DEFAULT_LIMIT;
  }

  const raw = stringValue(value);
  const limit = raw == null ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new CliError(
      'invalid_limit',
      `--limit must be an integer between 1 and ${MAX_LIMIT}`
    );
  }

  return limit;
}

function getProfileOptions(values: Record<string, unknown>): GlobalOptions {
  const environment = stringValue(values.environment) ?? 'production';
  if (environment !== 'production' && environment !== 'staging') {
    throw new CliError(
      'invalid_environment',
      '--environment must be production or staging'
    );
  }

  return {
    dataDir: stringValue(values['data-dir']),
    environmentName: environment,
    profile: stringValue(values.profile),
  };
}

export function parseCliArgs(argv: ReadonlyArray<string>): CliCommand {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      attach: { type: 'string', multiple: true },
      before: { type: 'string' },
      conversation: { type: 'string' },
      'data-dir': { type: 'string' },
      'delete-existing-data': { type: 'boolean' },
      'device-name': { type: 'string' },
      environment: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
      'include-archived': { type: 'boolean' },
      limit: { type: 'string' },
      message: { type: 'string' },
      'no-wait': { type: 'boolean' },
      profile: { type: 'string' },
      qr: { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      wait: { type: 'boolean' },
    },
  });

  if (booleanValue(values.help) || positionals.length === 0) {
    return { kind: 'help' };
  }
  if (booleanValue(values.version)) {
    return { kind: 'version' };
  }

  const profileOptions = getProfileOptions(values);
  const [first, second, third] = positionals;

  if (first === 'profile' && second === 'info') {
    return { kind: 'profile-info', profileOptions };
  }

  if (first === 'conversations' && second === 'list') {
    return {
      kind: 'conversations-list',
      profileOptions,
      includeArchived: booleanValue(values['include-archived']),
      limit: parseLimit(values.limit),
    };
  }

  if (first === 'conversations' && second === 'get' && third) {
    return { kind: 'conversations-get', profileOptions, conversation: third };
  }

  if (first === 'messages' && second === 'list' && third) {
    return {
      kind: 'messages-list',
      profileOptions,
      conversation: third,
      before: stringValue(values.before),
      limit: parseLimit(values.limit),
    };
  }

  if (first === 'messages' && second === 'search' && third) {
    return {
      kind: 'messages-search',
      profileOptions,
      query: third,
      conversation: stringValue(values.conversation),
      limit: parseLimit(values.limit),
    };
  }

  if (first === 'link') {
    return {
      kind: 'link',
      profileOptions,
      deviceName: stringValue(values['device-name']),
      deleteExistingData: booleanValue(values['delete-existing-data']),
      qr: true,
    };
  }

  if (first === 'sync') {
    return { kind: 'sync', profileOptions };
  }

  if (first === 'daemon') {
    return { kind: 'daemon', profileOptions };
  }

  if (first === 'send' && second) {
    const message = stringValue(values.message);
    if (!message) {
      throw new CliError('missing_message', 'send requires --message');
    }
    return {
      kind: 'send',
      profileOptions,
      conversation: second,
      message,
      attachments: stringArrayValue(values.attach),
      wait: !booleanValue(values['no-wait']),
    };
  }

  throw new CliError('unknown_command', 'Unknown signalctl command', {
    exitCode: 2,
    details: { positionals },
  });
}
