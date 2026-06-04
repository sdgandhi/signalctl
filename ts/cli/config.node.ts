// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { hostname, homedir, release, version as osVersion } from 'node:os';
import { resolve } from 'node:path';

import defaultConfig from '../../config/default.json';
import productionConfig from '../../config/production.json';
import stagingConfig from '../../config/staging.json';
import packageJson from '../../package.json';
import { Environment, setEnvironment } from '../environment.std.ts';
import { HourCyclePreference } from '../types/I18N.std.ts';
import type { RendererConfigType } from '../types/RendererConfig.std.ts';

import type { CliProfile } from './profile.node.ts';

export type CliEnvironmentName = 'production' | 'staging';

type RawConfig = typeof defaultConfig & Partial<typeof productionConfig>;
type RawConfigOverlay = Partial<typeof defaultConfig> & {
  cdn?: Partial<typeof defaultConfig.cdn>;
};

let configuredEnvironment: Environment | undefined;

function toEnvironment(name: CliEnvironmentName): Environment {
  return name === 'production' ? Environment.PackagedApp : Environment.Staging;
}

export function configureCliEnvironment(name: CliEnvironmentName): Environment {
  const environment = toEnvironment(name);

  if (configuredEnvironment !== undefined) {
    return configuredEnvironment;
  }

  try {
    setEnvironment(environment, false);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes('Environment has already been set')
    ) {
      throw error;
    }
  }

  configuredEnvironment = environment;
  return environment;
}

function mergeRawConfig(name: CliEnvironmentName): RawConfig {
  const overlay = (
    name === 'production' ? productionConfig : stagingConfig
  ) as RawConfigOverlay;
  return {
    ...defaultConfig,
    ...overlay,
    cdn: {
      ...defaultConfig.cdn,
      ...overlay.cdn,
    },
  };
}

export function createRendererConfig({
  environmentName,
  profile,
}: Readonly<{
  environmentName: CliEnvironmentName;
  profile: CliProfile;
}>): RendererConfigType {
  const rawConfig = mergeRawConfig(environmentName);
  const environment = configureCliEnvironment(environmentName);

  return {
    appInstance: undefined,
    appStartInitialSpellcheckSetting: false,
    argv: JSON.stringify(process.argv),
    availableLocales: ['en'],
    backupServerPublicParams: rawConfig.backupServerPublicParams,
    buildCreation: rawConfig.buildCreation,
    buildExpiration: rawConfig.buildExpiration,
    cdnUrl0: rawConfig.cdn['0'],
    cdnUrl2: rawConfig.cdn['2'],
    cdnUrl3: rawConfig.cdn['3'],
    certificateAuthority: rawConfig.certificateAuthority,
    challengeUrl: rawConfig.challengeUrl,
    ciForceUnprocessed: rawConfig.ciForceUnprocessed,
    ciMode: false,
    contentProxyUrl: rawConfig.contentProxyUrl,
    crashDumpsPath: resolve(profile.userDataPath, 'crashDumps'),
    devTools: false,
    directoryConfig: {
      directoryMRENCLAVE: rawConfig.directoryMRENCLAVE,
      directoryUrl: rawConfig.directoryUrl,
    },
    disableIPv6: false,
    disableScreenSecurity: true,
    dnsFallback: [],
    environment,
    genericServerPublicParams: rawConfig.genericServerPublicParams,
    homePath: homedir(),
    hostname: hostname(),
    hourCyclePreference: HourCyclePreference.UnknownPreference,
    installPath: process.cwd(),
    isMainWindowFullScreen: false,
    isMainWindowMaximized: false,
    isMockTestEnvironment: false,
    localeOverride: null,
    name: 'signalctl',
    nodeVersion: process.versions.node,
    osRelease: release(),
    osVersion: osVersion(),
    preferredSystemLocales: ['en-US'],
    proxyUrl: process.env.HTTPS_PROXY || process.env.https_proxy || undefined,
    reducedMotionSetting: true,
    registrationChallengeUrl: rawConfig.registrationChallengeUrl,
    resolvedTranslationsLocale: 'en',
    resolvedTranslationsLocaleDirection: 'ltr',
    resourcesUrl: rawConfig.resourcesUrl,
    serverPublicParams: rawConfig.serverPublicParams,
    serverTrustRoots: rawConfig.serverTrustRoots,
    serverUrl: rawConfig.serverUrl,
    sfuUrl: rawConfig.sfuUrl,
    storageUrl: rawConfig.storageUrl,
    stripePublishableKey: rawConfig.stripePublishableKey,
    theme: 'system',
    updatesUrl: rawConfig.updatesUrl,
    userDataPath: profile.userDataPath,
    version: packageJson.version,
  };
}
