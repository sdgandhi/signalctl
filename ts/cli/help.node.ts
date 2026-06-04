// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

export function getHelpText(): string {
  return [
    'signalctl',
    '',
    'JSON-first Signal CLI for agents.',
    '',
    'Commands:',
    '  signalctl profile info [--profile NAME|--data-dir PATH]',
    '  signalctl link [--device-name NAME] [--delete-existing-data]',
    '  signalctl sync',
    '  signalctl daemon',
    '  signalctl conversations list [--limit N] [--include-archived]',
    '  signalctl conversations get <conversation>',
    '  signalctl messages list <conversation> [--limit N] [--before MESSAGE_ID]',
    '  signalctl messages search <query> [--limit N]',
    '  signalctl send <conversation> --message TEXT [--attach PATH...]',
    '',
    'Global options:',
    '  --profile NAME     Use a named CLI profile',
    '  --data-dir PATH    Use an explicit CLI profile directory',
    '  --environment NAME Use production or staging; defaults to production',
    '',
    'Output:',
    '  All non-help commands print JSON.',
  ].join('\n');
}
