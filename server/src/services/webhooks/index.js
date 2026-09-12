/**
 * Telling something outside this app that something happened.
 *
 * The tracker export answers "get these findings into Jira" for a person who is willing to press a
 * button. This answers the other half: a channel that hears about the work as it happens, without
 * anybody pressing anything. A firm on Teams or Discord gets the same thing the activity log shows,
 * in the room where they already talk about the job.
 *
 * ## Why it hangs off the activity log
 *
 * Because the activity log is already the list of things worth telling somebody about, and it
 * already writes the sentence. Every meaningful event in an engagement calls `recordActivity` with
 * an action and a summary — "Mario wrote a finding", "the report was delivered to the client" — and
 * a webhook is that sentence, posted somewhere else. Hooking three routes by hand would have meant
 * three places to forget, and a fourth event would have needed a fourth call. Hanging off the log
 * means the set of possible events is the set of things the app already records.
 *
 * It hangs off `recordActivity` itself — the one function that writes an Activity — rather than off
 * a Mongoose `post('save')` hook on the model. The hook was the first attempt and it is silently
 * ignored: **document middleware added to a schema after the model has been compiled never runs**,
 * and by the time anything can install a hook the model has been compiled by whichever import
 * reached it first. Nothing errors, nothing warns, and no event is ever posted. The end-to-end
 * check in `collab-test` is what caught it, which is the argument for having one.
 *
 * What it does *not* mean is a message per log entry. The log is a forensic record and holds a row
 * for every keystroke-level save; a channel that heard all of it would be muted inside a day. So an
 * administrator picks from a handful of named groups, and inside those groups the noisy actions are
 * filtered further — a finding being edited is only news when its *severity* moved.
 *
 * ## The URL is the credential
 *
 * For Teams and for Discord, possession of the webhook URL is the entire authorisation: anybody
 * holding it can post to that channel as this app, for ever, until somebody revokes it. So it is
 * stored the way the mail password is — AES-256-GCM under `VAULT_KEY` — never returned to the
 * browser, and only ever shown back as its host. An administrator who needs to know which channel
 * it points at can see that much; nobody, including an administrator, can read it back out.
 *
 * ## And it never breaks the work
 *
 * Fire and forget, everything swallowed, one retry. Somebody is in the middle of saving a finding;
 * a chat service being slow, down, or throttling is not their problem and must never become their
 * error message. The same discipline as the notification mail, for the same reason.
 */

import crypto from 'node:crypto';

import { ACTIONS } from '../../models/activity.model.js';
import { Audit } from '../../models/audit.model.js';
import { Settings } from '../../models/settings.model.js';
import { decryptSecret } from '../vault.service.js';
import { findingSeverity } from '../cvss.js';
import env from '../../config/env.js';
import { log } from '../../utils/logger.js';
import { buildPayload, isProvider } from './providers.js';

export { WEBHOOK_PROVIDERS, providerChoices, urlLooksWrong } from './providers.js';

/**
 * Whether anything should be posted at all.
 *
 * `installWebhooks()` at boot is what sets this, and it is the reason that function still exists
 * now that there are no hooks to install: a script that pulls in the models to read or write data —
 * the seeder, the template linter, a migration — writes activity as a side effect of its work, and
 * must not post it into somebody's chat channel by accident. The settings say whether the feature
 * is on; this says whether we are the kind of process that may act on it.
 */
let armed = false;

/** Long enough for a slow chat service, short enough not to hold a request handler's tail. */
const DEFAULT_TIMEOUT_SECONDS = 10;
/** One retry, and only for the failures that are worth retrying. */
const RETRY_AFTER_MS = 750;

/** The fields whose change means "the severity moved", which is the only finding edit worth a message. */
const SEVERITY_FIELDS = ['cvssv3', 'cvssv4', 'severityOverride'];

/**
 * What an administrator chooses between.
 *
 * Named groups rather than sixty actions. The activity log has a constant for every distinct thing
 * that can happen in an engagement, which is right for a forensic record and useless as a list of
 * checkboxes — nobody wants to decide, one at a time, whether `enumeration.reordered` is news.
 *
 * A group's `actions` maps an action to either `true` (always) or a predicate on the log entry, for
 * the ones that are only sometimes worth saying.
 */
export const EVENT_GROUPS = {
  findings: {
    name: 'Findings',
    hint: 'A finding is written or imported, its severity changes, or it is deleted.',
    actions: {
      [ACTIONS.FINDING_CREATED]: true,
      [ACTIONS.FINDING_IMPORTED]: true,
      [ACTIONS.FINDING_DELETED]: true,
      /*
       * Not every edit. A finding is saved dozens of times while it is being written, and a channel
       * told about each one is a channel nobody reads. A severity moving is the thing a lead wants
       * to hear about without being asked.
       */
      [ACTIONS.FINDING_UPDATED]: (entry) =>
        (entry.fields ?? []).some((field) => SEVERITY_FIELDS.includes(field)),
    },
  },
  review: {
    name: 'Review and sign-off',
    hint: 'The report is approved, an approval is withdrawn, or the engagement changes state.',
    actions: {
      [ACTIONS.APPROVED]: true,
      [ACTIONS.APPROVAL_WITHDRAWN]: true,
      [ACTIONS.STATE_CHANGED]: true,
    },
  },
  delivery: {
    name: 'Delivery',
    hint: 'A report is generated, or recorded as sent to the client.',
    actions: {
      [ACTIONS.REPORT_DELIVERED]: true,
      [ACTIONS.REPORT_GENERATED]: true,
    },
  },
  client: {
    name: 'The client',
    hint: 'The client marks something fixed through their link, or a question is asked or settled.',
    actions: {
      [ACTIONS.CLIENT_UPDATED_FINDING]: true,
      /* And the question they asked through the link, which is the same kind of news: something
         happened at a moment when nobody on the team was looking at the app. */
      [ACTIONS.CLIENT_ASKED_QUESTION]: true,
      [ACTIONS.QUESTION_ASKED]: true,
      [ACTIONS.QUESTION_SETTLED]: true,
    },
  },
  links: {
    name: 'Client links',
    hint: 'A share link is issued or revoked. Off by default — useful for a record, quiet it is not.',
    actions: {
      [ACTIONS.SHARE_LINK_CREATED]: true,
      [ACTIONS.SHARE_LINK_REVOKED]: true,
    },
  },
};

/** Which group an action belongs to, and whether this particular entry qualifies. */
export function groupFor(entry) {
  for (const [key, group] of Object.entries(EVENT_GROUPS)) {
    const rule = group.actions[entry?.action];
    if (rule === undefined) continue;
    if (rule === true) return key;
    return rule(entry) ? key : null;
  }
  return null;
}

/**
 * The webhook settings, resolved — with the URL decrypted and the environment allowed to win.
 *
 * `WEBHOOK_URL` in the environment overrides the stored one, the same way `SMTP_PASSWORD` does: an
 * instance deployed from a compose file should be able to carry its secrets in the environment
 * without anybody opening the settings page.
 */
export function webhookConfig(settings) {
  const raw = settings?.webhooks ?? {};
  const provider = isProvider(raw.provider) ? raw.provider : 'json';

  let url = String(process.env.WEBHOOK_URL ?? '').trim();
  if (!url && raw.url?.data) {
    try {
      url = decryptSecret(raw.url);
    } catch (error) {
      log.warn(`Could not read the webhook URL from the vault: ${error.message}`);
    }
  }

  let signingSecret = String(process.env.WEBHOOK_SIGNING_SECRET ?? '').trim();
  if (!signingSecret && raw.signingSecret?.data) {
    try {
      signingSecret = decryptSecret(raw.signingSecret);
    } catch {
      /* A signature nobody can compute is better than a failed save. */
    }
  }

  const seconds = Number(raw.timeoutSeconds);
  return {
    enabled: Boolean(raw.enabled) && Boolean(url),
    provider,
    url,
    signingSecret,
    timeoutMs:
      (Number.isFinite(seconds) && seconds >= 1 && seconds <= 60
        ? seconds
        : DEFAULT_TIMEOUT_SECONDS) * 1000,
    events: Object.fromEntries(
      Object.keys(EVENT_GROUPS).map((key) => [key, Boolean(raw.events?.[key])])
    ),
  };
}

/**
 * Posts one payload, with a single retry on the failures that a retry can fix.
 *
 * A 4xx is not retried: a revoked webhook, a deleted channel and a malformed payload all return one,
 * and asking twice turns a clear failure into two. A 429, a 5xx and a network error are retried
 * once — which covers the case this is actually for, a chat service being briefly busy.
 */
async function post(config, body, { attempt = 1 } = {}) {
  const serialised = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json' };

  /*
   * A signature, so a receiver can prove the request came from this instance and not from anybody
   * who guessed the URL. Only for the plain-JSON provider: Teams and Discord ignore unknown headers
   * and have no way to check one, and for them the URL's own secrecy is the authorisation.
   */
  if (config.provider === 'json' && config.signingSecret) {
    const at = Math.floor(Date.now() / 1000);
    const digest = crypto
      .createHmac('sha256', config.signingSecret)
      /* The timestamp is signed with the body, so a captured request cannot be replayed for ever. */
      .update(`${at}.${serialised}`)
      .digest('hex');
    headers['X-Engy-Timestamp'] = String(at);
    headers['X-Engy-Signature'] = `sha256=${digest}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers,
      body: serialised,
      signal: controller.signal,
    });

    if (response.ok) return { ok: true, status: response.status };

    /* Their words, not ours — the same rule the mail and PDF tests follow. */
    const said = (await response.text().catch(() => '')).slice(0, 300).trim();
    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
      return post(config, body, { attempt: 2 });
    }
    return { ok: false, status: response.status, message: said || `HTTP ${response.status}` };
  } catch (error) {
    const aborted = error?.name === 'AbortError';
    if (!aborted && attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_MS));
      return post(config, body, { attempt: 2 });
    }
    return {
      ok: false,
      status: 0,
      message: aborted
        ? `No answer within ${Math.round(config.timeoutMs / 1000)} seconds.`
        : error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The severity of the finding an event is about, when it is about one.
 *
 * Matched on the title, which is what the log stores as its target. Loose, deliberately: this
 * decides the accent colour of a card and nothing else, so a title that matches nothing — because
 * the finding has since been renamed, or two share a name — simply means the neutral colour rather
 * than a wrong one. Nothing is worth a second query to the findings array for this.
 */
function severityOf(audit, entry) {
  if (!entry?.target || !String(entry.action).startsWith('finding.')) return null;
  const matches = (audit?.findings ?? []).filter((finding) => finding.title === entry.target);
  if (matches.length !== 1) return null;
  return findingSeverity(matches[0]).severity;
}

/** The event a payload is built from, assembled out of one activity entry and its engagement. */
async function describe(entry) {
  const audit = await Audit.findById(entry.audit)
    .select('name reference findings.title findings.cvssv3 findings.severityOverride')
    .lean();

  /*
   * The actor's name is already inside the summary — `recordActivity` builds the sentence with it —
   * so it is not looked up again here. What the card gets is the sentence the app itself shows,
   * which means a channel and the activity log never disagree about what happened.
   */
  return {
    action: entry.action,
    event: groupFor(entry),
    summary: entry.summary || entry.action,
    severity: severityOf(audit, entry),
    target: entry.target || '',
    engagement: {
      id: String(entry.audit ?? ''),
      name: audit?.name ?? '',
      reference: audit?.reference ?? '',
    },
    url: entry.audit ? `${env.appUrl}/engagements/${entry.audit}` : '',
    at: new Date(entry.createdAt ?? Date.now()).toISOString(),
  };
}

/**
 * Offers one activity entry to the outside world.
 *
 * Returns what happened rather than throwing, so a caller that wants to know can look and the
 * hook that does not can ignore it. `skipped` says why nothing was sent, which is what makes this
 * debuggable without a chat service to hand.
 */
export async function offerActivity(entry) {
  const group = groupFor(entry);
  if (!group) return { skipped: 'not an event anybody asked for' };

  const config = webhookConfig(await Settings.getSettings());
  if (!config.enabled) return { skipped: 'webhooks are off' };
  if (!config.events[group]) return { skipped: `the ${group} group is not switched on` };

  const event = await describe(entry);
  const result = await post(config, buildPayload(config.provider, event));
  if (!result.ok) {
    log.warn(`Webhook for ${entry.action} was refused: ${result.message}`);
  }
  return result;
}

/**
 * Posts a sample event, and reports the service's own words when it will not take it.
 *
 * Takes the settings from the request rather than the database, so a URL can be proved before it is
 * saved — the same as the mail, assistant and PDF tests. A real message in the real format, because
 * a test that posts something simpler proves the URL exists and not that the payload is right.
 */
export async function testWebhook({ provider, url, signingSecret, timeoutSeconds }) {
  const config = {
    provider: isProvider(provider) ? provider : 'json',
    url: String(url ?? '').trim(),
    signingSecret: String(signingSecret ?? ''),
    timeoutMs: (Number(timeoutSeconds) || DEFAULT_TIMEOUT_SECONDS) * 1000,
  };
  if (!config.url) return { ok: false, message: 'There is no URL to post to.' };

  const event = {
    action: 'webhook.test',
    event: 'test',
    summary: 'A test from the engagement reporting app. If you can read this, the webhook works.',
    severity: 'Medium',
    target: 'Webhook test',
    engagement: { id: '', name: 'No engagement — this is a test', reference: 'TEST' },
    url: env.appUrl,
    at: new Date().toISOString(),
  };

  const result = await post(config, buildPayload(config.provider, event));
  return result.ok
    ? { ok: true, message: 'Posted. Check the channel.' }
    : { ok: false, message: result.message };
}

/**
 * Offers an activity entry, and never gets in the way.
 *
 * What `recordActivity` calls. Deliberately not awaited by its caller and deliberately incapable of
 * throwing: somebody is in the middle of saving a finding, and a chat service being slow, down or
 * throttling is not their problem and must never become their error message.
 */
export function announceActivity(entry) {
  if (!armed || !entry) return;
  offerActivity(entry).catch((error) => {
    log.warn(`Could not post a webhook: ${error.message}`);
  });
}

/**
 * Says that this process may post to the outside world.
 *
 * One line in `index.js`, beside the notification mail, so it is findable — and so a script that
 * imports the models does not acquire the ability to post into a chat channel just by writing
 * activity, which is what a seeder does on every run.
 */
export function installWebhooks() {
  armed = true;
}

/** For tests, and for a script that wants to be certain it will not post. */
export function stopWebhooks() {
  armed = false;
}

export default installWebhooks;
