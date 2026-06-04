// Copyright 2016 Signal Messenger, LLC
// SPDX-License-Identifier: AGPL-3.0-only
import lodash from 'lodash';

import * as Errors from '../types/errors.std.ts';
import { createLogger } from '../logging/log.std.ts';
import { DataReader, DataWriter } from '../sql/Client.preload.ts';
import { clearTimeoutIfNecessary } from '../util/clearTimeoutIfNecessary.std.ts';
import { sleep } from '../util/sleep.std.ts';
import { SECOND } from '../util/durations/index.std.ts';
import { MessageModel } from '../models/messages.preload.ts';
import { cleanupMessages } from '../util/cleanup.preload.ts';
import { drop } from '../util/drop.std.ts';

const { debounce } = lodash;

const log = createLogger('expiringMessagesDeletion');

function unrefHeadlessTimeout(timeout: ReturnType<typeof setTimeout>): void {
  if (process.env.SIGNALCTL_HEADLESS !== '1') {
    return;
  }

  timeout.unref?.();
}

class ExpiringMessagesDeletionService {
  #timeout?: ReturnType<typeof setTimeout>;
  #isShutdown = false;
  readonly #debouncedCheckExpiringMessages = debounce(
    this.#checkExpiringMessages,
    1000
  );

  update() {
    if (this.#isShutdown) {
      log.info('update: ignoring after shutdown');
      return;
    }

    drop(this.#debouncedCheckExpiringMessages());
  }

  shutdown(): void {
    this.#isShutdown = true;
    this.#debouncedCheckExpiringMessages.cancel();
    clearTimeoutIfNecessary(this.#timeout);
    this.#timeout = undefined;
  }

  async #destroyExpiredMessages() {
    if (this.#isShutdown) {
      log.info('destroyExpiredMessages: ignoring after shutdown');
      return;
    }

    try {
      log.info('destroyExpiredMessages: Loading messages...');
      const messages = await DataReader.getExpiredMessages();
      if (this.#isShutdown) {
        log.info('destroyExpiredMessages: stopping after shutdown');
        return;
      }
      log.info(
        `destroyExpiredMessages: found ${messages.length} messages to expire`
      );

      const messageIds: Array<string> = [];
      const inMemoryMessages: Array<MessageModel> = [];

      messages.forEach(dbMessage => {
        const message = window.MessageCache.register(
          new MessageModel(dbMessage)
        );
        messageIds.push(message.id);
        inMemoryMessages.push(message);
      });

      await DataWriter.removeMessagesById(messageIds, {
        cleanupMessages,
      });

      inMemoryMessages.forEach(message => {
        log.info('Message expired', {
          sentAt: message.get('sent_at'),
        });
      });
    } catch (error) {
      log.error(
        'destroyExpiredMessages: Error deleting expired messages',
        Errors.toLogFormat(error)
      );
      log.info(
        'destroyExpiredMessages: Waiting 30 seconds before trying again'
      );
      await sleep(30 * SECOND);
    }

    log.info('destroyExpiredMessages: done, scheduling another check');
    this.update();
  }

  async #checkExpiringMessages() {
    if (this.#isShutdown) {
      log.info('checkExpiringMessages: ignoring after shutdown');
      return;
    }

    log.info('checkExpiringMessages: checking for expiring messages');

    const soonestExpiry = await DataReader.getSoonestMessageExpiry();
    if (this.#isShutdown) {
      log.info('checkExpiringMessages: stopping after shutdown');
      return;
    }
    if (!soonestExpiry) {
      log.info('checkExpiringMessages: found no messages to expire');
      return;
    }

    let wait = soonestExpiry - Date.now();

    // In the past
    if (wait < 0) {
      wait = 0;
    }

    // Too far in the future, since it's limited to a 32-bit value
    if (wait > 2147483647) {
      wait = 2147483647;
    }

    log.info(
      `checkExpiringMessages: next message expires ${new Date(
        soonestExpiry
      ).toISOString()}; waiting ${wait} ms before clearing`
    );

    clearTimeoutIfNecessary(this.#timeout);
    this.#timeout = setTimeout(this.#destroyExpiredMessages.bind(this), wait);
    unrefHeadlessTimeout(this.#timeout);
  }
}

export function initialize(): void {
  if (instance) {
    log.warn('Expiring Messages Deletion service is already initialized!');
    return;
  }
  instance = new ExpiringMessagesDeletionService();
}

export function update(): void {
  if (!instance) {
    if (process.env.SIGNALCTL_HEADLESS === '1') {
      log.info('update: ignoring missing instance in signalctl headless mode');
      return;
    }

    throw new Error('Expiring Messages Deletion service not yet initialized!');
  }
  instance.update();
}

export function shutdown(): void {
  instance?.shutdown();
  instance = undefined;
}

let instance: ExpiringMessagesDeletionService | undefined;
