/**
 * What a webhook payload looks like, per service.
 *
 * Three of them, and only one is a format anybody chose: Teams and Discord each accept exactly one
 * shape at their incoming-webhook endpoints, so those two are transcriptions of somebody else's
 * documentation rather than a design. The third is this app's own JSON, for a script or a SIEM,
 * where the useful thing is the *fields* rather than a rendered sentence.
 *
 * ## The severity colour
 *
 * Both chat services colour a card by a single accent, and the obvious thing to send is the
 * severity of the finding the event is about. It is deliberately the same palette the report uses
 * rather than a second set invented here — a High in Teams should be the same orange as a High in
 * the document, because somebody will have both open.
 */

/** The report's own severity colours, as the two chat services want them. */
const SEVERITY_COLOUR = {
  Critical: 'D02D2D',
  High: 'FE6C00',
  Medium: 'F9A009',
  Low: '008000',
  None: '4A86E8',
};

/** Anything not about one finding's severity: this app's blue, so a card still looks deliberate. */
const NEUTRAL = '4A86E8';

const colourFor = (severity) => SEVERITY_COLOUR[severity] ?? NEUTRAL;

/**
 * The services this can post to.
 *
 * Shape mirrors the mail and assistant presets: an id the settings document stores, a name for the
 * form, and the one sentence somebody needs in order to know whether this is the right choice. The
 * hint is where the URL comes from, because that is the only genuinely confusing part — both
 * services hide it behind several clicks in a place the app cannot link to.
 */
export const WEBHOOK_PROVIDERS = [
  {
    id: 'teams',
    name: 'Microsoft Teams',
    hint:
      'In Teams: the channel’s ⋯ menu → Connectors → Incoming Webhook, or Workflows → ' +
      '“Post to a channel when a webhook request is received”. Copy the URL it gives you.',
    /** Both of Teams’ own hosts. Checked to catch a URL pasted from the wrong tab. */
    expects: /^https:\/\/[a-z0-9.-]*\.(office|office365|logic\.azure)\.com\//i,
  },
  {
    id: 'discord',
    name: 'Discord',
    hint:
      'In Discord: Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL. ' +
      'A webhook belongs to one channel, so make one for the channel you want these in.',
    expects: /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//i,
  },
  {
    id: 'json',
    name: 'Anything else, as JSON',
    hint:
      'Posts this app’s own JSON to any URL, signed with a shared secret so the receiver can ' +
      'prove the request came from here. For a script, a SIEM, or a service of your own.',
    expects: /^https?:\/\//i,
  },
];

export const isProvider = (id) => WEBHOOK_PROVIDERS.some((entry) => entry.id === id);

/** The presets as the settings form wants them — without the regexes, which are ours. */
export const providerChoices = () =>
  WEBHOOK_PROVIDERS.map(({ id, name, hint }) => ({ id, name, hint }));

/**
 * Whether a URL looks like it belongs to the chosen service.
 *
 * A warning rather than a refusal, and returned rather than thrown: a self-hosted Teams-compatible
 * relay is a real thing, and an app that refuses a URL because it has not heard of the host is an
 * app somebody works around. The test button says so, and saving is still allowed.
 */
export function urlLooksWrong(provider, url) {
  const preset = WEBHOOK_PROVIDERS.find((entry) => entry.id === provider);
  if (!preset || !url) return '';
  if (preset.expects.test(url)) return '';
  if (provider === 'json') return 'That does not look like a URL — it needs to start with https://.';
  return `That does not look like a ${preset.name} webhook URL. It will be posted to anyway.`;
}

/* -------------------------------------------------------------------------- */
/* The payloads                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @typedef {object} WebhookEvent
 * @property {string} action the activity action, e.g. `finding.created`
 * @property {string} event the group it belongs to, e.g. `findings`
 * @property {string} summary the sentence the activity log shows
 * @property {string} [actor] who did it
 * @property {string} [severity] the finding's severity, when the event is about one
 * @property {{name: string, reference: string, id: string}} engagement
 * @property {string} [target] what it was done to
 * @property {string} [url] a link back, when the instance knows its own address
 * @property {string} at ISO timestamp
 */

/**
 * Teams: a legacy MessageCard.
 *
 * Chosen over the newer Adaptive Card on purpose. Incoming Webhooks — the connector *and* the
 * Workflows replacement — both accept MessageCard, whereas Adaptive Cards need the payload wrapped
 * in an attachment envelope that only some of those paths accept. The older shape is the one that
 * works everywhere Teams offers a URL, which is the only property that matters for something an
 * administrator pastes in once.
 */
function teamsPayload(event) {
  const facts = [
    { name: 'Engagement', value: event.engagement?.reference || event.engagement?.name || '—' },
    event.severity ? { name: 'Severity', value: event.severity } : null,
    event.actor ? { name: 'Who', value: event.actor } : null,
  ].filter(Boolean);

  return {
    '@type': 'MessageCard',
    '@context': 'https://schema.org/extensions',
    /* Shown in the notification toast and the channel list, where markdown is not rendered. */
    summary: event.summary,
    themeColor: colourFor(event.severity),
    title: event.target || event.engagement?.name || 'Engagement update',
    text: event.summary,
    sections: [{ facts }],
    ...(event.url
      ? {
          potentialAction: [
            {
              '@type': 'OpenUri',
              name: 'Open in the app',
              targets: [{ os: 'default', uri: event.url }],
            },
          ],
        }
      : {}),
  };
}

/**
 * Discord: one embed.
 *
 * `content` is left empty and everything goes in the embed, so the message does not say the same
 * sentence twice — Discord renders both. The colour is an integer there rather than a hex string,
 * which is the one thing about this format that catches people out.
 */
function discordPayload(event) {
  const fields = [
    {
      name: 'Engagement',
      value: event.engagement?.reference || event.engagement?.name || '—',
      inline: true,
    },
    event.severity ? { name: 'Severity', value: event.severity, inline: true } : null,
    event.actor ? { name: 'Who', value: event.actor, inline: true } : null,
  ].filter(Boolean);

  return {
    embeds: [
      {
        title: event.target || event.engagement?.name || 'Engagement update',
        description: event.summary,
        color: parseInt(colourFor(event.severity), 16),
        fields,
        timestamp: event.at,
        ...(event.url ? { url: event.url } : {}),
      },
    ],
  };
}

/** This app's own shape: the facts, unrendered, for something that is going to parse them. */
function jsonPayload(event) {
  return {
    event: event.event,
    action: event.action,
    summary: event.summary,
    at: event.at,
    actor: event.actor ?? null,
    severity: event.severity ?? null,
    target: event.target ?? null,
    engagement: event.engagement ?? null,
    url: event.url ?? null,
  };
}

const BUILDERS = { teams: teamsPayload, discord: discordPayload, json: jsonPayload };

/** @param {string} provider @param {WebhookEvent} event */
export function buildPayload(provider, event) {
  const build = BUILDERS[provider] ?? jsonPayload;
  return build(event);
}

export default WEBHOOK_PROVIDERS;
