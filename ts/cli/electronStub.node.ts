// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { promises as dnsPromises } from 'node:dns';

function unavailable(name: string): Error {
  return new Error(
    `Electron ${name} is unavailable in signalctl headless mode`
  );
}

export const ipcRenderer = {
  invoke: async (channel: string, ...args: ReadonlyArray<unknown>) => {
    if (channel === 'net.resolveHost') {
      const [hostname, queryType] = args;
      if (typeof hostname !== 'string') {
        throw unavailable('ipcRenderer.invoke(net.resolveHost)');
      }

      const family = queryType === 'AAAA' ? 6 : queryType === 'A' ? 4 : 0;
      const records = await dnsPromises.lookup(hostname, {
        all: true,
        family,
      });

      return {
        endpoints: records.map(record => ({
          address: record.address,
          family: record.family === 6 ? 'ipv6' : 'ipv4',
        })),
      };
    }

    throw unavailable(`ipcRenderer.invoke(${channel})`);
  },
  on: () => undefined,
  once: () => undefined,
  removeListener: () => undefined,
  send: () => undefined,
};

export const clipboard = {
  writeText: () => undefined,
};

export const net = {
  resolveHost: async (
    hostname: string,
    options: Readonly<{ queryType?: 'A' | 'AAAA' }> = {}
  ) => {
    const family =
      options.queryType === 'AAAA' ? 6 : options.queryType === 'A' ? 4 : 0;
    const records = await dnsPromises.lookup(hostname, {
      all: true,
      family,
    });

    return {
      endpoints: records.map(record => ({
        address: record.address,
        family: record.family === 6 ? 'ipv6' : 'ipv4',
      })),
    };
  },
};

export const nativeImage = {
  createFromPath: () => ({}),
};

export const contextBridge = {
  exposeInMainWorld: () => undefined,
};

export const webUtils = {
  getPathForFile: () => '',
};
