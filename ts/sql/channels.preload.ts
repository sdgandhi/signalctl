// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { IpcRenderer } from 'electron';
import { setTimeout as sleep } from 'node:timers/promises';
import { serialize, deserialize } from 'node:v8';
import { createLogger } from '../logging/log.std.ts';
import { runTaskWithTimeout } from '../textsecure/TaskWithTimeout.std.ts';
import { missingCaseError } from '../util/missingCaseError.std.ts';

const log = createLogger('channels');

const SQL_READ_KEY = 'sql-channel:read';
const SQL_WRITE_KEY = 'sql-channel:write';
const SQL_REMOVE_DB_KEY = 'sql-channel:remove-db';
let activeJobCount = 0;
let shutdownPromise: Promise<void> | null = null;

export type SQLShutdownOptions = Readonly<{
  maxMs?: number;
  pollMs?: number;
  quietMs?: number;
}>;

const DEFAULT_SHUTDOWN_MAX_MS = 1000;
const DEFAULT_SHUTDOWN_POLL_MS = 50;
const DEFAULT_SHUTDOWN_QUIET_MS = 100;

export type SQLChannelTransport = Readonly<{
  invoke: <T>(
    access: AccessType,
    name: string,
    args: ReadonlyArray<unknown>
  ) => Promise<T>;
  removeDB?: () => Promise<void>;
  shutdown?: () => Promise<void>;
}>;

let installedTransport: SQLChannelTransport | undefined;
let cachedIpcRenderer: IpcRenderer | undefined;

export enum AccessType {
  Read = 'Read',
  Write = 'Write',
}

export function installSQLChannelTransport(
  transport: SQLChannelTransport | undefined
): void {
  installedTransport = transport;

  if (transport) {
    shutdownPromise = null;
    activeJobCount = 0;
  }
}

export function isShutdownRequested(): boolean {
  return shutdownPromise != null;
}

function getHeadlessLateSqlResult(name: string): unknown {
  if (
    name === 'getExpiredMessages' ||
    name === 'getNextAttachmentDownloadJobs' ||
    name === 'getTapToViewMessagesNeedingErase'
  ) {
    return [];
  }

  return undefined;
}

async function getIpcRenderer(): Promise<IpcRenderer> {
  if (cachedIpcRenderer) {
    return cachedIpcRenderer;
  }

  ({ ipcRenderer: cachedIpcRenderer } = await import('electron'));
  if (!cachedIpcRenderer) {
    throw new Error('Electron ipcRenderer is unavailable');
  }

  return cachedIpcRenderer;
}

export async function ipcInvoke<T>(
  access: AccessType,
  name: string,
  args: ReadonlyArray<unknown>
): Promise<T> {
  if (!installedTransport && shutdownPromise && process.env.SIGNALCTL_HEADLESS) {
    log.warn(
      `Ignoring late SQL channel job (${access}, ${name}) after headless ` +
        'shutdown'
    );
    return getHeadlessLateSqlResult(name) as T;
  }

  let channel: string;
  if (access === AccessType.Read) {
    channel = SQL_READ_KEY;
  } else if (access === AccessType.Write) {
    channel = SQL_WRITE_KEY;
  } else {
    throw missingCaseError(access);
  }

  activeJobCount += 1;
  return runTaskWithTimeout(async () => {
    try {
      if (installedTransport) {
        return installedTransport.invoke<T>(access, name, args);
      }

      const ipcRenderer = await getIpcRenderer();
      const result = await ipcRenderer.invoke(channel, name, serialize(args));
      if (!result.ok) {
        throw result.error;
      }
      return deserialize(result.value);
    } finally {
      activeJobCount -= 1;
    }
  }, `SQL channel call (${access}, ${name})`);
}

async function waitForQuietSql({
  maxMs = DEFAULT_SHUTDOWN_MAX_MS,
  pollMs = DEFAULT_SHUTDOWN_POLL_MS,
  quietMs = DEFAULT_SHUTDOWN_QUIET_MS,
}: SQLShutdownOptions = {}): Promise<void> {
  const startedAt = Date.now();
  let quietStartedAt: number | undefined;

  while (Date.now() - startedAt < maxMs) {
    if (activeJobCount === 0) {
      quietStartedAt ??= Date.now();
      if (Date.now() - quietStartedAt >= quietMs) {
        return;
      }
    } else {
      quietStartedAt = undefined;
    }

    // oxlint-disable-next-line no-await-in-loop
    await sleep(pollMs);
  }

  log.warn(
    `data.shutdown: timed out waiting for quiet SQL channel; ` +
      `${activeJobCount} jobs outstanding`
  );
}

export async function doShutdown(
  options: SQLShutdownOptions = {}
): Promise<void> {
  log.info(
    `data.shutdown: shutdown requested. ${activeJobCount} jobs outstanding`
  );

  if (!shutdownPromise) {
    shutdownPromise = (async () => {
      await waitForQuietSql(options);
      await installedTransport?.shutdown?.();
      log.info('data.shutdown: process complete');
    })();
  }

  await shutdownPromise;
}

export async function removeDB(): Promise<void> {
  if (installedTransport?.removeDB) {
    return installedTransport.removeDB();
  }

  const ipcRenderer = await getIpcRenderer();
  return ipcRenderer.invoke(SQL_REMOVE_DB_KEY);
}
