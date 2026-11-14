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

/** One outcome of Sender.send, in both languages. */
export function describe(outcome, cap) {
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
        en: 'this webhook was refused by Microsoft (deleted, turned off or wrong URL); it is tried again after 24 h, after a successful test, or with a new URL',
        fr: 'ce webhook a été refusé par Microsoft (supprimé, désactivé ou mauvaise URL) ; il est réessayé après 24 h, après un test réussi, ou avec une nouvelle URL',
      },
      paused: {
        en: `Microsoft asked to slow down or failed; sending resumes in ${wait?.en}`,
        fr: `Microsoft a demandé de ralentir ou a échoué ; les envois reprennent dans ${wait?.fr}`,
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
            en: `Microsoft answered with an error (HTTP ${outcome.status}); the message may or may not be posted. Not sent again${pause ? `; next messages in ${pause.en}` : ''}.`,
            fr: `Microsoft a répondu par une erreur (HTTP ${outcome.status}) ; le message est peut-être publié, peut-être pas. Pas renvoyé${pause ? ` ; messages suivants dans ${pause.fr}` : ''}.`,
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
      en: `Not posted: Microsoft asks to slow down (HTTP 429). Next messages in ${pause.en}.`,
      fr: `Pas publié : Microsoft demande de ralentir (HTTP 429). Messages suivants dans ${pause.fr}.`,
    };
  }
  if (reason === 'refused') {
    return {
      en: `Not posted: Microsoft refused the webhook (HTTP ${status}): workflow deleted, turned off, or URL wrong. Not used again for 24 h, unless the test succeeds or the URL changes.`,
      fr: `Pas publié : Microsoft a refusé le webhook (HTTP ${status}) : workflow supprimé, désactivé, ou URL fausse. Plus utilisé pendant 24 h, sauf test réussi ou nouvelle URL.`,
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
  ready: (cap, channel) => ({
    en: `Ready (${channel ? 'channel webhook set' : 'no channel webhook, personal webhooks only'}; at most ${cap} messages per hour).`,
    fr: `Prêt (${channel ? 'webhook du canal renseigné' : 'pas de webhook de canal, webhooks personnels seulement'} ; ${cap} messages par heure au plus).`,
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
      en: `Paused at Microsoft's request: sending resumes in ${d.en}.`,
      fr: `En pause à la demande de Microsoft : les envois reprennent dans ${d.fr}.`,
    };
  },
  configUnread: {
    en: 'Configuration not read from Gladys: retrying.',
    fr: 'Configuration non lue depuis Gladys : nouvel essai en cours.',
  },
};
