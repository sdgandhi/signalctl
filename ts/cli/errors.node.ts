// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export class CliError extends Error {
  public readonly code: string;
  public readonly exitCode: number;
  public readonly details: unknown;

  constructor(
    code: string,
    message: string,
    { exitCode = 1, details }: { exitCode?: number; details?: unknown } = {}
  ) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

function getErrorCause(error: Error): unknown {
  return (error as Error & { cause?: unknown }).cause;
}

function getErrorCauseMessage(cause: unknown): string | undefined {
  if (cause === undefined) {
    return undefined;
  }

  if (cause instanceof Error) {
    return cause.message || cause.name;
  }

  return String(cause);
}

function getErrorCauseStack(cause: unknown): string | undefined {
  if (cause instanceof Error) {
    return cause.stack;
  }

  return undefined;
}

export function getErrorResponse(error: unknown): {
  ok: false;
  error: { code: string; message: string; details?: unknown };
} {
  if (error instanceof CliError) {
    return {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    };
  }

  if (error instanceof Error) {
    const cause = getErrorCause(error);
    const causeMessage = getErrorCauseMessage(cause);
    const causeStack = getErrorCauseStack(cause);
    return {
      ok: false,
      error: {
        code: 'internal_error',
        message: causeMessage
          ? `${error.message}: ${causeMessage}`
          : error.message,
        ...(causeMessage === undefined
          ? {}
          : {
              details: {
                cause: causeMessage,
                ...(causeStack === undefined ? {} : { causeStack }),
              },
            }),
      },
    };
  }

  return {
    ok: false,
    error: {
      code: 'internal_error',
      message: String(error),
    },
  };
}

export function getExitCode(error: unknown): number {
  if (error instanceof CliError) {
    return error.exitCode;
  }

  return 1;
}
