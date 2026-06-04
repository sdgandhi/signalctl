// Copyright 2023 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  LookupOneOptions,
  LookupAllOptions,
  LookupAddress,
  lookup as nodeLookup,
} from 'node:dns';
import { promises as dnsPromises } from 'node:dns';
import pTimeout from 'p-timeout';

import { strictAssert } from './assert.std.ts';
import { drop } from './drop.std.ts';
import type { DNSFallbackType } from '../types/DNSFallback.std.ts';
import { SECOND } from './durations/index.std.ts';

const LOOKUP_TIMEOUT_MS = 5 * SECOND;
type ResolvedEndpoint = Readonly<{
  address: string;
  family: 'ipv4' | 'ipv6' | 'unspec';
}>;
type ResolvedHost = Readonly<{
  endpoints: ReadonlyArray<ResolvedEndpoint>;
}>;
const fallbackAddrs = new Map<string, ReadonlyArray<ResolvedEndpoint>>();

export function setFallback(dnsFallback: DNSFallbackType): void {
  fallbackAddrs.clear();
  for (const { domain, endpoints } of dnsFallback) {
    fallbackAddrs.set(domain, endpoints);
  }
}

let ipv6Enabled = true;

export function setIPv6Enabled(value: boolean): void {
  ipv6Enabled = value;
}

function lookupAll(
  hostname: string,
  opts: LookupOneOptions | LookupAllOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    addresses: string | Array<LookupAddress>,
    family?: number
  ) => void
): void {
  // Node.js support various signatures, but we only support one.
  strictAssert(typeof opts === 'object', 'missing options');
  strictAssert(typeof callback === 'function', 'missing callback');

  async function run() {
    let result: Pick<ResolvedHost, 'endpoints'>;

    let queryType: 'A' | 'AAAA' | undefined;
    if (opts.family === 4) {
      queryType = 'A';
    } else if (opts.family === 6) {
      queryType = 'AAAA';
    }

    try {
      result = await pTimeout(
        process.env.SIGNALCTL_HEADLESS === '1'
          ? resolveWithNode(
              hostname,
              typeof opts.family === 'number' ? opts.family : undefined
            )
          : resolveWithElectron(hostname, queryType),
        {
          milliseconds: LOOKUP_TIMEOUT_MS,
          message: 'lookupAll: lookup timed out',
        }
      );
    } catch (error) {
      const fallback = fallbackAddrs.get(hostname);
      if (fallback) {
        result = { endpoints: fallback.slice() };
      } else {
        callback(error, []);
        return;
      }
    }

    let addresses = result.endpoints.map(({ address, family }) => {
      let numericFamily = -1;
      if (family === 'ipv4') {
        numericFamily = 4;
      } else if (family === 'ipv6') {
        numericFamily = 6;
      }
      return {
        address,
        family: numericFamily,
      };
    });

    if (!ipv6Enabled) {
      const ipv4Only = addresses.filter(({ family }) => family !== 6);
      if (ipv4Only.length !== 0) {
        addresses = ipv4Only;
      }
    }

    if (!opts.all) {
      const random = addresses.at(Math.floor(Math.random() * addresses.length));
      if (random === undefined) {
        callback(new Error(`Hostname: ${hostname} cannot be resolved`), '', -1);
        return;
      }
      callback(null, random.address, random.family);
      return;
    }

    callback(null, addresses);
  }

  drop(run());
}

async function resolveWithNode(
  hostname: string,
  family: number | undefined
): Promise<Pick<ResolvedHost, 'endpoints'>> {
  const records = await dnsPromises.lookup(hostname, {
    all: true,
    family: family === 4 || family === 6 ? family : 0,
  });

  return {
    endpoints: records.map(record => ({
      address: record.address,
      family: record.family === 6 ? 'ipv6' : 'ipv4',
    })),
  };
}

async function resolveWithElectron(
  hostname: string,
  queryType: 'A' | 'AAAA' | undefined
): Promise<Pick<ResolvedHost, 'endpoints'>> {
  const electron = await import('electron');

  if (electron.net) {
    // Main process
    return electron.net.resolveHost(hostname, {
      queryType,
    });
  }

  // Renderer
  return electron.ipcRenderer.invoke('net.resolveHost', hostname, queryType);
}

export function interleaveAddresses(
  addresses: ReadonlyArray<LookupAddress>
): Array<LookupAddress> {
  const firstAddr = addresses.find(
    ({ family }) => family === 4 || family === 6
  );
  if (!firstAddr) {
    throw new Error('interleaveAddresses: no addresses to interleave');
  }

  const v4 = addresses.filter(({ family }) => family === 4);
  const v6 = addresses.filter(({ family }) => family === 6);

  // Interleave addresses for Happy Eyeballs, but keep the first address
  // type from the DNS response first in the list.
  const interleaved = new Array<LookupAddress>();
  while (v4.length !== 0 || v6.length !== 0) {
    const v4Entry = v4.pop();
    const v6Entry = v6.pop();

    if (firstAddr.family === 4) {
      if (v4Entry !== undefined) {
        interleaved.push(v4Entry);
      }
      if (v6Entry !== undefined) {
        interleaved.push(v6Entry);
      }
    } else {
      if (v6Entry !== undefined) {
        interleaved.push(v6Entry);
      }
      if (v4Entry !== undefined) {
        interleaved.push(v4Entry);
      }
    }
  }

  return interleaved;
}

// Note: `nodeLookup` has a complicated type due to compatibility requirements.
export const electronLookup = lookupAll as typeof nodeLookup;
