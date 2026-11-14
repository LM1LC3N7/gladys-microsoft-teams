// -----------------------------------------------------------------------------
// Configuration and webhook URL checks. A webhook URL is a secret (whoever has
// it posts in the channel): it is never logged, never shown in the status,
// never written to /data; only the reason of a refusal is.
// -----------------------------------------------------------------------------

import {
  HOURLY_CAP,
  MAX_URL_CHARS,
  RETIRED_HOST_SUFFIXES,
  WEBHOOK_HOST_SUFFIXES,
} from './constants.js';

/** Mirrors the defaults of the manifest (the secret has none). */
export const DEFAULT_CONFIG = Object.freeze({ max_messages_per_hour: HOURLY_CAP.default });

/** Strict integer from a number or a numeric string; anything else: undefined. */
export function toInteger(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*\d{1,6}\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

export function normalizeConfig(raw = {}) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const cap = toInteger(config.max_messages_per_hour);
  return {
    channelWebhook:
      typeof config.channel_webhook_url === 'string' ? config.channel_webhook_url : '',
    hourlyCap:
      cap === undefined
        ? HOURLY_CAP.default
        : Math.min(HOURLY_CAP.max, Math.max(HOURLY_CAP.min, cap)),
  };
}

const endsWithHost = (host, suffixes) =>
  suffixes.some((suffix) =>
    suffix.startsWith('.') ? host.endsWith(suffix) && host.length > suffix.length : host === suffix,
  );

/**
 * Checks a Workflows webhook URL. Resolves { ok: true, url } (the parsed URL,
 * fragment dropped) or { ok: false, reason } where reason is one of: empty,
 * invalid, retired (an Office 365 connector URL), not_workflows (another host
 * or path), no_signature (the trigger asks for a Microsoft sign-in).
 */
export function parseWebhookUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  if (text.length > MAX_URL_CHARS || /[\s\u0000-\u001f\u007f]/.test(text)) {
    return { ok: false, reason: 'invalid' };
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const host = url.hostname.toLowerCase();
  if (endsWithHost(host, RETIRED_HOST_SUFFIXES)) {
    return { ok: false, reason: 'retired' };
  }
  if (url.protocol !== 'https:' || url.username || url.password) {
    return { ok: false, reason: 'invalid' };
  }
  if (url.port !== '' && url.port !== '443') {
    return { ok: false, reason: 'not_workflows' };
  }
  if (!endsWithHost(host, WEBHOOK_HOST_SUFFIXES)) {
    return { ok: false, reason: 'not_workflows' };
  }
  const path = url.pathname.toLowerCase();
  if (!path.includes('/workflows/') || !path.includes('/triggers/')) {
    return { ok: false, reason: 'not_workflows' };
  }
  if (!url.searchParams.get('sig')) {
    return { ok: false, reason: 'no_signature' };
  }
  url.hash = '';
  return { ok: true, url };
}
