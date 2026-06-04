// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { setTimeout as sleep } from 'node:timers/promises';

import packageJson from '../../package.json';
import {
  AccessType,
  doShutdown,
  installSQLChannelTransport,
  type SQLShutdownOptions,
} from '../sql/channels.preload.ts';
import {
  DataReader,
  DataWriter,
  initialize,
  removeDB as removeServerDB,
  setServerLogger,
} from '../sql/Server.node.ts';
import type { WritableDB } from '../sql/Interface.std.ts';

import { silentLogger } from './logger.node.ts';
import { getOrCreateSqlKey, type CliProfile } from './profile.node.ts';

export type CliSqlContext = Readonly<{
  db: WritableDB;
  reader: typeof DataReader;
  writer: typeof DataWriter;
}>;

type CliSqlOptions = Readonly<{
  drainAfterReturnMs?: number;
  keepAliveAfterReturn?: boolean;
  shutdownMaxMs?: number;
  shutdownQuietMs?: number;
}>;

const DB_OPEN_BUSY_RETRIES = 20;
const DB_OPEN_BUSY_RETRY_MS = 100;

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && error.message.includes('SQLITE_BUSY');
}

export async function withSqlBusyRetry<T>(
  fn: () => T | Promise<T>,
  {
    delayMs = DB_OPEN_BUSY_RETRY_MS,
    retries = DB_OPEN_BUSY_RETRIES,
  }: Readonly<{ delayMs?: number; retries?: number }> = {}
): Promise<T> {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (!isSqliteBusy(error) || attempt + 1 === retries) {
        throw error;
      }

      await sleep(delayMs);
    }
  }

  throw new Error('SQL busy retry exhausted');
}

async function initializeCliDatabase(
  profile: CliProfile,
  key: string
): Promise<WritableDB> {
  return withSqlBusyRetry(() =>
    initialize({
      appVersion: packageJson.version,
      configDir: profile.userDataPath,
      key,
      isPrimary: true,
    })
  );
}

async function shutdownCliSqlClient(
  options: SQLShutdownOptions = {}
): Promise<void> {
  const { DataWriter: ClientDataWriter } = await import(
    '../sql/Client.preload.ts'
  );
  await ClientDataWriter.flushUpdateConversationBatcher();
  await doShutdown(options);
}

export async function withCliSql<T>(
  profile: CliProfile,
  fn: (context: CliSqlContext) => Promise<T> | T,
  options: CliSqlOptions = {}
): Promise<T> {
  const key = getOrCreateSqlKey(profile);
  setServerLogger(silentLogger);
  const db = await initializeCliDatabase(profile, key);
  installSQLChannelTransport({
    async invoke<T>(
      access: AccessType,
      name: string,
      args: ReadonlyArray<unknown>
    ): Promise<T> {
      const target = access === AccessType.Read ? DataReader : DataWriter;
      const method = Reflect.get(target, name);
      if (typeof method !== 'function') {
        throw new Error(`Unknown SQL method: ${access}.${name}`);
      }

      return withSqlBusyRetry(() => method(db, ...args) as T);
    },
    async removeDB() {
      removeServerDB();
    },
  });

  try {
    return await fn({ db, reader: DataReader, writer: DataWriter });
  } finally {
    if (!options.keepAliveAfterReturn) {
      if (options.drainAfterReturnMs) {
        await sleep(options.drainAfterReturnMs);
      }
      await shutdownCliSqlClient({
        maxMs: options.shutdownMaxMs,
        quietMs: options.shutdownQuietMs,
      });
      installSQLChannelTransport(undefined);
      await withSqlBusyRetry(() => DataWriter.close(db), {
        delayMs: DB_OPEN_BUSY_RETRY_MS,
        retries: 50,
      });
    }
  }
}
