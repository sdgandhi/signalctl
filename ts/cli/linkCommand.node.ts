// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { hostname } from 'node:os';

import type { CliEnvironmentName } from './config.node.ts';
import { CliError } from './errors.node.ts';
import { withHeadlessRuntime } from './headlessRuntime.node.ts';
import { resetProfileData, type CliProfile } from './profile.node.ts';
import { TerminalQrWriter } from './terminalQr.node.ts';

const LINK_TIMEOUT_MS = 10 * 60 * 1000;

type LinkDeviceResult = Readonly<{
  deviceId: number | undefined;
  deviceName: string;
  number: string | undefined;
  aci: string | undefined;
  pni: string | undefined;
}>;

export async function linkDeviceCommand({
  deleteExistingData,
  deviceName,
  environmentName,
  profile,
  qr,
}: Readonly<{
  deleteExistingData: boolean;
  deviceName?: string;
  environmentName: CliEnvironmentName;
  profile: CliProfile;
  qr: boolean;
}>): Promise<LinkDeviceResult> {
  if (deleteExistingData) {
    await resetProfileData(profile);
  }

  return withHeadlessRuntime({ environmentName, profile }, async runtime => {
    if (runtime.itemStorage.user.getNumber() && !deleteExistingData) {
      throw new CliError(
        'profile_already_linked',
        'CLI profile is already linked; pass --delete-existing-data to relink',
        { exitCode: 4 }
      );
    }

    const [webApi, provisionerModule, accountManagerModule] = await Promise.all(
      [
        import('../textsecure/WebAPI.preload.ts'),
        import('../textsecure/Provisioner.preload.ts'),
        import('../textsecure/AccountManager.preload.ts'),
      ]
    );

    const resolvedDeviceName =
      deviceName ?? `${hostname() || 'headless'} signalctl`;
    const provisioner = new provisionerModule.Provisioner({ server: webApi });
    const qrWriter = new TerminalQrWriter();

    return new Promise((resolvePromise, rejectPromise) => {
      let unsubscribe: (() => void) | undefined;
      const timeout = setTimeout(() => {
        unsubscribe?.();
        rejectPromise(
          new CliError(
            'link_timeout',
            'Timed out waiting for phone link scan',
            {
              exitCode: 5,
            }
          )
        );
      }, LINK_TIMEOUT_MS);

      const finish = (fn: () => Promise<LinkDeviceResult>): void => {
        clearTimeout(timeout);
        unsubscribe?.();
        fn().then(resolvePromise, rejectPromise);
      };

      unsubscribe = provisioner.subscribe(event => {
        if (event.kind === provisionerModule.EventKind.URL) {
          if (qr) {
            qrWriter.write(event.url);
          }
          return;
        }

        if (event.kind === provisionerModule.EventKind.Envelope) {
          finish(async () => {
            const linkData = provisionerModule.Provisioner.prepareLinkData({
              deviceName: resolvedDeviceName,
              envelope: event.envelope,
            });
            await accountManagerModule.accountManager.registerSecondDevice(
              linkData
            );
            await runtime.itemStorage.put(
              'postRegistrationSyncsStatus',
              'incomplete'
            );
            await Promise.all([
              runtime.itemStorage.put('chromiumRegistrationDone', ''),
              runtime.itemStorage.put('chromiumRegistrationDoneEver', ''),
            ]);

            return {
              aci: runtime.itemStorage.user.getAci(),
              deviceId: runtime.itemStorage.user.getDeviceId(),
              deviceName: linkData.deviceName,
              number: runtime.itemStorage.user.getNumber(),
              pni: runtime.itemStorage.user.getPni(),
            };
          });
          return;
        }

        if (event.kind === provisionerModule.EventKind.MaxRotationsError) {
          finish(async () => {
            throw new CliError(
              'link_max_rotations',
              'Timed out after rotating the link QR code too many times',
              { exitCode: 5 }
            );
          });
          return;
        }

        if (event.kind === provisionerModule.EventKind.TimeoutError) {
          finish(async () => {
            throw new CliError(
              'link_timeout',
              'Timed out waiting for link QR',
              {
                exitCode: 5,
                details: { canRetry: event.canRetry },
              }
            );
          });
          return;
        }

        if (
          event.kind === provisionerModule.EventKind.ConnectError ||
          event.kind === provisionerModule.EventKind.EnvelopeError
        ) {
          finish(async () => {
            throw new CliError('link_failed', event.error.message, {
              exitCode: 5,
            });
          });
        }
      });
    });
  });
}
