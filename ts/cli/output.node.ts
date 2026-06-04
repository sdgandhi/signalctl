// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export function writeJson(data: unknown): void {
  // oxlint-disable-next-line no-console
  console.log(JSON.stringify(data, null, 2));
}

export function writeJsonLine(data: unknown): void {
  // oxlint-disable-next-line no-console
  console.log(JSON.stringify(data));
}

export function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}
