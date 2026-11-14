// -----------------------------------------------------------------------------
// Every limit of the integration in one place. The manifest repeats some of
// them (test/manifest.test.js checks they agree).
// -----------------------------------------------------------------------------

export const ACTIONS = Object.freeze({ TEST: 'test_channel' });
export const SCENE_ACTIONS = Object.freeze({ POST: 'post_to_channel' });

/** Hourly cap of the messages the integration sends, whatever the target. */
export const HOURLY_CAP = Object.freeze({ default: 30, min: 1, max: 200 });
export const HOUR = 3_600_000;

/**
 * Microsoft: "more than four requests in a second" are throttled. Two
 * requests never start less than 300 ms apart.
 */
export const MIN_GAP_MS = 300;

/** Gladys waits 5 s for the ack of a message: the answer is given before. */
export const MESSAGE_BUDGET_MS = 3_500;
/** Scene action and test button: declared timeout 30 s in the manifest. */
export const ACTION_TIMEOUT_S = 30;
export const ACTION_BUDGET_MS = 20_000;
/** A request never lasts longer than this, whatever the budget. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Below this remaining budget, a request is not started at all. */
export const MIN_REQUEST_MS = 1_000;

/** Teams refuses a message above 28 KB: the card stays under this. */
export const MAX_PAYLOAD_BYTES = 27_000;
/** Gladys texts are 4096 characters at most; the scene field is cut there too. */
export const MAX_TEXT_CHARS = 4_096;
export const MAX_TITLE_CHARS = 200;
/** Only the status line and an error code are read from an answer. */
export const MAX_RESPONSE_BYTES = 16_384;
export const MAX_URL_CHARS = 2_048;

/** Pauses after a 429 or a 5xx: bounded, persisted, never a storm. */
export const PAUSE = Object.freeze({
  min: 60_000,
  max: 6 * HOUR,
  /** A 5xx doubles the pause from `min` up to this. */
  serverMax: 30 * 60_000,
  /** A 429 without a readable Retry-After doubles from `min` up to this. */
  throttleMax: HOUR,
});

/** A webhook refused by Microsoft (401, 403, 404) is not used again for 24 h. */
export const REFUSAL_MS = 24 * HOUR;
/** Marks (refusal, pause) of webhooks remembered in /data at most. */
export const MAX_MARKS = 64;

/** /data: read again on this timer while unreadable; writes grouped. */
export const STORE = Object.freeze({
  file: 'state.json',
  retryMs: 10_000,
  saveDelayMs: 1_000,
});

/** getConfig() failing in `connected`: retried, spaced from 5 s to 60 s. */
export const CONFIG_RETRY = Object.freeze({ min: 5_000, max: 60_000 });

/**
 * The hosts of a Workflows webhook ("When a Teams webhook request is
 * received"), from the Power Automate page "IP address configuration"
 * (HTTP trigger), cloud by cloud.
 */
export const WEBHOOK_HOST_SUFFIXES = Object.freeze([
  // Public cloud: Power Platform (current URLs), Logic Apps (older URLs).
  '.api.powerplatform.com',
  '.logic.azure.com',
  // US Government (GCC).
  '.api.gov.powerplatform.microsoft.us',
  '.logic.azure.us',
  // US Government (GCC High).
  '.api.high.powerplatform.microsoft.us',
  // US Department of Defense (DoD).
  '.api.appsplatform.us',
  // China (operated by 21Vianet).
  '.api.powerplatform.partner.microsoftonline.cn',
  '.logic.azure.cn',
]);
/** The Office 365 connectors (retired by Microsoft in May 2026). */
export const RETIRED_HOST_SUFFIXES = Object.freeze([
  '.webhook.office.com',
  'outlook.office.com',
  'outlook.office365.com',
]);
