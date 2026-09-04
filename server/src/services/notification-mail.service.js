/**
 * Every inbox notification, offered as mail.
 *
 * Wired as one hook on the Notification model rather than as a line added to each of the eleven
 * places that create one. That is the difference between a feature and a habit: a hook cannot be
 * forgotten by the twelfth caller, and the rule it enforces — *if it was worth telling somebody in
 * the app, it is worth telling them where they are* — belongs in one place.
 *
 * Three gates, all of which must be open, and all of which fail closed:
 *
 *   1. the instance has mail configured and `email.notifications` on
 *   2. the recipient has not switched their own off
 *   3. the recipient is not the person who caused it
 *
 * The third one matters more than it looks. Several of these fire on your own action — signing in,
 * a booking you moved — and an instance that mails you about things you just did teaches everybody
 * to filter it. `new-sign-in` is the deliberate exception: being told about your own sign-in is the
 * entire point of it.
 *
 * Nothing here can fail the write that triggered it. The hook is `post('save')` and everything
 * inside is caught: a mail server that is down must not roll back an approval.
 */
import env from '../config/env.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';
import { mailConfig, sendMail } from './mail/index.js';
import { notificationEmail } from './mail/templates.js';

/** Told about your own action on purpose — the only type where that is the point. */
const ABOUT_YOURSELF = new Set(['new-sign-in', 'account-approved']);

/**
 * A sentence for the subject line.
 *
 * Deliberately short of detail. The subject travels through every mail server between here and
 * the recipient and sits in notification previews on lock screens, so it names the engagement at
 * most — never the finding, never the severity. The body says where to look; the app says what.
 */
const HEADLINES = {
  mention: 'You were mentioned',
  'review-requested': 'A review was requested',
  'comment-on-your-finding': 'A comment on your finding',
  'check-assigned': 'A test check was assigned to you',
  'new-sign-in': 'A new sign-in to your account',
  'booking-soon': 'An engagement starts soon',
  'booking-changed': 'An engagement booking changed',
  'leave-requested': 'A leave request needs a decision',
  'leave-decided': 'Your leave request was decided',
  'engagement-due': 'An engagement is due',
  'engagement-held': 'An engagement was put on hold',
  'account-awaiting-approval': 'An account is waiting for approval',
  'account-approved': 'Your account was approved',
  'client-updated-finding': 'The client updated a finding',
};

/** The client route, made absolute. A relative href in a mail client goes nowhere. */
const absolute = (href) => {
  const path = String(href ?? '').trim();
  if (!path) return '';
  if (/^https?:\/\//i.test(path)) return path;
  return `${env.appUrl}${path.startsWith('/') ? '' : '/'}${path}`;
};

/**
 * Sends one notification on, if all three gates are open.
 *
 * Exported so the mail test can drive it directly with a plain object, which is also why it takes
 * a notification rather than reading one back out of the database.
 */
export async function mailNotification(notification) {
  const settings = await Settings.getSettings();
  const config = await mailConfig(settings);
  if (!config.enabled || !config.notifications) return { sent: false, reason: config.reason ?? 'off' };

  /*
   * A notification with no actor passes this untouched, which is what a client's change through
   * their own link needs: there is nobody to compare the recipient against.
   */
  if (!ABOUT_YOURSELF.has(notification.type) && notification.actor) {
    if (String(notification.actor) === String(notification.user)) {
      return { sent: false, reason: 'the recipient caused it' };
    }
  }

  const recipient = await User.findById(notification.user).select(
    'email firstname lastname username emailNotifications enabled'
  );
  if (!recipient?.email || recipient.enabled === false) {
    return { sent: false, reason: 'no reachable recipient' };
  }
  if (recipient.emailNotifications === false) return { sent: false, reason: 'the recipient opted out' };

  const appName = settings.branding?.appName || 'Engy Report';
  const headline = HEADLINES[notification.type] ?? 'Something needs your attention';
  const body = notificationEmail({
    appName,
    notification: {
      title: notification.auditName ? `${headline} — ${notification.auditName}` : headline,
      body: notification.message || '',
      context: notification.target ? `On: ${notification.target}` : '',
    },
    url: absolute(notification.href),
  });

  return sendMail(
    {
      to: [{ name: recipient.fullname || recipient.username, email: recipient.email }],
      ...body,
    },
    { settings, config }
  );
}

/**
 * Attaches the hook. Called once, from the server's start-up.
 *
 * A function rather than a side effect of importing this file: a script that pulls in the models
 * to read data — the seeder, the linter, a migration — should not acquire a mail sender by
 * accident, and `installNotificationMail()` at the top of `index.js` is a line somebody can find.
 */
export function installNotificationMail() {
  /*
   * Fire and forget, and swallow everything. The caller is in the middle of recording an approval
   * or a mention; the mail is the part that is allowed to fail on its own.
   */
  const offer = (doc) =>
    mailNotification(doc).catch((error) => {
      log.warn(`Could not email a notification: ${error.message}`);
    });

  Notification.schema.post('save', (doc) => {
    offer(doc);
  });

  /*
   * `insertMany` runs its own hook and none of the save ones — and it is what fans a mention or a
   * review request out to several people at once, which is exactly the case worth mailing. Hooking
   * only `save` would have covered the seven singular callers and silently missed the four that
   * matter most.
   */
  Notification.schema.post('insertMany', (docs) => {
    for (const doc of Array.isArray(docs) ? docs : [docs]) if (doc) offer(doc);
  });

  return true;
}

export default { installNotificationMail, mailNotification };
