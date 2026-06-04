// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import './urlPatternFallback.node.ts';

import PQueue from 'p-queue';

import type { ConversationModel } from '../models/conversations.preload.ts';
import type { MessageModel } from '../models/messages.preload.ts';
import type { MessageAttributesType } from '../model-types.d.ts';
import { SeenStatus } from '../MessageSeenStatus.std.ts';
import { ReadStatus } from '../messages/MessageReadStatus.std.ts';
import type { SendStateByConversationId } from '../messages/MessageSendState.std.ts';
import { SendStatus } from '../messages/MessageSendState.std.ts';
import type {
  ContactSyncEvent,
  ErrorEvent,
  MessageEvent,
  SentEvent,
} from '../textsecure/messageReceiverEvents.std.ts';
import { SignalService as Proto } from '../protobuf/index.std.ts';
import type { ProcessedDataMessage } from '../textsecure/Types.d.ts';
import type { ServiceIdString } from '../types/ServiceId.std.ts';
import { DataReader } from '../sql/Client.preload.ts';
import { generateMessageId } from '../util/generateMessageId.node.ts';
import { isAciString } from '../util/isAciString.std.ts';
import { isPniString } from '../types/ServiceId.std.ts';
import { drop } from '../util/drop.std.ts';
import { strictAssert } from '../util/assert.std.ts';
import { toLogFormat } from '../types/errors.std.ts';

import type { CliEnvironmentName } from './config.node.ts';
import { CliError } from './errors.node.ts';
import {
  type HeadlessRuntime,
  withHeadlessRuntime,
} from './headlessRuntime.node.ts';
import { formatConversation, formatMessage } from './format.node.ts';
import { ok, writeJsonLine } from './output.node.ts';
import type { CliProfile } from './profile.node.ts';

type MessageModelClass =
  typeof import('../models/messages.preload.ts').MessageModel;
type HandleDataMessageFn =
  typeof import('../messages/handleDataMessage.preload.ts').handleDataMessage;

type DaemonDependencies = Readonly<{
  handleDataMessage: HandleDataMessageFn;
  MessageModel: MessageModelClass;
  saveAndNotify: (
    message: MessageModel,
    conversation: ConversationModel,
    confirm: () => void
  ) => Promise<void>;
}>;

type MessageDescriptor = Readonly<{
  id: string;
  type: 'private' | 'group';
}>;

type DaemonEvent =
  | Readonly<{ type: 'ready'; profile: string; userDataPath: string }>
  | Readonly<{ type: 'startup_sync_requested' }>
  | Readonly<{
      type: 'message';
      direction: 'incoming' | 'outgoing';
      conversation: ReturnType<typeof formatConversation>;
      message: ReturnType<typeof formatMessage>;
    }>
  | Readonly<{ type: 'contact_sync_complete' }>
  | Readonly<{ type: 'receiver_empty' }>
  | Readonly<{ type: 'ignored'; eventType: string }>
  | Readonly<{ type: 'error'; error: string }>;

const eventHandlerQueue = new PQueue({ concurrency: 1 });

function emit(event: DaemonEvent): void {
  writeJsonLine({ ok: true, event });
}

function emitError(error: unknown): void {
  writeJsonLine({
    ok: false,
    error: {
      code: 'daemon_error',
      message: error instanceof Error ? error.message : String(error),
      details: toLogFormat(error),
    },
  });
}

function waitForShutdownSignal(): Promise<NodeJS.Signals> {
  return new Promise(resolve => {
    const finish = (signal: NodeJS.Signals) => {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      resolve(signal);
    };
    const onSigint = () => finish('SIGINT');
    const onSigterm = () => finish('SIGTERM');
    process.once('SIGINT', onSigint);
    process.once('SIGTERM', onSigterm);
  });
}

function getMessageDescriptor({
  destinationE164,
  destinationServiceId,
  envelopeId,
  message,
  source,
  sourceDevice,
}: Readonly<{
  destinationE164?: string;
  destinationServiceId?: ServiceIdString;
  envelopeId: string;
  message: ProcessedDataMessage;
  source: string | undefined;
  sourceDevice: number | undefined;
}>): MessageDescriptor {
  const logId = `signalctl.getMessageDescriptor/${source}.${sourceDevice}-${envelopeId}`;

  if (message.groupV2) {
    const { id } = message.groupV2;
    if (!id) {
      throw new Error(`${logId}: GroupV2 data was missing an id`);
    }

    const existingGroupV2 = window.ConversationController.get(id);
    if (existingGroupV2) {
      return { id: existingGroupV2.id, type: 'group' };
    }

    const existingGroupV1 =
      window.ConversationController.getByDerivedGroupV2Id(id);
    if (existingGroupV1) {
      return { id: existingGroupV1.id, type: 'group' };
    }

    const conversationId = window.ConversationController.ensureGroup(id, {
      groupVersion: 2,
      masterKey: message.groupV2.masterKey,
      publicParams: message.groupV2.publicParams,
      secretParams: message.groupV2.secretParams,
    });

    return { id: conversationId, type: 'group' };
  }

  const id = destinationServiceId || destinationE164;
  strictAssert(
    id,
    `${logId}: We need some sort of destination for the conversation`
  );

  return {
    id: window.ConversationController.getOrCreate(id, 'private').id,
    type: 'private',
  };
}

function initIncomingMessage(
  data: MessageEvent['data'],
  descriptor: MessageDescriptor,
  MessageModelConstructor: MessageModelClass
): MessageModel {
  const partialMessage: MessageAttributesType = {
    ...generateMessageId(data.receivedAtCounter),
    canReplyToStory: data.message.isStory
      ? data.message.canReplyToStory
      : undefined,
    conversationId: descriptor.id,
    readStatus: ReadStatus.Unread,
    received_at_ms: data.receivedAtDate,
    seenStatus: SeenStatus.Unseen,
    sent_at: data.timestamp,
    serverGuid: data.serverGuid,
    serverTimestamp: data.serverTimestamp,
    source: data.source,
    sourceDevice: data.sourceDevice,
    sourceServiceId: data.sourceAci,
    timestamp: data.timestamp,
    type: data.message.isStory ? 'story' : 'incoming',
    unidentifiedDeliveryReceived: data.unidentifiedDeliveryReceived,
  };

  return new MessageModelConstructor(partialMessage);
}

async function createSentMessage(
  runtime: HeadlessRuntime,
  data: SentEvent['data'],
  descriptor: MessageDescriptor,
  MessageModelConstructor: MessageModelClass
): Promise<MessageModel> {
  const now = Date.now();
  const { timestamp } = data;
  const ourId = window.ConversationController.getOurConversationIdOrThrow();
  const sendStateByConversationId: SendStateByConversationId = {
    [ourId]: {
      status: SendStatus.Sent,
      updatedAt: timestamp,
    },
  };

  for (const {
    destinationServiceId,
    isAllowedToReplyToStory,
  } of data.unidentifiedStatus ?? []) {
    const conversation = destinationServiceId
      ? window.ConversationController.get(destinationServiceId)
      : undefined;
    if (!conversation || conversation.id === ourId) {
      continue;
    }

    sendStateByConversationId[conversation.id] = {
      isAllowedToReplyToStory,
      status: SendStatus.Sent,
      updatedAt: timestamp,
    };
  }

  const unidentifiedDeliveries = (data.unidentifiedStatus ?? [])
    .filter(item => Boolean(item.unidentified))
    .map(item => item.destinationServiceId)
    .filter((value): value is ServiceIdString => Boolean(value));

  const partialMessage: MessageAttributesType = {
    ...generateMessageId(data.receivedAtCounter),
    canReplyToStory: data.message.isStory
      ? data.message.canReplyToStory
      : undefined,
    conversationId: descriptor.id,
    expirationStartTimestamp: Math.min(
      data.expirationStartTimestamp || timestamp,
      now
    ),
    readStatus: ReadStatus.Read,
    received_at_ms: data.receivedAtDate,
    seenStatus: SeenStatus.NotApplicable,
    sendStateByConversationId,
    sent_at: timestamp,
    serverTimestamp: data.serverTimestamp,
    source: runtime.itemStorage.user.getNumber(),
    sourceDevice: data.device,
    sourceServiceId: runtime.itemStorage.user.getAci(),
    storyDistributionListId: data.storyDistributionListId,
    timestamp,
    type: data.message.isStory ? 'story' : 'outgoing',
    unidentifiedDeliveries,
  };

  return new MessageModelConstructor(partialMessage);
}

function isSpecialDataMessage(message: ProcessedDataMessage): boolean {
  return Boolean(
    message.reaction ||
    message.pinMessage ||
    message.pollVote ||
    message.pollTerminate ||
    message.adminDelete ||
    message.delete ||
    message.editedMessageTimestamp ||
    message.unpinMessage ||
    message.groupCallUpdate
  );
}

async function saveHeadlessMessage(
  message: MessageModel,
  conversation: ConversationModel,
  confirm: () => void
): Promise<void> {
  try {
    await window.MessageCache.saveMessage(message, { forceSave: true });
    const savedMessage = await DataReader.getMessageById(message.id);
    strictAssert(savedMessage, 'Headless daemon message was not saved');

    if (message.get('type') === 'outgoing') {
      conversation.incrementSentMessageCount();
    }

    await conversation.updateLastMessage();
    confirm();

    emit({
      type: 'message',
      direction: message.get('type') === 'outgoing' ? 'outgoing' : 'incoming',
      conversation: formatConversation(conversation.attributes),
      message: formatMessage(message.attributes),
    });
  } catch (error) {
    emitError(error);
    throw error;
  }
}

async function onMessageReceived(
  event: MessageEvent,
  dependencies: DaemonDependencies
): Promise<void> {
  const { data, confirm } = event;

  window.ConversationController.maybeMergeContacts({
    aci: data.sourceAci,
    e164: data.source,
    reason: 'signalctl.onMessageReceived',
  });

  const messageDescriptor = getMessageDescriptor({
    destinationE164: data.source,
    destinationServiceId: data.sourceAci,
    envelopeId: data.envelopeId,
    message: data.message,
    source: data.sourceAci ?? data.source,
    sourceDevice: data.sourceDevice,
  });

  const { PROFILE_KEY_UPDATE } = Proto.DataMessage.Flags;
  // oxlint-disable-next-line no-bitwise
  const isProfileUpdate = Boolean(data.message.flags & PROFILE_KEY_UPDATE);
  if (isProfileUpdate || isSpecialDataMessage(data.message)) {
    confirm();
    emit({ type: 'ignored', eventType: event.type });
    return;
  }

  const message = initIncomingMessage(
    data,
    messageDescriptor,
    dependencies.MessageModel
  );
  await dependencies.handleDataMessage(
    message,
    data.message,
    confirm,
    {},
    {
      saveAndNotify: dependencies.saveAndNotify,
    }
  );
}

async function onSentMessage(
  runtime: HeadlessRuntime,
  event: SentEvent,
  dependencies: DaemonDependencies
): Promise<void> {
  const { data, confirm } = event;

  const sourceServiceId = runtime.itemStorage.user.getAci();
  strictAssert(sourceServiceId, 'Missing user aci');

  if (
    data.destinationServiceId &&
    data.destinationServiceId !== sourceServiceId
  ) {
    const { mergePromises } = window.ConversationController.maybeMergeContacts({
      aci: isAciString(data.destinationServiceId)
        ? data.destinationServiceId
        : undefined,
      e164: data.destinationE164,
      pni: isPniString(data.destinationServiceId)
        ? data.destinationServiceId
        : undefined,
      reason: `signalctl.onSentMessage(${data.timestamp})`,
    });

    if (mergePromises.length > 0) {
      await Promise.all(mergePromises);
    }
  }

  const messageDescriptor = getMessageDescriptor({
    ...data,
    source: sourceServiceId,
    sourceDevice: data.device,
  });

  const { PROFILE_KEY_UPDATE } = Proto.DataMessage.Flags;
  // oxlint-disable-next-line no-bitwise
  const isProfileUpdate = Boolean(data.message.flags & PROFILE_KEY_UPDATE);
  if (isProfileUpdate || isSpecialDataMessage(data.message)) {
    confirm();
    emit({ type: 'ignored', eventType: event.type });
    return;
  }

  const message = await createSentMessage(
    runtime,
    data,
    messageDescriptor,
    dependencies.MessageModel
  );
  await dependencies.handleDataMessage(
    message,
    data.message,
    confirm,
    { data },
    { saveAndNotify: dependencies.saveAndNotify }
  );
}

function confirmAndIgnore(event: Event): void {
  const maybeConfirmable = event as Event & { confirm?: () => void };
  maybeConfirmable.confirm?.();
  emit({ type: 'ignored', eventType: event.type });
}

function queuedEventListener<E extends Event>(
  handler: (event: E) => Promise<void> | void
): (event: E) => void {
  return (event: E): void => {
    drop(
      eventHandlerQueue.add(async () => {
        try {
          await handler(event);
        } catch (error) {
          emitError(error);
        }
      })
    );
  };
}

async function requestStartupSync(runtime: HeadlessRuntime): Promise<void> {
  if (window.ConversationController.areWePrimaryDevice()) {
    return;
  }

  const status = runtime.itemStorage.get('postRegistrationSyncsStatus');
  if (status === 'complete') {
    return;
  }

  window.ConversationController.getOurConversationIdOrThrow();

  const [{ setIsInitialContactSync }, { sendSyncRequests }] = await Promise.all(
    [
      import('../services/contactSync.preload.ts'),
      import('../textsecure/syncRequests.preload.ts'),
    ]
  );

  setIsInitialContactSync(true);
  await sendSyncRequests();
  emit({ type: 'startup_sync_requested' });
}

export async function daemonCommand({
  environmentName,
  profile,
}: Readonly<{
  environmentName: CliEnvironmentName;
  profile: CliProfile;
}>): Promise<{
  stopped: boolean;
  signal: NodeJS.Signals;
}> {
  return withHeadlessRuntime({ environmentName, profile }, async runtime => {
    const credentials = runtime.itemStorage.user.getWebAPICredentials();
    if (!credentials.username || !credentials.password) {
      throw new CliError('profile_not_linked', 'CLI profile is not linked', {
        exitCode: 4,
      });
    }

    const [
      { default: MessageReceiver },
      { handleDataMessage },
      { MessageModel },
      webApi,
      { conversationJobQueue },
      { singleProtoJobQueue },
      { deliveryReceiptQueue },
      { onContactSync },
    ] = await Promise.all([
      import('../textsecure/MessageReceiver.preload.ts'),
      import('../messages/handleDataMessage.preload.ts'),
      import('../models/messages.preload.ts'),
      import('../textsecure/WebAPI.preload.ts'),
      import('../jobs/conversationJobQueue.preload.ts'),
      import('../jobs/singleProtoJobQueue.preload.ts'),
      import('../util/deliveryReceipt.preload.ts'),
      import('../services/contactSync.preload.ts'),
    ]);
    const saveQueue = new PQueue({ concurrency: 1 });
    const dependencies: DaemonDependencies = {
      handleDataMessage,
      MessageModel,
      saveAndNotify: (message, conversation, confirm) =>
        saveQueue.add(() =>
          saveHeadlessMessage(message, conversation, confirm)
        ),
    };

    const messageReceiver = new MessageReceiver({
      serverTrustRoots: window.getServerTrustRoots(),
      storage: runtime.itemStorage,
    });

    messageReceiver.addEventListener(
      'message',
      queuedEventListener(event => onMessageReceived(event, dependencies))
    );
    messageReceiver.addEventListener(
      'sent',
      queuedEventListener(event => onSentMessage(runtime, event, dependencies))
    );
    messageReceiver.addEventListener(
      'contactSync',
      queuedEventListener(async (event: ContactSyncEvent) => {
        await onContactSync(event);
        await runtime.itemStorage.put(
          'postRegistrationSyncsStatus',
          'complete'
        );
        emit({ type: 'contact_sync_complete' });
      })
    );
    messageReceiver.addEventListener(
      'empty',
      queuedEventListener(async () => {
        await saveQueue.onIdle();
        emit({ type: 'receiver_empty' });
      })
    );
    messageReceiver.addEventListener(
      'error',
      queuedEventListener((event: ErrorEvent) => {
        emit({ type: 'error', error: event.error.message });
      })
    );

    const genericMessageReceiver = messageReceiver as unknown as {
      addEventListener: (
        eventType: string,
        handler: (event: Event) => void
      ) => void;
    };

    for (const eventType of [
      'delivery',
      'successful-decrypt',
      'decryption-error',
      'invalid-plaintext',
      'retry-request',
      'read',
      'view',
      'configuration',
      'viewOnceOpenSync',
      'messageRequestResponse',
      'fetchLatest',
      'keys',
      'sticker-pack',
      'readSync',
      'viewSync',
      'envelopeQueued',
      'envelopeUnsealed',
      'storyRecipientUpdate',
      'callEventSync',
      'callLinkUpdateSync',
      'callLogEventSync',
      'deleteForMeSync',
      'attachmentBackfillResponseSync',
      'deviceNameChangeSync',
      'typing',
    ]) {
      genericMessageReceiver.addEventListener(
        eventType,
        queuedEventListener(confirmAndIgnore)
      );
    }

    await webApi.connect({
      ...credentials,
      hasBuildExpired: false,
      hasStoriesDisabled: runtime.itemStorage.get('hasStoriesDisabled', false),
    });

    messageReceiver.startProcessingQueue();
    webApi.registerRequestHandler(messageReceiver);

    drop(conversationJobQueue.streamJobs());
    drop(singleProtoJobQueue.streamJobs());
    deliveryReceiptQueue.start();

    emit({
      type: 'ready',
      profile: profile.name,
      userDataPath: profile.userDataPath,
    });

    await requestStartupSync(runtime);

    const signal = await waitForShutdownSignal();
    webApi.unregisterRequestHandler(messageReceiver);
    messageReceiver.stopProcessing();
    await messageReceiver.drain();
    await eventHandlerQueue.onIdle();
    await saveQueue.onIdle();
    await Promise.allSettled([
      conversationJobQueue.shutdown(),
      singleProtoJobQueue.shutdown(),
    ]);
    await webApi.logout();

    return ok({ signal, stopped: true }).data;
  });
}
