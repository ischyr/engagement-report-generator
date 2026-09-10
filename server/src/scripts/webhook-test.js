/**
 * Checks the webhooks.
 *
 *   npm run test:webhook
 *
 * No chat service and no database. A webhook has three parts that can each be wrong on their own,
 * and all three are checkable here: which events are worth sending, what the payload looks like for
 * each service, and how the request behaves when the far end is slow, broken, or rude. The far end
 * is a real HTTP server on a loopback port, so the transport under test is the transport that runs.
 *
 * The payload shapes are the part worth being fussy about. Teams and Discord each accept exactly
 * one format and neither tells you when you send the wrong one — Discord answers 204 for a card it
 * then renders as nothing, and Teams answers `200 1` for a MessageCard with a field it does not
 * know. So the assertions here are on the specific keys those two services require, because the
 * services themselves will not complain.
 */
import http from 'node:http';
import crypto from 'node:crypto';

import { ACTIONS } from '../models/activity.model.js';
import {
  EVENT_GROUPS,
  groupFor,
  testWebhook,
  webhookConfig,
} from '../services/webhooks/index.js';
import { buildPayload, providerChoices, urlLooksWrong } from '../services/webhooks/providers.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

/* -------------------------------------------------------------------------- */
/* Which events are worth telling anybody about                               */
/* -------------------------------------------------------------------------- */
console.log('\nWhat counts as news:');
{
  check(
    'a finding being written does',
    groupFor({ action: ACTIONS.FINDING_CREATED }) === 'findings',
    String(groupFor({ action: ACTIONS.FINDING_CREATED }))
  );
  check(
    'and one imported from a scan',
    groupFor({ action: ACTIONS.FINDING_IMPORTED }) === 'findings'
  );
  check(
    'the report being approved is its own group',
    groupFor({ action: ACTIONS.APPROVED }) === 'review'
  );
  check(
    'being delivered to the client is another',
    groupFor({ action: ACTIONS.REPORT_DELIVERED }) === 'delivery'
  );
  check(
    'and the client marking something fixed is a third',
    groupFor({ action: ACTIONS.CLIENT_UPDATED_FINDING }) === 'client'
  );

  /*
   * The one that matters most. A finding is saved dozens of times as it is written, and every one
   * of those is a `finding.updated` in the log. A channel told about all of them is a channel
   * somebody mutes on the first afternoon, which costs the feature everything.
   */
  check(
    'a finding being edited is not, on its own',
    groupFor({ action: ACTIONS.FINDING_UPDATED, fields: ['description', 'poc'] }) === null,
    String(groupFor({ action: ACTIONS.FINDING_UPDATED, fields: ['description'] }))
  );
  check(
    'but its severity moving is',
    groupFor({ action: ACTIONS.FINDING_UPDATED, fields: ['cvssv3'] }) === 'findings'
  );
  check(
    'and so is somebody overriding the severity by hand',
    groupFor({ action: ACTIONS.FINDING_UPDATED, fields: ['title', 'severityOverride'] }) ===
      'findings'
  );
  check(
    'a finding update with no fields recorded is not',
    groupFor({ action: ACTIONS.FINDING_UPDATED }) === null
  );

  check(
    'and the noise nobody asked for is not in any group',
    groupFor({ action: ACTIONS.ENUM_STEPS_REORDERED }) === null &&
      groupFor({ action: ACTIONS.CREDENTIAL_REVEALED }) === null &&
      groupFor({ action: ACTIONS.NOTE_UPDATED }) === null,
    'something reorderable is being announced'
  );
  check('nor is an action nobody has heard of', groupFor({ action: 'made.up' }) === null);
  check('nor is nothing at all', groupFor(null) === null && groupFor({}) === null);

  check(
    'every group offered to the settings page has a name and a sentence',
    Object.values(EVENT_GROUPS).every((group) => group.name && group.hint),
    JSON.stringify(Object.keys(EVENT_GROUPS))
  );
}

/* -------------------------------------------------------------------------- */
/* What each service is sent                                                  */
/* -------------------------------------------------------------------------- */
const EVENT = {
  action: 'finding.created',
  event: 'findings',
  summary: 'Mario Rossi wrote "Shipment documents readable without authentication"',
  severity: 'Critical',
  target: 'Shipment documents readable without authentication',
  engagement: { id: '6a70c9343bb8776321e44693', name: 'Northwind Logistics', reference: 'NWL-2026-01' },
  url: 'https://engy.example/engagements/6a70c9343bb8776321e44693',
  at: '2026-09-09T08:15:00.000Z',
};

console.log('\nWhat Microsoft Teams is sent:');
{
  const card = buildPayload('teams', EVENT);
  check(
    'a MessageCard, which is the shape every Teams webhook path accepts',
    card['@type'] === 'MessageCard' && card['@context'] === 'https://schema.org/extensions',
    JSON.stringify({ type: card['@type'], context: card['@context'] })
  );
  check(
    'with a summary, without which Teams rejects the card outright',
    card.summary === EVENT.summary,
    JSON.stringify(card.summary)
  );
  check('the sentence as the body', card.text === EVENT.summary);
  check('the finding as the title', card.title === EVENT.target);
  check(
    'the report’s own colour for a Critical, so two screens agree',
    card.themeColor === 'D02D2D',
    card.themeColor
  );
  const facts = card.sections?.[0]?.facts ?? [];
  check(
    'the engagement’s reference as a fact',
    facts.some((fact) => fact.name === 'Engagement' && fact.value === 'NWL-2026-01'),
    JSON.stringify(facts)
  );
  check(
    'and a button back to the engagement',
    card.potentialAction?.[0]?.targets?.[0]?.uri === EVENT.url,
    JSON.stringify(card.potentialAction)
  );
}

console.log('\nWhat Discord is sent:');
{
  const message = buildPayload('discord', EVENT);
  check('one embed', Array.isArray(message.embeds) && message.embeds.length === 1);
  const embed = message.embeds[0];
  check('with the sentence as the description', embed.description === EVENT.summary);
  check(
    'the colour as an integer, which is the thing that catches people out',
    embed.color === 0xd02d2d && typeof embed.color === 'number',
    JSON.stringify(embed.color)
  );
  check('a timestamp Discord can parse', embed.timestamp === EVENT.at);
  check(
    'the facts as inline fields',
    (embed.fields ?? []).some((field) => field.value === 'Critical' && field.inline === true),
    JSON.stringify(embed.fields)
  );
  check(
    'and no top-level content, so the sentence is not printed twice',
    message.content === undefined,
    JSON.stringify(message.content)
  );
}

console.log('\nWhat anything else is sent:');
{
  const body = buildPayload('json', EVENT);
  check(
    'the facts rather than a rendered card',
    body.action === 'finding.created' && body.event === 'findings' && body.severity === 'Critical',
    JSON.stringify(body)
  );
  check(
    'the engagement as an object, so a receiver can key on the id',
    body.engagement?.id === EVENT.engagement.id,
    JSON.stringify(body.engagement)
  );
  check('and no chat-service furniture in it', !('embeds' in body) && !('@type' in body));

  const unknown = buildPayload('not-a-provider', EVENT);
  check(
    'an unrecognised provider falls back to that rather than to nothing',
    unknown.action === 'finding.created',
    JSON.stringify(unknown)
  );
}

console.log('\nAnd when the event is not about one finding:');
{
  const plain = buildPayload('teams', { ...EVENT, severity: null, target: '' });
  check(
    'the card takes the app’s own colour rather than a severity’s',
    plain.themeColor === '4A86E8',
    plain.themeColor
  );
  check('and the engagement’s name as the title', plain.title === 'Northwind Logistics');
  const discord = buildPayload('discord', { ...EVENT, severity: null });
  check(
    'and Discord is not sent a Severity field for an event that has none',
    !(discord.embeds[0].fields ?? []).some((field) => field.name === 'Severity'),
    JSON.stringify(discord.embeds[0].fields)
  );
}

/* -------------------------------------------------------------------------- */
/* A URL under the wrong service                                              */
/* -------------------------------------------------------------------------- */
console.log('\nA URL that does not match the service:');
{
  check(
    'a Discord URL pasted under Teams is called out',
    /Microsoft Teams/.test(
      urlLooksWrong('teams', 'https://discord.com/api/webhooks/123/abc')
    ),
    urlLooksWrong('teams', 'https://discord.com/api/webhooks/123/abc')
  );
  check(
    'a real Discord URL under Discord is not',
    urlLooksWrong('discord', 'https://discord.com/api/webhooks/123/abc') === ''
  );
  check(
    'a Teams workflow URL is recognised as well as a connector one',
    urlLooksWrong(
      'teams',
      'https://prod-12.westeurope.logic.azure.com/workflows/abc/triggers/manual/paths/invoke'
    ) === '',
    urlLooksWrong('teams', 'https://prod-12.westeurope.logic.azure.com/workflows/abc')
  );
  check(
    'and something that is not a URL at all is called out under the plain provider',
    urlLooksWrong('json', 'engy.example/hook') !== ''
  );
  check(
    'every provider offered to the form has a name and a hint about where the URL lives',
    providerChoices().every((entry) => entry.id && entry.name && entry.hint) &&
      providerChoices().length === 3,
    JSON.stringify(providerChoices().map((entry) => entry.id))
  );
}

/* -------------------------------------------------------------------------- */
/* The settings, resolved                                                     */
/* -------------------------------------------------------------------------- */
console.log('\nReading the settings:');
{
  const off = webhookConfig({ webhooks: { enabled: false } });
  check('nothing is enabled without a URL', off.enabled === false);

  /* The environment wins, the same way SMTP_PASSWORD does. */
  process.env.WEBHOOK_URL = 'https://engy.example/hook';
  const fromEnv = webhookConfig({ webhooks: { enabled: true, provider: 'discord' } });
  check(
    'a URL in the environment is used without anybody opening the settings page',
    fromEnv.enabled === true && fromEnv.url === 'https://engy.example/hook',
    JSON.stringify({ enabled: fromEnv.enabled, url: fromEnv.url })
  );
  check('and the chosen provider is kept', fromEnv.provider === 'discord');

  const nonsense = webhookConfig({ webhooks: { enabled: true, provider: 'carrier-pigeon' } });
  check('a provider nobody implements falls back to plain JSON', nonsense.provider === 'json');

  const slow = webhookConfig({ webhooks: { enabled: true, timeoutSeconds: 45 } });
  check('a timeout is honoured', slow.timeoutMs === 45_000, String(slow.timeoutMs));
  const silly = webhookConfig({ webhooks: { enabled: true, timeoutSeconds: 9999 } });
  check('and one outside the range is not', silly.timeoutMs === 10_000, String(silly.timeoutMs));

  const groups = webhookConfig({ webhooks: { enabled: true, events: { findings: true } } });
  check(
    'every group has an answer, so nothing is undefined at the point of decision',
    Object.keys(EVENT_GROUPS).every((key) => typeof groups.events[key] === 'boolean') &&
      groups.events.findings === true &&
      groups.events.review === false,
    JSON.stringify(groups.events)
  );
  delete process.env.WEBHOOK_URL;
}

/* -------------------------------------------------------------------------- */
/* The far end                                                                */
/* -------------------------------------------------------------------------- */
/** A receiver that behaves however the current test needs it to, and records what arrived. */
const received = [];
let behaviour = { status: 200, body: 'ok', delayMs: 0 };

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    received.push({ headers: req.headers, body: raw });
    const answer = () => {
      res.writeHead(behaviour.status, { 'Content-Type': 'text/plain' });
      res.end(behaviour.body);
    };
    if (behaviour.delayMs) setTimeout(answer, behaviour.delayMs);
    else answer();
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/hook`;

console.log('\nPosting to something that answers:');
{
  received.length = 0;
  behaviour = { status: 200, body: '1', delayMs: 0 };
  const result = await testWebhook({ provider: 'teams', url });

  check('it is accepted', result.ok === true, JSON.stringify(result));
  check('and said so in words somebody can read', /check the channel/i.test(result.message), result.message);
  check('exactly one request was made', received.length === 1, String(received.length));
  check(
    'as JSON',
    received[0].headers['content-type'] === 'application/json',
    received[0].headers['content-type']
  );
  const body = JSON.parse(received[0].body);
  check(
    'and the test message is a real card in the real format',
    body['@type'] === 'MessageCard' && /webhook works/i.test(body.text),
    JSON.stringify(body).slice(0, 120)
  );
}

console.log('\nThe signature:');
{
  received.length = 0;
  behaviour = { status: 200, body: 'ok', delayMs: 0 };
  await testWebhook({ provider: 'json', url, signingSecret: 'a-shared-secret' });

  const { headers, body } = received[0];
  check('a timestamp is sent', Boolean(headers['x-engy-timestamp']), JSON.stringify(headers));
  check(
    'and a signature over the timestamp and the body together',
    headers['x-engy-signature'] ===
      `sha256=${crypto
        .createHmac('sha256', 'a-shared-secret')
        .update(`${headers['x-engy-timestamp']}.${body}`)
        .digest('hex')}`,
    headers['x-engy-signature']
  );
  check(
    'the body alone would not verify, so a captured request cannot be replayed for ever',
    headers['x-engy-signature'] !==
      `sha256=${crypto.createHmac('sha256', 'a-shared-secret').update(body).digest('hex')}`
  );

  received.length = 0;
  await testWebhook({ provider: 'teams', url, signingSecret: 'a-shared-secret' });
  check(
    'and Teams is sent none, because it has no way to check one',
    received[0].headers['x-engy-signature'] === undefined,
    JSON.stringify(received[0].headers['x-engy-signature'])
  );
}

console.log('\nWhen the far end refuses:');
{
  received.length = 0;
  behaviour = { status: 400, body: 'Bad payload: unknown field', delayMs: 0 };
  const result = await testWebhook({ provider: 'discord', url });

  check('it is not accepted', result.ok === false);
  check(
    'and the answer is the service’s own words rather than a status code',
    result.message === 'Bad payload: unknown field',
    result.message
  );
  check(
    'a refusal is not retried — asking twice makes one clear failure into two',
    received.length === 1,
    `${received.length} requests`
  );
}

console.log('\nWhen it is briefly busy:');
{
  received.length = 0;
  behaviour = { status: 500, body: 'try later', delayMs: 0 };
  const result = await testWebhook({ provider: 'json', url });

  check('it is retried once', received.length === 2, `${received.length} requests`);
  check('and then given up on', result.ok === false, JSON.stringify(result));

  received.length = 0;
  behaviour = { status: 429, body: 'slow down', delayMs: 0 };
  await testWebhook({ provider: 'json', url });
  check('being throttled is retried too', received.length === 2, `${received.length} requests`);
}

console.log('\nWhen it does not answer at all:');
{
  received.length = 0;
  behaviour = { status: 200, body: 'ok', delayMs: 400 };
  const result = await testWebhook({ provider: 'json', url, timeoutSeconds: 1 });

  /*
   * The timeout is a second and the delay is under it, so this proves the *opposite* of a hang:
   * a slow-but-answering service is fine. The abort path is checked below with a delay that
   * outlasts the deadline.
   */
  check('a slow answer within the timeout is still an answer', result.ok === true, JSON.stringify(result));

  received.length = 0;
  behaviour = { status: 200, body: 'ok', delayMs: 2500 };
  const timedOut = await testWebhook({ provider: 'json', url, timeoutSeconds: 1 });
  check('one that outlasts the timeout is given up on', timedOut.ok === false);
  check(
    'and says so in seconds rather than as an abort error',
    /No answer within 1 second/.test(timedOut.message),
    timedOut.message
  );
  check(
    'a timeout is not retried either — a slow service asked twice is slower',
    received.length === 1,
    `${received.length} requests`
  );
}

console.log('\nAnd with nothing to post to:');
{
  const result = await testWebhook({ provider: 'teams', url: '' });
  check('it says so rather than throwing', result.ok === false && /no URL/i.test(result.message), result.message);
}

server.close();

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
