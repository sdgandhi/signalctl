// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import qrcode from 'qrcode-generator';

const AUTODETECT_TYPE_NUMBER = 0;
const ERROR_CORRECTION_LEVEL = 'M';
const QUIET_ZONE = 2;

function moduleAt(
  qr: ReturnType<typeof qrcode>,
  row: number,
  column: number
): boolean {
  if (
    row < 0 ||
    column < 0 ||
    row >= qr.getModuleCount() ||
    column >= qr.getModuleCount()
  ) {
    return false;
  }

  return qr.isDark(row, column);
}

export function renderTerminalQr(value: string): string {
  const qr = qrcode(AUTODETECT_TYPE_NUMBER, ERROR_CORRECTION_LEVEL);
  qr.addData(value);
  qr.make();

  const size = qr.getModuleCount();
  const lines = new Array<string>();
  for (let row = -QUIET_ZONE; row < size + QUIET_ZONE; row += 1) {
    let line = '';
    for (let column = -QUIET_ZONE; column < size + QUIET_ZONE; column += 1) {
      line += moduleAt(qr, row, column) ? '██' : '  ';
    }
    lines.push(line);
  }

  return lines.join('\n');
}

export function writeTerminalQr(value: string): void {
  process.stderr.write(`${renderTerminalQr(value)}\n${value}\n`);
}

export class TerminalQrWriter {
  #lastValue: string | undefined;
  #lineCount = 0;

  write(value: string): void {
    if (value === this.#lastValue) {
      return;
    }

    if (this.#lastValue && !process.stderr.isTTY) {
      return;
    }

    const block = `${renderTerminalQr(value)}\n${value}\n`;
    if (this.#lastValue && this.#lineCount > 0) {
      process.stderr.write(`\x1b[${this.#lineCount}A\x1b[J`);
    }

    process.stderr.write(block);
    this.#lastValue = value;
    this.#lineCount = block.split('\n').length - 1;
  }
}
