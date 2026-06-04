// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

function matchURLPatternPart(
  pattern: string | undefined,
  value: string
): Record<string, string | undefined> | null {
  if (pattern == null) {
    return {};
  }

  if (pattern === '') {
    return value === '' ? {} : null;
  }

  if (pattern === '{/}?') {
    return value === '' || value === '/' ? {} : null;
  }

  if (pattern.endsWith('{/}?')) {
    const prefix = pattern.slice(0, -'{/}?'.length);
    return value === prefix || value === `${prefix}/` ? {} : null;
  }

  if (pattern === ':params') {
    return value ? { params: value } : null;
  }

  if (pattern === ':captchaId(.+)') {
    return value ? { captchaId: value } : null;
  }

  if (pattern === ':inviteCode([^\\/]+)') {
    return value && !value.includes('/') ? { inviteCode: value } : null;
  }

  if (pattern === 'p/:phoneNumber') {
    return value.startsWith('p/')
      ? { phoneNumber: value.slice('p/'.length) }
      : null;
  }

  if (pattern === 'eu/:encryptedUsername') {
    return value.startsWith('eu/')
      ? { encryptedUsername: value.slice('eu/'.length) }
      : null;
  }

  if (pattern.startsWith('action=') && pattern.endsWith(':params*')) {
    const prefix = pattern.slice(0, -':params*'.length);
    return value.startsWith(prefix)
      ? { params: value.slice(prefix.length) }
      : null;
  }

  return pattern === value ? {} : null;
}

function createURLPatternComponentResult(
  groups: Record<string, string | undefined>,
  input: string
): URLPatternComponentResult {
  return { groups, input };
}

export function installURLPatternFallback(): void {
  const globalWithURLPattern = globalThis as unknown as {
    URLPattern?: typeof URLPattern;
  };
  if (globalWithURLPattern.URLPattern != null) {
    return;
  }

  class HeadlessURLPattern {
    readonly #init: URLPatternInit;

    constructor(init: URLPatternInit) {
      this.#init = init;
    }

    exec(input: URL | string): URLPatternResult | null {
      const url = input instanceof URL ? input : new URL(input);
      const searchInput = url.search.startsWith('?')
        ? url.search.slice(1)
        : url.search;
      const hashInput = url.hash.startsWith('#') ? url.hash.slice(1) : url.hash;

      const hostnameGroups = matchURLPatternPart(
        this.#init.hostname,
        url.hostname
      );
      const pathnameGroups = matchURLPatternPart(
        this.#init.pathname,
        url.pathname
      );
      const searchGroups = matchURLPatternPart(this.#init.search, searchInput);
      const hashGroups = matchURLPatternPart(this.#init.hash, hashInput);

      if (
        hostnameGroups == null ||
        pathnameGroups == null ||
        searchGroups == null ||
        hashGroups == null
      ) {
        return null;
      }

      return {
        hash: createURLPatternComponentResult(hashGroups, hashInput),
        hostname: createURLPatternComponentResult(hostnameGroups, url.hostname),
        inputs: [input],
        password: createURLPatternComponentResult({}, ''),
        pathname: createURLPatternComponentResult(pathnameGroups, url.pathname),
        port: createURLPatternComponentResult({}, ''),
        protocol: createURLPatternComponentResult({}, url.protocol),
        search: createURLPatternComponentResult(searchGroups, searchInput),
        username: createURLPatternComponentResult({}, ''),
      };
    }
  }

  globalWithURLPattern.URLPattern =
    HeadlessURLPattern as unknown as typeof URLPattern;
}

installURLPatternFallback();
