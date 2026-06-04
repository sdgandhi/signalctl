// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { HeadlessRuntime } from './headlessRuntime.node.ts';

export type BackupImportResult = Readonly<{
  hadPendingBackup: boolean;
  wasBackupImported: boolean;
}>;

export async function downloadAndImportPendingBackup(
  runtime: HeadlessRuntime
): Promise<BackupImportResult> {
  const backupDownloadPath = runtime.itemStorage.get('backupDownloadPath');
  if (!backupDownloadPath) {
    return {
      hadPendingBackup: false,
      wasBackupImported: false,
    };
  }

  const { backupsService } =
    await import('../services/backups/index.preload.ts');
  const { wasBackupImported } = await backupsService.downloadAndImport({});

  await runtime.itemStorage.fetch();
  runtime.conversationController.reset();
  await runtime.conversationController.load();

  return {
    hadPendingBackup: true,
    wasBackupImported,
  };
}
