// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type {
  ConversationAttributesType,
  MessageAttributesType,
} from '../model-types.d.ts';

function combineNames(
  ...parts: ReadonlyArray<string | undefined>
): string | undefined {
  const result = parts.filter(Boolean).join(' ').trim();
  return result || undefined;
}

export function getConversationTitle(
  conversation: ConversationAttributesType
): string {
  return (
    conversation.name ||
    combineNames(conversation.profileName, conversation.profileFamilyName) ||
    combineNames(conversation.systemGivenName, conversation.systemFamilyName) ||
    combineNames(
      conversation.nicknameGivenName ?? undefined,
      conversation.nicknameFamilyName ?? undefined
    ) ||
    conversation.username ||
    conversation.e164 ||
    conversation.serviceId ||
    conversation.groupId ||
    conversation.id
  );
}

export function formatConversation(conversation: ConversationAttributesType): {
  id: string;
  type: ConversationAttributesType['type'];
  title: string;
  e164?: string;
  serviceId?: string;
  groupId?: string;
  activeAt?: number | null;
  archived: boolean;
  unreadCount: number;
  markedUnread: boolean;
  lastMessage?: string | null;
  lastMessageReceivedAt?: number;
  messageCount?: number;
} {
  return {
    id: conversation.id,
    type: conversation.type,
    title: getConversationTitle(conversation),
    e164: conversation.e164,
    serviceId: conversation.serviceId,
    groupId: conversation.groupId,
    activeAt: conversation.active_at,
    archived: conversation.isArchived === true,
    unreadCount: conversation.unreadCount ?? 0,
    markedUnread: conversation.markedUnread === true,
    lastMessage: conversation.lastMessage,
    lastMessageReceivedAt: conversation.lastMessageReceivedAt,
    messageCount: conversation.messageCount,
  };
}

export function formatMessage(message: MessageAttributesType): {
  id: string;
  conversationId?: string;
  type?: string;
  body?: string;
  timestamp?: number;
  sentAt?: number;
  receivedAt?: number;
  source?: string;
  sourceServiceId?: string;
  sourceDevice?: number;
  hasAttachments: boolean;
  attachments: ReadonlyArray<{
    contentType?: string;
    fileName?: string;
    size?: number;
  }>;
} {
  return {
    id: message.id,
    conversationId: message.conversationId,
    type: message.type,
    body: message.body,
    timestamp: message.timestamp,
    sentAt: message.sent_at,
    receivedAt: message.received_at,
    source: message.source,
    sourceServiceId: message.sourceServiceId,
    sourceDevice: message.sourceDevice,
    hasAttachments: Boolean(message.attachments?.length),
    attachments: (message.attachments ?? []).map(attachment => ({
      contentType: attachment.contentType,
      fileName: attachment.fileName,
      size: attachment.size,
    })),
  };
}
