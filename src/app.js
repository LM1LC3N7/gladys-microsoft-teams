// -----------------------------------------------------------------------------
// The integration: a send-only Teams channel for Gladys.
//   - the messages Gladys addresses to a user (scene "Send a message",
//     system messages) go to that user's personal Workflows webhook, the
//     "My account" block (contact_schema);
//   - the scene action "Post in the Teams channel" and the test button post
//     to the channel webhook of the configuration.
// Nothing is sent otherwise: no timer sends, no retry. Nothing is received.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { buildCard } from './card.js';
import { normalizeConfig, parseWebhookUrl } from './config.js';
import { ACTION_BUDGET_MS, CONFIG_RETRY, MESSAGE_BUDGET_MS } from './constants.js';
import { T, URL_REASONS, describe } from './i18n.js';
import { Sender } from './sender.js';
import { Store } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

/** A failure for Gladys: the English text (the scene log and the core log are in English). */
const failure = (text) => new Error(text.en);

export class TeamsApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'teams' }),
    timers = defaultTimers,
    monotonic = () => performance.now(),
    wallNow = Date.now,
    post,
    dataDir = '/data',
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.timers = timers;
    this.monotonic = monotonic;
    this.store = new Store({ dir: dataDir, timers, logger });
    this.sender = new Sender({
      store: this.store,
      monotonic,
      wallNow,
      timers,
      ...(post ? { post } : {}),
    });
    this.config = undefined;
    this.channel = { ok: false, reason: 'empty' };
    this.lastStatus = undefined;
    this.statusTimer = undefined;
    this.retry = undefined;
    this.connectGeneration = 0;
    this.stopped = false;
  }

  /** Reads /data in the background; nothing waits for it. */
  init() {
    this.store.start();
  }

  // --- Configuration --------------------------------------------------------------

  async start(raw) {
    this.connectGeneration += 1;
    this.cancelRetry();
    this.config = normalizeConfig(raw);
    this.sender.hourlyCap = this.config.hourlyCap;
    this.channel = parseWebhookUrl(this.config.channelWebhook);
    if (!this.channel.ok && this.channel.reason !== 'empty') {
      this.logger.warn(`Channel webhook not usable: ${URL_REASONS[this.channel.reason].en}`);
    }
    this.lastStatus = undefined;
    await this.refreshStatus();
  }

  /**
   * `connected`: reads the configuration, retried without end (5 s doubling
   * to 60 s) while Gladys does not give it. Never awaited by the listener.
   */
  async connected() {
    this.connectGeneration += 1;
    const generation = this.connectGeneration;
    this.cancelRetry();
    let delay = CONFIG_RETRY.min;
    for (;;) {
      let config;
      try {
        config = await this.gladys.getConfig();
      } catch (err) {
        if (generation !== this.connectGeneration || this.stopped) {
          return;
        }
        this.logger.warn(
          `Configuration not read from Gladys (${err?.status ?? err?.code ?? 'error'}), retried in ${delay / 1000} s`,
        );
        await this.setStatus(false, T.configUnread);
        const go = await this.wait(delay);
        if (!go || generation !== this.connectGeneration || this.stopped) {
          return;
        }
        delay = Math.min(delay * 2, CONFIG_RETRY.max);
        continue;
      }
      if (generation !== this.connectGeneration || this.stopped) {
        return;
      }
      await this.start(config);
      return;
    }
  }

  wait(ms) {
    return new Promise((resolve) => {
      const handle = this.timers.setTimeout(() => {
        this.retry = undefined;
        resolve(true);
      }, ms);
      this.retry = { handle, resolve };
    });
  }

  cancelRetry() {
    if (this.retry) {
      this.timers.clearTimeout(this.retry.handle);
      this.retry.resolve(false);
      this.retry = undefined;
    }
  }

  async stop() {
    this.stopped = true;
    this.connectGeneration += 1;
    this.cancelRetry();
    this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    this.sender.stop();
    await this.store.stop();
  }

  // --- Status ---------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message]);
    if (key === this.lastStatus || this.stopped) {
      return;
    }
    this.lastStatus = key;
    try {
      await this.gladys.setConnectionStatus(connected, message);
    } catch (err) {
      this.lastStatus = undefined;
      this.logger.debug(`Status not sent to Gladys (${err?.status ?? 'error'})`);
    }
  }

  async refreshStatus() {
    if (!this.config) {
      return;
    }
    this.timers.clearTimeout(this.statusTimer);
    this.statusTimer = undefined;
    const now = this.monotonic();
    const paused = this.sender.pausedFor(now);
    if (paused > 0) {
      // Back to "ready" when the pause ends.
      this.statusTimer = this.timers.setTimeout(() => {
        this.statusTimer = undefined;
        this.refreshStatus().catch(() => {});
      }, paused + 1000);
      await this.setStatus(false, T.statusPaused(paused));
      return;
    }
    if (!this.channel.ok) {
      if (this.channel.reason === 'empty') {
        await this.setStatus(true, T.ready(this.config.hourlyCap, false));
      } else {
        await this.setStatus(false, T.statusInvalid(this.channel.reason));
      }
      return;
    }
    if (this.sender.isRefused(this.channel.url, now)) {
      await this.setStatus(false, T.statusRefused);
      return;
    }
    await this.setStatus(true, T.ready(this.config.hourlyCap, true));
  }

  // --- Sending --------------------------------------------------------------------

  log(target, outcome) {
    const text = describe(outcome, this.sender.hourlyCap).en;
    if (outcome.result === 'accepted') {
      this.logger.debug(`${target}: ${text}`);
    } else {
      const code = outcome.errorCode ? ` [${outcome.errorCode}]` : '';
      this.logger.warn(`${target}: ${text}${code}`);
    }
  }

  /** Gladys message to one user (onSendMessage): their personal webhook. */
  async sendMessage(contact, message) {
    const parsed = parseWebhookUrl(contact?.webhook_url);
    if (!parsed.ok) {
      throw failure({
        en: `Personal Teams webhook not usable: ${URL_REASONS[parsed.reason].en}. Nothing sent.`,
      });
    }
    let card;
    try {
      card = buildCard({ text: message?.text });
    } catch {
      throw failure({ en: 'Empty message: nothing sent.' });
    }
    const target = `Personal webhook ${this.sender.ref(parsed.url)}`;
    if (message?.file) {
      this.logger.debug(
        `${target}: the image of the message is not posted (Teams webhooks take 28 KB at most)`,
      );
    }
    const outcome = await this.sender.send(parsed.url, card.json, { budgetMs: MESSAGE_BUDGET_MS });
    this.log(target, outcome);
    this.refreshStatus().catch(() => {});
    if (outcome.result !== 'accepted') {
      throw failure(describe(outcome, this.sender.hourlyCap));
    }
  }

  /** Scene action: posts to the channel webhook; outputs { status }. */
  async postToChannel(fields = {}) {
    if (!this.config) {
      throw failure(T.noConfig);
    }
    if (!this.channel.ok) {
      throw failure(T.channelUnusable(this.channel.reason));
    }
    let card;
    try {
      card = buildCard({
        text: fields.text,
        title: fields.title,
        urgent: fields.importance === 'urgent',
      });
    } catch {
      throw failure({ en: 'Empty text: nothing sent.' });
    }
    const outcome = await this.sender.send(this.channel.url, card.json, {
      budgetMs: ACTION_BUDGET_MS,
    });
    this.log('Channel webhook', outcome);
    await this.refreshStatus();
    if (outcome.result === 'accepted') {
      return { status: 'accepted' };
    }
    if (outcome.result === 'unconfirmed') {
      // Neither a success nor a failure: the scene may gate on the output.
      return { status: 'unconfirmed' };
    }
    throw failure(describe(outcome, this.sender.hourlyCap));
  }

  /** Test button: one test card to the channel webhook, even a refused one. */
  async testChannel() {
    if (!this.config) {
      return T.noConfig;
    }
    if (!this.channel.ok) {
      return T.channelUnusable(this.channel.reason);
    }
    const { en, fr } = T.testCard.text;
    const card = buildCard({ title: T.testCard.title, text: `${en}\n\n${fr}` });
    const outcome = await this.sender.send(this.channel.url, card.json, {
      budgetMs: ACTION_BUDGET_MS,
      bypassRefusal: true,
    });
    this.log('Channel webhook (test)', outcome);
    await this.refreshStatus();
    return describe(outcome, this.sender.hourlyCap);
  }
}
