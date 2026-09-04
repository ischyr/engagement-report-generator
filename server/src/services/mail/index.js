/**
 * Sending mail: the one door, and the transport behind it.
 *
 * Everything that wants to send goes through `sendMail`. It reads the instance's own settings,
 * refuses politely when mail is switched off, builds the message and hands it to a transport —
 * and *which* transport is a lookup rather than an import, which is the seam. `smtp` speaks the
 * protocol in `smtp.js`; `capture` keeps messages in memory so the tests can read the bytes that
 * would have gone out. A `nodemailer` adapter would be a third entry and nothing above this line
 * would change.
 *
 * The password never travels to the browser and never sits in the database in the clear:
 *
 *   1. `SMTP_PASSWORD` in the environment wins, which is how a container should be configured.
 *   2. Otherwise the one stored in Settings, encrypted with the same vault as client credentials.
 *
 * Off by default. An instance that has never been configured sends nothing rather than throwing on
 * every notification, because a report tool whose findings tab breaks when the mail server moves is
 * a report tool nobody trusts.
 */
import { Settings } from '../../models/settings.model.js';
import { decryptSecret, vaultEnabled } from '../vault.service.js';
import { log } from '../../utils/logger.js';
import { addressesOnly, buildMessage, looksLikeAddress } from './mime.js';
import { sendSmtp, SmtpError } from './smtp.js';

/**
 * The providers people actually use, and the settings they document.
 *
 * Presets rather than a wizard: the only thing anybody wants from this list is not having to
 * remember whether Microsoft is 587 or 465 this year. `note` is shown under the form, because for
 * both of the big two the real obstacle is that an account password will not work.
 */
export const MAIL_PROVIDERS = {
  gmail: {
    label: 'Gmail / Google Workspace',
    host: 'smtp.gmail.com',
    port: 587,
    security: 'starttls',
    note: 'Use an App Password, not the account password: Google Account → Security → 2-Step Verification → App passwords. The From address must be the account itself or one of its verified aliases.',
  },
  outlook: {
    label: 'Outlook / Microsoft 365',
    host: 'smtp-mail.outlook.com',
    port: 587,
    security: 'starttls',
    note: 'Microsoft 365 tenants usually want smtp.office365.com and SMTP AUTH enabled for the mailbox; personal Outlook.com accounts want smtp-mail.outlook.com and an app password.',
  },
  office365: {
    label: 'Microsoft 365 (tenant)',
    host: 'smtp.office365.com',
    port: 587,
    security: 'starttls',
    note: 'An admin must turn on Authenticated SMTP for the mailbox (Exchange admin → Mail flow), and the From address must be that mailbox or one it may send as.',
  },
  fastmail: {
    label: 'Fastmail',
    host: 'smtp.fastmail.com',
    port: 465,
    security: 'tls',
    note: 'Create an app password scoped to SMTP under Settings → Privacy & Security.',
  },
  zoho: {
    label: 'Zoho Mail',
    host: 'smtp.zoho.com',
    port: 465,
    security: 'tls',
    note: 'Use an application-specific password if two-factor authentication is on.',
  },
  custom: {
    label: 'Something else',
    host: '',
    port: 587,
    security: 'starttls',
    note: 'Port 587 with STARTTLS is the usual pair; 465 is direct TLS. Port 25 with no security only makes sense for a relay on your own network.',
  },
};

/** Messages a `capture` transport has kept, newest last. Only ever read by the tests. */
export const captured = [];

const TRANSPORTS = {
  async smtp(message, config) {
    return sendSmtp({
      host: config.host,
      port: config.port,
      security: config.security,
      username: config.username,
      password: config.password,
      allowInvalidCertificates: config.allowInvalidCertificates,
      allowPlaintextAuth: config.allowPlaintextAuth,
      clientName: config.clientName,
      envelopeFrom: addressesOnly(config.from)[0],
      recipients: message.recipients,
      raw: message.raw,
      timeouts: config.timeouts,
    });
  },

  /** Sends nothing, remembers everything. The transport the mail test runs against. */
  async capture(message) {
    captured.push(message);
    return {
      accepted: message.recipients,
      rejected: [],
      response: '250 captured',
      secure: true,
      transcript: [],
    };
  },
};

/**
 * The instance's mail configuration, resolved and ready to use.
 *
 * @returns {Promise<{enabled:boolean, reason?:string, transport:string, host:string, port:number,
 *   security:string, username:string, password:string, from:{name:string,email:string},
 *   replyTo:string, allowInvalidCertificates:boolean, notifications:boolean}>}
 */
export async function mailConfig(settingsDoc = null) {
  const settings = settingsDoc ?? (await Settings.getSettings());
  const email = settings.email ?? {};

  const password = readPassword(email);
  const config = {
    enabled: Boolean(email.enabled),
    transport: process.env.MAIL_TRANSPORT || 'smtp',
    host: String(email.host ?? '').trim(),
    port: Number(email.port) || 587,
    security: email.security ?? 'starttls',
    username: String(email.username ?? '').trim(),
    password,
    from: {
      name: String(email.fromName ?? settings.branding?.appName ?? 'Engy Report'),
      email: String(email.fromAddress ?? '').trim(),
    },
    replyTo: String(email.replyTo ?? '').trim(),
    allowInvalidCertificates: Boolean(email.allowInvalidCertificates),
    allowPlaintextAuth: Boolean(email.allowPlaintextAuth),
    /** Whether notifications go out as mail as well as into the inbox. */
    notifications: email.notifications !== false,
    footer: String(email.footer ?? '').trim(),
  };

  if (!config.enabled) return { ...config, reason: 'Email is switched off in Settings.' };
  if (config.transport === 'smtp' && !config.host) {
    return { ...config, enabled: false, reason: 'No mail server host is configured.' };
  }
  if (!looksLikeAddress(config.from.email)) {
    return { ...config, enabled: false, reason: 'No valid From address is configured.' };
  }
  return config;
}

/**
 * The password, from the environment or from the vault.
 *
 * A stored password that cannot be decrypted returns empty rather than throwing: mail failing to
 * authenticate is a problem for the person configuring it, not a reason for the notification that
 * triggered the send to fail.
 */
function readPassword(email) {
  const fromEnv = String(process.env.SMTP_PASSWORD ?? '').trim();
  if (fromEnv) return fromEnv;
  if (!email?.secret?.data || !vaultEnabled()) return '';
  try {
    return decryptSecret(email.secret);
  } catch {
    log.warn('The stored SMTP password cannot be decrypted with the current VAULT_KEY.');
    return '';
  }
}

/**
 * Sends one message, or explains why it did not.
 *
 * Never throws for a configuration problem — a caller in the middle of approving a finding gets
 * `{ sent: false, reason }` and carries on. It *does* throw for a bad argument, because an empty
 * recipient list is a bug in the caller rather than a state of the world.
 *
 * @param {object} message
 * @param {Array<{name?:string,email:string}|string>} message.to
 * @param {string} message.subject
 * @param {string} [message.text]
 * @param {string} [message.html]
 * @param {{filename:string,content:Buffer,contentType?:string}[]} [message.attachments]
 * @returns {Promise<{sent:boolean, reason?:string, accepted?:string[],
 *   rejected?:{address:string,reason:string}[], messageId?:string, response?:string}>}
 */
export async function sendMail(message, { settings = null, config = null } = {}) {
  const resolved = config ?? (await mailConfig(settings));
  if (!resolved.enabled) return { sent: false, reason: resolved.reason ?? 'Email is not configured.' };

  const recipients = addressesOnly(message.to ?? []).filter((address) => looksLikeAddress(address));
  const refused = addressesOnly(message.to ?? []).filter((address) => !looksLikeAddress(address));
  if (!recipients.length) {
    return {
      sent: false,
      reason: refused.length ? `No usable recipient address (${refused.join(', ')}).` : 'No recipients.',
      rejected: refused.map((address) => ({ address, reason: 'Not a usable email address' })),
    };
  }

  const built = buildMessage({
    from: resolved.from,
    to: message.to,
    replyTo: message.replyTo ?? (resolved.replyTo || undefined),
    subject: message.subject ?? '',
    text: message.text ?? '',
    html: message.html ?? '',
    attachments: message.attachments ?? [],
    messageId: message.messageId,
  });

  const transport = TRANSPORTS[resolved.transport] ?? TRANSPORTS.smtp;
  try {
    const receipt = await transport(
      { recipients, raw: built.raw, subject: message.subject, to: message.to },
      resolved
    );
    return {
      sent: true,
      messageId: built.messageId,
      accepted: receipt.accepted,
      rejected: [...(receipt.rejected ?? []), ...refused.map((address) => ({ address, reason: 'Not a usable email address' }))],
      response: receipt.response,
      secure: receipt.secure,
      transcript: receipt.transcript,
    };
  } catch (error) {
    /*
     * Logged here and returned, not thrown. Every caller is doing something else — recording an
     * approval, saving a delivery — and the mail is the part that may fail without undoing it.
     */
    log.error(`Mail send failed: ${error.message}`);
    return {
      sent: false,
      reason: error.message,
      stage: error instanceof SmtpError ? error.stage : 'unknown',
      response: error instanceof SmtpError ? error.response : '',
    };
  }
}

/** The provider preset for a key, or the custom one. */
export const providerPreset = (key) => MAIL_PROVIDERS[key] ?? MAIL_PROVIDERS.custom;

export { looksLikeAddress };
export default { sendMail, mailConfig, MAIL_PROVIDERS, providerPreset, captured };
