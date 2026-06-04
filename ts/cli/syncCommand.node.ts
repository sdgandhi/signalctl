// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { downloadAndImportPendingBackup } from './backupImport.node.ts';
import type { CliEnvironmentName } from './config.node.ts';
import { CliError } from './errors.node.ts';
import { withHeadlessRuntime } from './headlessRuntime.node.ts';
import type { CliProfile } from './profile.node.ts';

export async function syncCommand({
  environmentName,
  profile,
}: Readonly<{
  environmentName: CliEnvironmentName;
  profile: CliProfile;
}>): Promise<{
  backup: Awaited<ReturnType<typeof downloadAndImportPendingBackup>>;
}> {
  return withHeadlessRuntime({ environmentName, profile }, async runtime => {
    const credentials = runtime.itemStorage.user.getWebAPICredentials();
    if (!credentials.username || !credentials.password) {
      throw new CliError('profile_not_linked', 'CLI profile is not linked', {
        exitCode: 4,
      });
    }

    const webApi = await import('../textsecure/WebAPI.preload.ts');
    await webApi.connect({
      ...credentials,
      hasBuildExpired: false,
      hasStoriesDisabled: runtime.itemStorage.get('hasStoriesDisabled', false),
    });

    let backup: Awaited<ReturnType<typeof downloadAndImportPendingBackup>>;
    try {
      backup = await downloadAndImportPendingBackup(runtime);
    } finally {
      await webApi.logout();
    }

    return { backup };
  });
}
