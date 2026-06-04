#!/usr/bin/env node
// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import './urlPatternFallback.node.ts';

import packageJson from '../../package.json';

process.setSourceMapsEnabled?.(true);

import { parseCliArgs, type CliCommand } from './args.node.ts';
import { CliError, getErrorResponse, getExitCode } from './errors.node.ts';
import { getHelpText } from './help.node.ts';
import { linkDeviceCommand } from './linkCommand.node.ts';
import { ok } from './output.node.ts';
import { resolveProfile } from './profile.node.ts';
import {
  getConversation,
  listConversations,
  listMessages,
  searchMessages,
} from './readCommands.node.ts';
import { sendMessageCommand } from './sendCommand.node.ts';
import { withCliSql } from './sql.node.ts';
import { syncCommand } from './syncCommand.node.ts';

function shouldCaptureBackgroundErrors(command: CliCommand): boolean {
  return (
    command.kind === 'daemon' ||
    command.kind === 'link' ||
    command.kind === 'send' ||
    command.kind === 'sync'
  );
}

async function runCommandWithBackgroundErrorCapture(
  command: CliCommand
): Promise<unknown> {
  const backgroundErrors = new Array<unknown>();
  const onBackgroundError = (error: unknown): void => {
    backgroundErrors.push(error);
  };

  process.on('unhandledRejection', onBackgroundError);
  process.on('uncaughtException', onBackgroundError);

  try {
    const result = await runCommand(command);

    if (backgroundErrors.length) {
      throw backgroundErrors[0];
    }

    return result;
  } finally {
    process.off('unhandledRejection', onBackgroundError);
    process.off('uncaughtException', onBackgroundError);
  }
}

async function runCommand(command: CliCommand): Promise<unknown> {
  switch (command.kind) {
    case 'help':
      return getHelpText();
    case 'version':
      return ok({ version: packageJson.version });
    case 'profile-info': {
      const profile = resolveProfile(command.profileOptions);
      return ok({
        profile: {
          name: profile.name,
          userDataPath: profile.userDataPath,
          configPath: profile.configPath,
          environment: command.profileOptions.environmentName,
        },
      });
    }
    case 'conversations-list': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await withCliSql(profile, context =>
          listConversations(context, {
            includeArchived: command.includeArchived,
            limit: command.limit,
          })
        )
      );
    }
    case 'conversations-get': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await withCliSql(profile, context =>
          getConversation(context, command.conversation)
        )
      );
    }
    case 'messages-list': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await withCliSql(profile, context =>
          listMessages(context, {
            before: command.before,
            conversation: command.conversation,
            limit: command.limit,
          })
        )
      );
    }
    case 'messages-search': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await withCliSql(profile, context =>
          searchMessages(context, {
            conversation: command.conversation,
            limit: command.limit,
            query: command.query,
          })
        )
      );
    }
    case 'link': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await linkDeviceCommand({
          deleteExistingData: command.deleteExistingData,
          deviceName: command.deviceName,
          environmentName: command.profileOptions.environmentName,
          profile,
          qr: command.qr,
        })
      );
    }
    case 'daemon': {
      const profile = resolveProfile(command.profileOptions);
      const { daemonCommand } = await import('./daemonCommand.node.ts');
      return ok(
        await daemonCommand({
          environmentName: command.profileOptions.environmentName,
          profile,
        })
      );
    }
    case 'sync': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await syncCommand({
          environmentName: command.profileOptions.environmentName,
          profile,
        })
      );
    }
    case 'send': {
      const profile = resolveProfile(command.profileOptions);
      return ok(
        await sendMessageCommand({
          attachments: command.attachments,
          conversation: command.conversation,
          environmentName: command.profileOptions.environmentName,
          message: command.message,
          profile,
          wait: command.wait,
        })
      );
    }
    default:
      throw new CliError('unknown_command', 'Unknown signalctl command', {
        exitCode: 2,
      });
  }
}

function formatJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

function writeFinalOutputAndExit(text: string, exitCode: number): void {
  process.stdout.write(`${text}\n`, () => {
    process.exit(exitCode);
  });
}

async function main(): Promise<void> {
  let exitCode = 0;
  let output: string;

  try {
    const command = parseCliArgs(process.argv.slice(2));
    const result = shouldCaptureBackgroundErrors(command)
      ? await runCommandWithBackgroundErrorCapture(command)
      : await runCommand(command);
    if (command.kind === 'help') {
      output = String(result);
    } else {
      output = formatJson(result);
    }
  } catch (error) {
    output = formatJson(getErrorResponse(error));
    exitCode = getExitCode(error);
  }

  writeFinalOutputAndExit(output, exitCode);
}

void main();
