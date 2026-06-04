// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import EventEmitter from 'node:events';

import { Bytes } from '../context/Bytes.std.ts';
import { Crypto } from '../context/Crypto.node.ts';
import { Timers } from '../context/Timers.node.ts';
import {
  HourCyclePreference,
  type LocaleMessagesType,
} from '../types/I18N.std.ts';
import {
  SystemThemeType,
  ThemeType,
  type LocalizerType,
} from '../types/Util.std.ts';
import { SocketStatus } from '../types/SocketStatus.std.ts';
import type { ConversationController } from '../ConversationController.preload.ts';
import type { MessageCache } from '../services/MessageCache.preload.ts';

import {
  createRendererConfig,
  type CliEnvironmentName,
} from './config.node.ts';
import type { CliProfile } from './profile.node.ts';
import { withCliSql } from './sql.node.ts';
import './urlPatternFallback.node.ts';

type HeadlessWindow = Record<PropertyKey, unknown>;

type HeadlessRuntimeOptions = Readonly<{
  drainAfterReturnMs?: number;
  shutdownNetworkAfterReturn?: boolean;
}>;

export type HeadlessRuntime = Readonly<{
  conversationController: ConversationController;
  itemStorage: typeof import('../textsecure/Storage.preload.ts').itemStorage;
  messageCache: MessageCache;
  signalProtocolStore: typeof import('../SignalProtocolStore.preload.ts').signalProtocolStore;
}>;

const localeMessages: LocaleMessagesType = {};
const DEFAULT_DRAIN_AFTER_RETURN_MS = 0;
const DEFAULT_SHUTDOWN_MAX_MS = 8000;
const DEFAULT_SHUTDOWN_QUIET_MS = 3000;

const i18n = Object.assign((key: string) => key, {
  getHourCyclePreference: () => HourCyclePreference.UnknownPreference,
  getIntl: () => {
    throw new Error('Intl is not available in signalctl');
  },
  getLocale: () => 'en',
  getLocaleDirection: () => 'ltr' as const,
  getLocaleMessages: () => localeMessages,
  stopTrackingUsage: () => [],
  trackUsage: () => undefined,
}) as unknown as LocalizerType;

const noop = (): void => undefined;

class HeadlessNode {}

class HeadlessElement extends HeadlessNode {
  public activeElement: unknown;
  public readonly attributes = new Map<string, string>();
  public readonly children = new Array<unknown>();
  public readonly classList = createHeadlessClassList();
  public readonly dataset: Record<string, string> = {};
  public readonly nodeName: string;
  public readonly style = createHeadlessStyle();
  public checked = false;
  public disabled = false;
  public hidden = false;
  public id = '';
  public innerHTML = '';
  public parentNode: unknown = null;
  public textContent = '';
  public value = '';

  public constructor(public readonly tagName = 'div') {
    super();
    this.nodeName = tagName.toUpperCase();
  }

  public addEventListener(): void {
    // DOM events are inert in signalctl headless mode.
  }

  public append(...children: Array<unknown>): void {
    for (const child of children) {
      this.appendChild(child);
    }
  }

  public appendChild<T>(child: T): T {
    if (child && typeof child === 'object') {
      Object.assign(child, { parentNode: this });
    }
    this.children.push(child);
    return child;
  }

  public blur(): void {
    // No focused element exists in headless mode.
  }

  public click(): void {
    // No UI exists in headless mode.
  }

  public contains(child: unknown): boolean {
    return child === this || this.children.includes(child);
  }

  public focus(): void {
    // No focused element exists in headless mode.
  }

  public getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  public prepend(...children: Array<unknown>): void {
    for (const child of [...children].reverse()) {
      if (child && typeof child === 'object') {
        Object.assign(child, { parentNode: this });
      }
      this.children.unshift(child);
    }
  }

  public querySelector(): null {
    return null;
  }

  public querySelectorAll(): Array<unknown> {
    return [];
  }

  public remove(): void {
    const parent = this.parentNode as HeadlessElement | null;
    parent?.removeChild(this);
  }

  public removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  public removeChild<T>(child: T): T {
    const index = this.children.indexOf(child);
    if (index >= 0) {
      this.children.splice(index, 1);
    }
    if (child && typeof child === 'object') {
      Object.assign(child, { parentNode: null });
    }
    return child;
  }

  public removeEventListener(): void {
    // DOM events are inert in signalctl headless mode.
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === 'id') {
      this.id = value;
    }
  }
}

class HeadlessHTMLElement extends HeadlessElement {}

class HeadlessHTMLCanvasElement extends HeadlessHTMLElement {
  public constructor() {
    super('canvas');
  }

  public getContext(): null {
    return null;
  }

  public toBlob(callback: (blob: Blob | null) => void): void {
    callback(null);
  }

  public toDataURL(): string {
    return 'data:,';
  }
}

class HeadlessImage extends HeadlessHTMLElement {
  public complete = false;
  public height = 0;
  public naturalHeight = 0;
  public naturalWidth = 0;
  public onerror: ((event: unknown) => unknown) | null = null;
  public onload: ((event: unknown) => unknown) | null = null;
  public width = 0;

  #src = '';

  public constructor() {
    super('img');
  }

  public get src(): string {
    return this.#src;
  }

  public set src(value: string) {
    this.#src = value;
    const EventCtor = (globalThis.Event ?? HeadlessEvent) as new (
      type: string
    ) => unknown;
    setImmediate(() => this.onerror?.(new EventCtor('error')));
  }

  public decode(): Promise<void> {
    return Promise.reject(
      new Error('Images are unavailable in signalctl headless mode')
    );
  }
}

class HeadlessEvent {
  public bubbles = false;
  public cancelable = false;
  public currentTarget: unknown = null;
  public defaultPrevented = false;
  public eventPhase = 0;
  public isTrusted = false;
  public returnValue = true;
  public target: unknown = null;
  public timeStamp = Date.now();

  public constructor(
    public readonly type: string,
    init: Readonly<{ bubbles?: boolean; cancelable?: boolean }> = {}
  ) {
    this.bubbles = Boolean(init.bubbles);
    this.cancelable = Boolean(init.cancelable);
  }

  public composedPath(): Array<unknown> {
    return [];
  }

  public initEvent(): void {
    // Deprecated browser API; present for compatibility.
  }

  public preventDefault(): void {
    if (this.cancelable) {
      this.defaultPrevented = true;
    }
  }

  public stopImmediatePropagation(): void {
    // DOM events are inert in signalctl headless mode.
  }

  public stopPropagation(): void {
    // DOM events are inert in signalctl headless mode.
  }
}

class HeadlessCustomEvent extends HeadlessEvent {
  public readonly detail: unknown;

  public constructor(
    type: string,
    init: Readonly<{
      bubbles?: boolean;
      cancelable?: boolean;
      detail?: unknown;
    }> = {}
  ) {
    super(type, init);
    this.detail = init.detail;
  }
}

class HeadlessFileReader {
  public error: Error | null = null;
  public onerror: ((event: unknown) => unknown) | null = null;
  public onload: ((event: unknown) => unknown) | null = null;
  public onloadend: ((event: unknown) => unknown) | null = null;
  public result: ArrayBuffer | string | null = null;

  public abort(): void {
    // No async read is in progress in headless mode.
  }

  public addEventListener(type: string, listener: (event: unknown) => unknown) {
    if (type === 'error') {
      this.onerror = listener;
    } else if (type === 'load') {
      this.onload = listener;
    } else if (type === 'loadend') {
      this.onloadend = listener;
    }
  }

  public readAsArrayBuffer(): void {
    this.#fail();
  }

  public readAsDataURL(): void {
    this.#fail();
  }

  public readAsText(): void {
    this.#fail();
  }

  #fail(): void {
    this.error = new Error('FileReader is unavailable in signalctl headless mode');
    const EventCtor = (globalThis.Event ?? HeadlessEvent) as new (
      type: string
    ) => unknown;
    const event = new EventCtor('error');
    this.onerror?.(event);
    this.onloadend?.(new EventCtor('loadend'));
  }
}

function createHeadlessClassList(): DOMTokenList {
  const tokens = new Set<string>();
  return {
    add: (...values: Array<string>) => {
      values.forEach(value => tokens.add(value));
    },
    contains: (value: string) => tokens.has(value),
    remove: (...values: Array<string>) => {
      values.forEach(value => tokens.delete(value));
    },
    toggle: (value: string, force?: boolean) => {
      if (force === true) {
        tokens.add(value);
        return true;
      }
      if (force === false) {
        tokens.delete(value);
        return false;
      }
      if (tokens.has(value)) {
        tokens.delete(value);
        return false;
      }
      tokens.add(value);
      return true;
    },
    toString: () => [...tokens].join(' '),
  } as unknown as DOMTokenList;
}

function createHeadlessStyle(): CSSStyleDeclaration {
  const values = new Map<string, string>();
  return new Proxy(
    {
      getPropertyValue: (property: string) => values.get(property) ?? '',
      removeProperty: (property: string) => {
        const value = values.get(property) ?? '';
        values.delete(property);
        return value;
      },
      setProperty: (property: string, value: string) => {
        values.set(property, value);
      },
    } as Record<PropertyKey, unknown>,
    {
      get(target, property) {
        if (property in target) {
          return Reflect.get(target, property);
        }
        if (typeof property === 'string') {
          return values.get(property) ?? '';
        }
        return undefined;
      },
      set(target, property, value) {
        if (typeof property === 'string') {
          values.set(property, String(value));
          return true;
        }
        return Reflect.set(target, property, value);
      },
    }
  ) as unknown as CSSStyleDeclaration;
}

function createHeadlessElement(tagName: string): HeadlessHTMLElement {
  if (tagName.toLowerCase() === 'canvas') {
    return new HeadlessHTMLCanvasElement();
  }
  if (tagName.toLowerCase() === 'img') {
    return new HeadlessImage();
  }
  return new HeadlessHTMLElement(tagName);
}

function createHeadlessLocation(): Location {
  const location = {
    hash: '',
    host: '',
    hostname: '',
    href: 'signalctl://headless/',
    origin: 'signalctl://headless',
    pathname: '/',
    port: '',
    protocol: 'signalctl:',
    search: '',
    assign(value: string) {
      this.href = String(value);
    },
    reload: noop,
    replace(value: string) {
      this.href = String(value);
    },
    toString() {
      return this.href;
    },
  };
  return location as unknown as Location;
}

function createHeadlessDocument(location: Location): Document {
  const documentElement = createHeadlessElement('html');
  const body = createHeadlessElement('body');
  documentElement.appendChild(body);

  return {
    activeElement: body,
    addEventListener: noop,
    body,
    createElement: (tagName: string) => createHeadlessElement(tagName),
    documentElement,
    getElementById: () => null,
    location,
    querySelector: () => null,
    querySelectorAll: () => [] as unknown as NodeListOf<Element>,
    readyState: 'complete',
    removeEventListener: noop,
    title: 'signalctl',
  } as unknown as Document;
}

function createHeadlessNavigator(): Navigator {
  return {
    clipboard: {
      readText: async () => '',
      writeText: async () => undefined,
    },
    mediaDevices: {
      enumerateDevices: async () => [],
      getDisplayMedia: async () => {
        throw new Error('Display media is unavailable in signalctl headless mode');
      },
      getUserMedia: async () => {
        throw new Error('User media is unavailable in signalctl headless mode');
      },
    },
    onLine: true,
    platform: process.platform,
    userAgent: `signalctl/${process.version}`,
  } as unknown as Navigator;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(/[.-]/);
  const rightParts = right.split(/[.-]/);
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      continue;
    }

    const lexical = leftPart.localeCompare(rightPart);
    if (lexical !== 0) {
      return lexical;
    }
  }

  return 0;
}

function defineGlobalFallback(
  name: string,
  value: unknown,
  { force = false }: Readonly<{ force?: boolean }> = {}
): void {
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  if (!force && globalRecord[name] != null) {
    return;
  }

  Object.defineProperty(globalThis, name, {
    configurable: true,
    enumerable: false,
    value,
    writable: true,
  });
}

function createHeadlessLocalStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => {
      values.delete(key);
    },
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

function createNoopProxy(): unknown {
  const fn = (): undefined => undefined;
  let proxy: unknown;
  proxy = new Proxy(fn, {
    apply() {
      return undefined;
    },
    get(target, prop) {
      if (prop === 'then') {
        return undefined;
      }

      if (prop in target) {
        return Reflect.get(target, prop);
      }

      return proxy;
    },
  });
  return proxy;
}

function getHeadlessWindow(): HeadlessWindow {
  const globalWithWindow = globalThis as unknown as {
    window?: HeadlessWindow;
  };
  globalWithWindow.window ??= {};
  return globalWithWindow.window;
}

function installHeadlessWindow({
  environmentName,
  profile,
}: Readonly<{
  environmentName: CliEnvironmentName;
  profile: CliProfile;
}>): void {
  process.env.SIGNALCTL_HEADLESS = '1';

  const config = createRendererConfig({ environmentName, profile });
  const windowObject = getHeadlessWindow();
  const eventsProxy = createNoopProxy();
  const ipcProxy = createNoopProxy();
  const reduxActionsProxy = createNoopProxy();
  const events = new EventEmitter();
  const location = createHeadlessLocation();
  const document = createHeadlessDocument(location);
  const navigator = createHeadlessNavigator();
  const localStorage = createHeadlessLocalStorage();
  let themeSetting = config.theme;
  let interactionMode: 'mouse' | 'keyboard' = 'mouse';
  let zoomFactor = 1;
  let spellCheck = true;
  let autoLaunch = false;
  let contentProtection = false;
  let systemTraySetting = false;
  let localeOverride: string | null = null;
  let mediaPermissions = false;
  let mediaCameraPermissions = false;
  type HeadlessReduxReducer = (state: unknown, action: unknown) => unknown;
  const reduxListeners = new Set<() => void>();
  let reduxReducer: HeadlessReduxReducer | undefined;
  let reduxState: unknown = {
    app: { hasInitialLoadCompleted: true },
    callHistory: {
      callHistoryByCallId: {},
      edition: 0,
      unreadCount: 0,
    },
    conversations: {
      messagesByConversation: {},
      verificationDataByConversation: {},
    },
    items: {},
    nav: {},
    notificationProfiles: { activeProfile: undefined },
  };

  Object.assign(windowObject, {
    CustomEvent: globalThis.CustomEvent ?? HeadlessCustomEvent,
    Element: HeadlessElement,
    Event: globalThis.Event ?? HeadlessEvent,
    Events: Object.assign(eventsProxy as object, {
      getAutoLaunch: async () => autoLaunch,
      getContentProtection: async () => contentProtection,
      getLocaleOverride: async () => localeOverride,
      getMediaCameraPermissions: async () => mediaCameraPermissions,
      getMediaPermissions: async () => mediaPermissions,
      getSpellCheck: async () => spellCheck,
      getSystemTraySetting: async () => systemTraySetting,
      getThemeSetting: async () => themeSetting,
      getZoomFactor: async () => zoomFactor,
      offZoomFactorChange: noop,
      onZoomFactorChange: noop,
      setAutoLaunch: async (value: boolean) => {
        autoLaunch = value;
      },
      setContentProtection: async (value: boolean) => {
        contentProtection = value;
      },
      setLocaleOverride: async (value: string | null) => {
        localeOverride = value;
      },
      setSpellCheck: async (value: boolean) => {
        spellCheck = value;
      },
      setSystemTraySetting: async (value: boolean) => {
        systemTraySetting = value;
      },
      setThemeSetting: async (value: typeof themeSetting) => {
        themeSetting = value;
      },
      setZoomFactor: async (value: number) => {
        zoomFactor = value;
      },
    }),
    File: globalThis.File,
    FileReader: globalThis.FileReader ?? HeadlessFileReader,
    Flags: {
      GV2_ENABLE_CHANGE_PROCESSING: true,
      GV2_ENABLE_PRE_JOIN_FETCH: true,
      GV2_ENABLE_SINGLE_CHANGE_PROCESSING: true,
      GV2_ENABLE_STATE_PROCESSING: true,
      GV2_MIGRATION_DISABLE_ADD: false,
      GV2_MIGRATION_DISABLE_INVITE: false,
    },
    HTMLCanvasElement: HeadlessHTMLCanvasElement,
    HTMLElement: HeadlessHTMLElement,
    Image: globalThis.Image ?? HeadlessImage,
    IPC: Object.assign(ipcProxy as object, {
      addSetupMenuItems: noop,
      closeCallDiagnostic: noop,
      closeDebugLog: noop,
      crashReports: {
        getCount: async () => 0,
      },
      getAutoLaunch: async () => autoLaunch,
      getMediaAccessStatus: async () => 'not-determined',
      getMediaCameraPermissions: async () => mediaCameraPermissions,
      getMediaPermissions: async () => mediaPermissions,
      openSystemMediaPermissions: noop,
      readyForUpdates: noop,
      removeSetupMenuItems: noop,
      setAutoHideMenuBar: noop,
      setAutoLaunch: async (value: boolean) => {
        autoLaunch = value;
      },
      setMediaCameraPermissions: async (value: boolean) => {
        mediaCameraPermissions = value;
      },
      setMediaPermissions: async (value: boolean) => {
        mediaPermissions = value;
      },
      setMenuBarVisibility: noop,
      showCallDiagnostic: noop,
      showDebugLog: noop,
      showPermissionsPopup: async () => undefined,
      shutdown: noop,
      startTrackingQueryStats: noop,
      stopTrackingQueryStats: noop,
      updateCallDiagnosticData: noop,
    }),
    Node: HeadlessNode,
    RETRY_DELAY: false,
    Signal: {
      OS: {
        isLinux: () => process.platform === 'linux',
        isMacOS: () => process.platform === 'darwin',
        isWindows: () => process.platform === 'win32',
      },
    },
    SignalClipboard: {
      clearIfNeeded: noop,
      copyTextTemporarily: noop,
    },
    SignalContext: {
      OS: {
        getClassName: () => process.platform,
        platform: process.platform,
        release: config.osRelease,
      },
      Settings: {
        themeSetting: {
          getValue: async () => themeSetting,
          setValue: async (value: typeof themeSetting) => {
            themeSetting = value;
            return themeSetting;
          },
        },
        waitForChange: async () => undefined,
      },
      activeWindowService: {
        isActive: () => false,
        registerForActive: noop,
        registerForChange: noop,
        unregisterForActive: noop,
        unregisterForChange: noop,
      },
      bytes: new Bytes(),
      config,
      crypto: new Crypto(),
      Emojify: undefined,
      executeMenuRole: async () => undefined,
      getAppInstance: () => config.appInstance,
      getCountryDisplayNames: () => ({}),
      getEnvironment: () => config.environment,
      getHourCyclePreference: () => config.hourCyclePreference,
      getI18nAvailableLocales: () => config.availableLocales,
      getI18nLocale: () => config.resolvedTranslationsLocale,
      getI18nLocaleMessages: () => localeMessages,
      getLocaleDisplayNames: () => ({}),
      getLocaleOverride: () => config.localeOverride,
      getLocalizedEmojiList: async () => [],
      getMainWindowStats: async () => ({
        isFullScreen: false,
        isMaximized: false,
      }),
      getMenuOptions: async () => ({}),
      getNodeVersion: () => config.nodeVersion,
      getPath: (name: 'userData' | 'home' | 'install') => {
        if (name === 'userData') {
          return profile.userDataPath;
        }
        if (name === 'home') {
          return config.homePath;
        }
        return config.installPath;
      },
      getPreferredSystemLocales: () => config.preferredSystemLocales,
      getResolvedMessagesLocale: () => config.resolvedTranslationsLocale,
      getResolvedMessagesLocaleDirection: () =>
        config.resolvedTranslationsLocaleDirection,
      getVersion: () => config.version,
      i18n,
      isTestOrMockEnvironment: () => config.isMockTestEnvironment,
      nativeThemeListener: {
        getSystemTheme: () => SystemThemeType.dark,
        subscribe: () => noop,
      },
      restartApp: noop,
      setIsCallActive: noop,
      timers: new Timers(),
    },
    Whisper: { events },
    alert: noop,
    addEventListener: noop,
    document,
    enterKeyboardMode: () => {
      interactionMode = 'keyboard';
    },
    enterMouseMode: () => {
      interactionMode = 'mouse';
    },
    getAppInstance: () => config.appInstance,
    getBackupServerPublicParams: () => config.backupServerPublicParams,
    getBuildCreation: () => config.buildCreation,
    getBuildExpiration: () => config.buildExpiration,
    getGenericServerPublicParams: () => config.genericServerPublicParams,
    getHostName: () => config.hostname,
    getIceServerOverride: () => '',
    getInteractionMode: () => interactionMode,
    getServerPublicParams: () => config.serverPublicParams,
    getServerTrustRoots: () => config.serverTrustRoots,
    getSfuUrl: () => config.sfuUrl,
    getSocketStatus: () => ({
      authenticated: { status: SocketStatus.CLOSED },
      unauthenticated: { status: SocketStatus.CLOSED },
    }),
    getTitle: () => 'signalctl',
    getVersion: () => config.version,
    initialTheme: ThemeType.dark,
    isAfterVersion: (version: string, anotherVersion: string) =>
      compareVersions(version, anotherVersion) > 0,
    isBeforeVersion: (version: string, anotherVersion: string) =>
      compareVersions(version, anotherVersion) < 0,
    location,
    localStorage,
    navigator,
    nodeSetImmediate: setImmediate,
    platform: process.platform,
    removeEventListener: noop,
    reduxActions: reduxActionsProxy,
    reduxStore: {
      dispatch: (action: unknown) => {
        if (reduxReducer) {
          reduxState = reduxReducer(reduxState, action);
        }
        for (const listener of reduxListeners) {
          listener();
        }
        return action;
      },
      getState: () => reduxState,
      replaceReducer: (reducer: HeadlessReduxReducer) => {
        reduxReducer = reducer;
      },
      subscribe: (listener: () => void) => {
        reduxListeners.add(listener);
        return () => {
          reduxListeners.delete(listener);
        };
      },
    },
    sendChallengeRequest: noop,
    setImmediate,
    systemTheme: SystemThemeType.dark,
    waitForEmptyEventQueue: async () => undefined,
  });

  const globalWithDom = globalThis as unknown as {
    Blob?: unknown;
    CustomEvent?: unknown;
    document?: unknown;
    Element?: unknown;
    Event?: unknown;
    File?: unknown;
    FileReader?: unknown;
    HTMLCanvasElement?: unknown;
    HTMLElement?: unknown;
    Image?: unknown;
    localStorage?: Storage;
    location?: unknown;
    navigator?: unknown;
    Node?: unknown;
  };
  globalWithDom.Blob ??= globalThis.Blob;
  globalWithDom.CustomEvent ??= windowObject.CustomEvent;
  globalWithDom.Element ??= HeadlessElement;
  globalWithDom.Event ??= windowObject.Event;
  globalWithDom.File ??= globalThis.File;
  globalWithDom.FileReader ??= windowObject.FileReader;
  globalWithDom.HTMLCanvasElement ??= HeadlessHTMLCanvasElement;
  globalWithDom.HTMLElement ??= HeadlessHTMLElement;
  globalWithDom.Image ??= windowObject.Image;
  globalWithDom.Node ??= HeadlessNode;
  globalWithDom.document ??= document;
  globalWithDom.location ??= location;
  globalWithDom.localStorage ??= localStorage;
  defineGlobalFallback('navigator', navigator, { force: true });
}

async function initializeHeadlessServices(
  storage: typeof import('../textsecure/Storage.preload.ts').itemStorage
): Promise<void> {
  const [
    { initialize: initializeExpiringMessageService },
    { initializeMessageCounter },
    { ourProfileKeyService },
    { senderCertificateService },
    webApi,
  ] = await Promise.all([
    import('../services/expiringMessagesDeletion.preload.ts'),
    import('../util/incrementMessageCounter.preload.ts'),
    import('../services/ourProfileKey.std.ts'),
    import('../services/senderCertificate.preload.ts'),
    import('../textsecure/WebAPI.preload.ts'),
  ]);
  const windowObject = getHeadlessWindow();
  const whisper = windowObject.Whisper as Readonly<{
    events: Parameters<typeof senderCertificateService.initialize>[0]['events'];
  }>;

  await initializeMessageCounter();
  initializeExpiringMessageService();
  ourProfileKeyService.initialize(storage);
  senderCertificateService.initialize({
    server: {
      getSenderCertificate: webApi.getSenderCertificate,
      isOnline: webApi.isOnline,
    },
    events: whisper.events,
    storage,
  });
}

async function shutdownHeadlessNetwork(): Promise<void> {
  const webApi = await import('../textsecure/WebAPI.preload.ts');
  await webApi.shutdown();
}

async function shutdownHeadlessServices(): Promise<void> {
  const [
    expiringMessagesDeletion,
    { tapToViewMessagesDeletionService },
    { AttachmentDownloadManager },
    storageService,
    { waitForAllBatchers },
    { flushAllWaitBatchers },
  ] = await Promise.all([
      import('../services/expiringMessagesDeletion.preload.ts'),
      import('../services/tapToViewMessagesDeletionService.preload.ts'),
      import('../jobs/AttachmentDownloadManager.preload.ts'),
      import('../services/storage.preload.ts'),
      import('../util/batcher.std.ts'),
      import('../util/waitBatcher.std.ts'),
    ]);

  expiringMessagesDeletion.shutdown();
  tapToViewMessagesDeletionService.shutdown();
  storageService.disableStorageService('signalctl shutdown');
  storageService.storageServiceUploadJob.cancel();
  storageService.runStorageServiceSyncJob.cancel();
  await AttachmentDownloadManager.stop();
  await Promise.all([waitForAllBatchers(), flushAllWaitBatchers()]);
}

export async function withHeadlessRuntime<T>(
  {
    environmentName,
    profile,
  }: Readonly<{
    environmentName: CliEnvironmentName;
    profile: CliProfile;
  }>,
  fn: (runtime: HeadlessRuntime) => Promise<T>,
  options: HeadlessRuntimeOptions = {}
): Promise<T> {
  installHeadlessWindow({ environmentName, profile });

  return withCliSql(
    profile,
    async () => {
      const [
        { itemStorage: storage },
        conversationModule,
        messageCacheModule,
        storeModule,
      ] = await Promise.all([
        import('../textsecure/Storage.preload.ts'),
        import('../ConversationController.preload.ts'),
        import('../services/MessageCache.preload.ts'),
        import('../SignalProtocolStore.preload.ts'),
      ]);

      const conversationController =
        new conversationModule.ConversationController();
      const windowObject = getHeadlessWindow();
      windowObject.ConversationController = conversationController;

      const messageCache = messageCacheModule.MessageCache.install();

      await storage.fetch();
      const credentials = storage.user.getWebAPICredentials();
      if (
        credentials.username &&
        credentials.password &&
        storage.get('chromiumRegistrationDone') !== ''
      ) {
        await Promise.all([
          storage.put('chromiumRegistrationDone', ''),
          storage.put('chromiumRegistrationDoneEver', ''),
        ]);
      }
      await initializeHeadlessServices(storage);
      await conversationController.load();
      await storeModule.signalProtocolStore.hydrateCaches();

      try {
        return await fn({
          conversationController,
          itemStorage: storage,
          messageCache,
          signalProtocolStore: storeModule.signalProtocolStore,
        });
      } finally {
        await shutdownHeadlessServices();
        if (options.shutdownNetworkAfterReturn !== false) {
          await shutdownHeadlessNetwork();
        }
      }
    },
    {
      drainAfterReturnMs:
        options.drainAfterReturnMs ?? DEFAULT_DRAIN_AFTER_RETURN_MS,
      shutdownMaxMs: DEFAULT_SHUTDOWN_MAX_MS,
      shutdownQuietMs: DEFAULT_SHUTDOWN_QUIET_MS,
    }
  );
}
