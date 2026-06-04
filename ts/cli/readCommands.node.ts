// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import type { ConversationAttributesType } from '../model-types.d.ts';
import type { WritableDB } from '../sql/Interface.std.ts';

import { CliError } from './errors.node.ts';
import {
  formatConversation,
  formatMessage,
  getConversationTitle,
} from './format.node.ts';
import { type CliSqlContext, withSqlBusyRetry } from './sql.node.ts';

function sortConversations(
  conversations: ReadonlyArray<ConversationAttributesType>
): Array<ConversationAttributesType> {
  return [...conversations].sort((left, right) => {
    return (right.active_at ?? 0) - (left.active_at ?? 0);
  });
}

function findConversation(
  db: WritableDB,
  reader: CliSqlContext['reader'],
  query: string
): ConversationAttributesType {
  const direct = reader.getConversationById(db, query);
  if (direct) {
    return direct;
  }

  const normalized = query.toLowerCase();
  const match = reader.getAllConversations(db).find(conversation => {
    return (
      conversation.e164 === query ||
      conversation.serviceId === query ||
      conversation.groupId === query ||
      getConversationTitle(conversation).toLowerCase() === normalized
    );
  });

  if (!match) {
    throw new CliError('conversation_not_found', 'Conversation not found', {
      exitCode: 3,
      details: { conversation: query },
    });
  }

  return match;
}

export async function listConversations(
  context: CliSqlContext,
  {
    includeArchived,
    limit,
  }: {
    includeArchived: boolean;
    limit: number;
  }
): Promise<{
  conversations: ReadonlyArray<ReturnType<typeof formatConversation>>;
}> {
  return withSqlBusyRetry(() => {
    const conversations = sortConversations(
      context.reader.getAllConversations(context.db)
    )
      .filter(
        conversation => includeArchived || conversation.isArchived !== true
      )
      .slice(0, limit)
      .map(formatConversation);

    return { conversations };
  });
}

export async function getConversation(
  context: CliSqlContext,
  conversationQuery: string
): Promise<{
  conversation: ReturnType<typeof formatConversation>;
}> {
  return withSqlBusyRetry(() => {
    const conversation = findConversation(
      context.db,
      context.reader,
      conversationQuery
    );
    return { conversation: formatConversation(conversation) };
  });
}

export async function listMessages(
  context: CliSqlContext,
  {
    before,
    conversation: conversationQuery,
    limit,
  }: {
    before?: string;
    conversation: string;
    limit: number;
  }
): Promise<{
  conversation: ReturnType<typeof formatConversation>;
  messages: ReadonlyArray<ReturnType<typeof formatMessage>>;
}> {
  return withSqlBusyRetry(() => {
    const conversation = findConversation(
      context.db,
      context.reader,
      conversationQuery
    );
    const beforeMessage = before
      ? context.reader.getMessageById(context.db, before)
      : undefined;

    if (before && !beforeMessage) {
      throw new CliError('message_not_found', 'Before message not found', {
        exitCode: 3,
        details: { message: before },
      });
    }

    const messages = context.reader
      .getOlderMessagesByConversation(context.db, {
        conversationId: conversation.id,
        includeStoryReplies: false,
        limit,
        messageId: beforeMessage?.id,
        receivedAt: beforeMessage?.received_at,
        sentAt: beforeMessage?.sent_at,
        storyId: undefined,
      })
      .map(formatMessage);

    return {
      conversation: formatConversation(conversation),
      messages,
    };
  });
}

export async function searchMessages(
  context: CliSqlContext,
  {
    conversation: conversationQuery,
    limit,
    query,
  }: {
    conversation?: string;
    limit: number;
    query: string;
  }
): Promise<{
  messages: unknown;
}> {
  return withSqlBusyRetry(() => {
    const conversation = conversationQuery
      ? findConversation(context.db, context.reader, conversationQuery)
      : undefined;

    return {
      messages: context.reader.searchMessages(context.db, {
        query,
        conversationId: conversation?.id,
        options: { limit },
      }),
    };
  });
}
