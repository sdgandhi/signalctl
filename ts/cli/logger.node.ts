// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { LoggerType } from '../types/Logging.std.ts';

const noop = (): void => undefined;

export const silentLogger: LoggerType = {
  fatal: noop,
  error: noop,
  warn: noop,
  info: noop,
  debug: noop,
  trace: noop,
  child: () => silentLogger,
};
