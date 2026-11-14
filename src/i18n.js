// -----------------------------------------------------------------------------
// The texts shown to the user: connection status, test button, errors of the
// scene action and of the messages. Never a URL, never a message text.
// -----------------------------------------------------------------------------

const duration = (ms) => {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 90) {
    return { en: `${s} s`, fr: `${s} s` };
  }
  const min = Math.ceil(s / 60);
  if (min < 120) {
    return { en: `${min} min`, fr: `${min} min` };
  }
  const h = Math.round((min / 60) * 10) / 10;
  return { en: `${h} h`, fr: `${String(h).replace('.', ',')} h` };
};

/** Why a webhook URL is not used (reasons of parseWebhookUrl). */
export const URL_REASONS = {
  empty: {
    en: 'no webhook URL',
    fr: 'pas d’URL de webhook',
  },
  invalid: {
    en: 'the webhook URL is not a valid https:// address',
    fr: 'l’URL du webhook n’est pas une adresse https:// valide',
  },
  retired: {
    en: 'this is an Office 365 connector URL, retired by Microsoft in May 2026: create a webhook with the Workflows app instead',
    fr: 'c’est une URL de connecteur Office 365, retirés par Microsoft en mai 2026 : créez plutôt un webhook avec l’application Workflows',
  },
  not_workflows: {
    en: 'this is not the URL of a Workflows webhook (When a Teams webhook request is received)',
    fr: 'ce n’est pas l’URL d’un webhook Workflows (When a Teams webhook request is received)',
  },
  no_signature: {
    en: 'the webhook asks for a Microsoft sign-in: in the trigger of the workflow, set "Who can trigger the flow?" to "Anyone"',
    fr: 'le webhook demande une connexion Microsoft : dans le déclencheur du workflow, réglez « Who can trigger the flow? » sur « Anyone »',
  },
};

/** How a refused webhook can be used again, by target. */
const LIFT = {
  channel: {
    en: 'it is tried again after 24 h, after a successful "Send a test message", or with a new URL',
    fr: 'il est réessayé après 24 h, après un « Envoyer un message de test » réussi, ou avec une nouvelle URL',
  },
  personal: {
    en: 'it is tried again after 24 h, with a new URL in "My account", or after a click on "Send a test message" in the Configuration of the integration',
    fr: 'il est réessayé après 24 h, avec une nouvelle URL dans « Mon compte », ou après un clic sur « Envoyer un message de test » dans la Configuration de l’intégration',
  },
};

/** One outcome of Sender.send, in both languages; `kind`: channel or personal. */
export function describe(outcome, cap, kind = 'channel') {
  const lift = LIFT[kind];
  const { result, reason } = outcome;
  if (result === 'accepted') {
    return {
      en: 'Message accepted by Microsoft Workflows (the workflow then posts it in Teams).',
      fr: 'Message accepté par Microsoft Workflows (le workflow le publie ensuite dans Teams).',
    };
  }
  if (result === 'not_sent') {
    const wait = outcome.waitMs ? duration(outcome.waitMs) : undefined;
    const why = {
      refused: {
        en: `this webhook was refused by Microsoft (workflow deleted, turned off or wrong URL); ${lift.en}`,
        fr: `ce webhook a été refusé par Microsoft (workflow supprimé, désactivé ou mauvaise URL) ; ${lift.fr}`,
      },
      paused: {
        en: `Microsoft asked to slow down or failed for this webhook; it is used again in ${wait?.en}`,
        fr: `Microsoft a demandé de ralentir ou a échoué pour ce webhook ; il est réutilisé dans ${wait?.fr}`,
      },
      cap: {
        en: `hourly cap of ${cap} messages reached; next possible in ${wait?.en}`,
        fr: `plafond de ${cap} messages par heure atteint ; prochain possible dans ${wait?.fr}`,
      },
      busy: {
        en: 'too many messages at once, no time left to send this one',
        fr: 'trop de messages en même temps, plus le temps d’envoyer celui-ci',
      },
      stopped: { en: 'the integration is stopping', fr: 'l’intégration s’arrête' },
    }[reason] ?? {
      en: `Microsoft could not be reached (${reason})`,
      fr: `Microsoft injoignable (${reason})`,
    };
    return { en: `Nothing sent: ${why.en}.`, fr: `Rien envoyé : ${why.fr}.` };
  }
  if (result === 'unconfirmed') {
    const pause = outcome.pauseMs ? duration(outcome.pauseMs) : undefined;
    const what =
      reason === 'server_error'
        ? {
            en: `Microsoft answered with an error (HTTP ${outcome.status}); the message may or may not be posted. Not sent again${pause ? `; this webhook is used again in ${pause.en}` : ''}.`,
            fr: `Microsoft a répondu par une erreur (HTTP ${outcome.status}) ; le message est peut-être publié, peut-être pas. Pas renvoyé${pause ? ` ; ce webhook est réutilisé dans ${pause.fr}` : ''}.`,
          }
        : {
            en: `Sent, without an answer from Microsoft in time (${reason}); it may still be posted. Not sent again.`,
            fr: `Envoyé, sans réponse de Microsoft à temps (${reason}) ; il peut encore être publié. Pas renvoyé.`,
          };
    return what;
  }
  const status = outcome.status;
  if (reason === 'throttled') {
    const pause = duration(outcome.pauseMs);
    return {
      en: `Not posted: Microsoft asks to slow down (HTTP 429). This webhook is used again in ${pause.en}.`,
      fr: `Pas publié : Microsoft demande de ralentir (HTTP 429). Ce webhook est réutilisé dans ${pause.fr}.`,
    };
  }
  if (reason === 'refused') {
    return {
      en: `Not posted: Microsoft refused the webhook (HTTP ${status}): workflow deleted, turned off, or URL wrong. Not used for now: ${lift.en}.`,
      fr: `Pas publié : Microsoft a refusé le webhook (HTTP ${status}) : workflow supprimé, désactivé, ou URL fausse. Plus utilisé pour l’instant : ${lift.fr}.`,
    };
  }
  if (reason === 'redirect') {
    return {
      en: `Not posted: Microsoft answered with a redirection (HTTP ${status}), not followed.`,
      fr: `Pas publié : Microsoft a répondu par une redirection (HTTP ${status}), non suivie.`,
    };
  }
  return {
    en: `Not posted: Microsoft refused the message (HTTP ${status}).`,
    fr: `Pas publié : Microsoft a refusé le message (HTTP ${status}).`,
  };
}

export const T = {
  testCard: {
    title: 'Gladys',
    text: {
      en: 'Test message from Gladys Assistant: this channel receives the messages of your scenes.',
      fr: 'Message de test de Gladys Assistant : ce canal reçoit les messages de vos scènes.',
    },
  },
  noConfig: {
    en: 'The configuration is not read from Gladys yet: nothing sent.',
    fr: 'La configuration n’est pas encore lue depuis Gladys : rien envoyé.',
  },
  channelUnusable: (reason) => ({
    en: `Channel webhook not usable: ${URL_REASONS[reason].en}. Nothing sent.`,
    fr: `Webhook du canal inutilisable : ${URL_REASONS[reason].fr}. Rien envoyé.`,
  }),
  ready: (cap, channel, held = { refused: 0, paused: 0 }) => {
    const notes = { en: '', fr: '' };
    if (held.refused > 0) {
      notes.en += ` ${held.refused} personal webhook(s) refused by Microsoft: nothing is sent to them for 24 h; fix the workflow, then click "Send a test message" to try them again.`;
      notes.fr += ` ${held.refused} webhook(s) personnel(s) refusé(s) par Microsoft : rien ne leur est envoyé pendant 24 h ; réparez le workflow, puis cliquez sur « Envoyer un message de test » pour les réessayer.`;
    }
    if (held.paused > 0) {
      notes.en += ` ${held.paused} personal webhook(s) paused at Microsoft's request.`;
      notes.fr += ` ${held.paused} webhook(s) personnel(s) en pause à la demande de Microsoft.`;
    }
    return {
      en: `Ready (${channel ? 'channel webhook set' : 'no channel webhook, personal webhooks only'}; at most ${cap} messages per hour).${notes.en}`,
      fr: `Prêt (${channel ? 'webhook du canal renseigné' : 'pas de webhook de canal, webhooks personnels seulement'} ; ${cap} messages par heure au plus).${notes.fr}`,
    };
  },
  lifted: (n) => ({
    en: ` ${n} refused personal webhook(s) will be tried again at their next message.`,
    fr: ` ${n} webhook(s) personnel(s) refusé(s) seront réessayés à leur prochain message.`,
  }),
  statusInvalid: (reason) => ({
    en: `Channel webhook not usable: ${URL_REASONS[reason].en}.`,
    fr: `Webhook du canal inutilisable : ${URL_REASONS[reason].fr}.`,
  }),
  statusRefused: {
    en: 'Microsoft refused the channel webhook (workflow deleted, turned off or URL wrong): check it, then use the test button.',
    fr: 'Microsoft a refusé le webhook du canal (workflow supprimé, désactivé ou URL fausse) : vérifiez-le, puis utilisez le bouton de test.',
  },
  statusPaused: (ms) => {
    const d = duration(ms);
    return {
      en: `Channel webhook paused at Microsoft's request: used again in ${d.en}.`,
      fr: `Webhook du canal en pause à la demande de Microsoft : réutilisé dans ${d.fr}.`,
    };
  },
  configUnread: {
    en: 'Configuration not read from Gladys: retrying.',
    fr: 'Configuration non lue depuis Gladys : nouvel essai en cours.',
  },
};
