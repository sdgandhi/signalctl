// Copyright 2026 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only

import { createAttachmentsFromPaths } from './attachments.node.ts';
import type { CliEnvironmentName } from './config.node.ts';
import { CliError } from './errors.node.ts';
import { withHeadlessRuntime } from './headlessRuntime.node.ts';
import type { CliProfile } from './profile.node.ts';
import { getMessageById } from '../messages/getMessageById.preload.ts';
import { isSent } from '../messages/MessageSendState.std.ts';

let conversationQueueStarted = false;

export async function sendMessageCommand({
  attachments: attachmentPaths,
  conversation: conversationQuery,
  environmentName,
  message,
  profile,
  wait,
}: Readonly<{
  attachments: ReadonlyArray<string>;
  conversation: string;
  environmentName: CliEnvironmentName;
  message: string;
  profile: CliProfile;
  wait: boolean;
}>): Promise<{
  messageId: string;
  conversationId: string;
  sentAt: number;
  jobId?: string;
  completed: boolean;
}> {
  return withHeadlessRuntime({ environmentName, profile }, async runtime => {
    const credentials = runtime.itemStorage.user.getWebAPICredentials();
    if (!credentials.username || !credentials.password) {
      throw new CliError('profile_not_linked', 'CLI profile is not linked', {
        exitCode: 4,
      });
    }

    const conversation =
      runtime.conversationController.get(conversationQuery) ??
      runtime.conversationController
        .getAll()
        .find(
          item =>
            item.getTitle().toLowerCase() === conversationQuery.toLowerCase()
        );

    if (!conversation) {
      throw new CliError('conversation_not_found', 'Conversation not found', {
        exitCode: 3,
        details: { conversation: conversationQuery },
      });
    }

    const [webApi, queueModule] = await Promise.all([
      import('../textsecure/WebAPI.preload.ts'),
      import('../jobs/conversationJobQueue.preload.ts'),
    ]);

    await webApi.connect({
      ...credentials,
      hasBuildExpired: false,
      hasStoriesDisabled: runtime.itemStorage.get('hasStoriesDisabled', false),
    });

    try {
      if (!conversationQueueStarted) {
        conversationQueueStarted = true;
        void queueModule.conversationJobQueue.streamJobs();
      }

      const attachments = await createAttachmentsFromPaths(attachmentPaths);
      let sendJob: { id: string; completion: Promise<void> } | undefined;
      const attributes = await conversation.enqueueMessageForSend(
        {
          attachments,
          body: message,
        },
        {
          onSendJob: job => {
            sendJob = job;
          },
          sendHQImages: true,
        }
      );

      if (!attributes) {
        throw new CliError(
          'send_skipped',
          'Conversation cannot send messages',
          {
            exitCode: 6,
          }
        );
      }

      if (wait) {
        await sendJob?.completion;
        const sentMessage = await getMessageById(attributes.id);
        const sendStateByConversationId =
          sentMessage?.get('sendStateByConversationId') ?? {};
        const statuses = Object.fromEntries(
          Object.entries(sendStateByConversationId).map(
            ([conversationId, sendState]) => [conversationId, sendState.status]
          )
        );
        const errors =
          sentMessage
            ?.get('errors')
            ?.map(error => error.message || error.name || String(error)) ?? [];

        if (
          Object.values(sendStateByConversationId).some(
            sendState => !isSent(sendState.status)
          )
        ) {
          throw new CliError('send_failed', 'Message was not sent', {
            exitCode: 7,
            details: {
              messageId: attributes.id,
              statuses,
              ...(errors.length ? { errors } : {}),
            },
          });
        }
      }

      return {
        completed: wait,
        conversationId: attributes.conversationId,
        jobId: sendJob?.id,
        messageId: attributes.id,
        sentAt: attributes.sent_at,
      };
    } finally {
      await webApi.logout();
    }
  });
}
