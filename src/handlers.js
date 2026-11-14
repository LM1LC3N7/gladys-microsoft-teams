// -----------------------------------------------------------------------------
// The SDK handlers, in one function so that the tests wire the fake Gladys
// exactly like index.js wires the real one.
// -----------------------------------------------------------------------------

import { ACTIONS, SCENE_ACTIONS } from './constants.js';

export function registerHandlers(gladys, app, logger) {
  // Messages Gladys addresses to a user who filled "My account".
  gladys.onSendMessage((contact, message) => app.sendMessage(contact, message));

  // Scene action and configuration button: the channel webhook.
  gladys.onSceneAction(SCENE_ACTIONS.POST, (fields) => app.postToChannel(fields));
  gladys.onAction(ACTIONS.TEST, () => app.testChannel());

  gladys.onConfigUpdated((config) => {
    logger?.info('Configuration updated');
    return app.start(config);
  });

  // Not awaited: a getConfig() failing is retried without end, and the
  // connection must not wait for it.
  gladys.on('connected', () => {
    app.connected().catch((err) => logger?.error(`Start failed: ${err?.message}`));
  });

  gladys.handleShutdown(() => app.stop());
}
