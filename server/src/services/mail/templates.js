/**
 * What the mail actually says.
 *
 * Prose and layout, kept away from `mime.js` so that changing a sentence cannot break an encoding.
 *
 * Deliberately plain HTML: a table for the shell, inline styles, no external stylesheet, no web
 * font, no image. Mail clients strip `<style>` blocks at their own discretion, block remote images
 * by default and are the last place on earth where a layout table is the right answer. Every
 * message also carries a real plain-text alternative — not a courtesy, since it is what a screen
 * reader and a phone lock screen preview actually read.
 *
 * One rule about content: **a notification email says what happened and where to look, and does
 * not repeat the finding.** The report is confidential and mail is the least controlled channel it
 * could travel down; a subject line naming the client is already as much as should leave.
 */

const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** The frame every message sits in. */
function shell({ appName, heading, lines, action, footer }) {
  const paragraphs = lines
    .filter(Boolean)
    .map(
      (line) =>
        `<p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#2c3140">${line}</p>`
    )
    .join('');

  const button = action
    ? `<p style="margin:22px 0 6px"><a href="${escape(action.url)}" style="display:inline-block;` +
      `padding:10px 18px;border-radius:8px;background:#4150bd;color:#ffffff;font-size:14px;` +
      `font-weight:600;text-decoration:none">${escape(action.label)}</a></p>` +
      /* The bare URL as well: a client that strips the anchor still leaves something clickable. */
      `<p style="margin:0;font-size:12px;color:#7a8194;word-break:break-all">${escape(action.url)}</p>`
    : '';

  return (
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
    `style="background:#f4f5f8;padding:24px 0"><tr><td align="center">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" ` +
    `style="width:560px;max-width:92%;background:#ffffff;border:1px solid #e4e6ec;border-radius:12px">` +
    `<tr><td style="padding:22px 26px 0">` +
    `<p style="margin:0 0 18px;font-size:12px;font-weight:700;letter-spacing:0.08em;` +
    `text-transform:uppercase;color:#4150bd">${escape(appName)}</p>` +
    `<h1 style="margin:0 0 14px;font-size:19px;line-height:1.3;color:#171a22;font-weight:650">` +
    `${escape(heading)}</h1>` +
    `${paragraphs}${button}` +
    `</td></tr><tr><td style="padding:18px 26px 22px">` +
    `<p style="margin:16px 0 0;padding-top:14px;border-top:1px solid #eceef3;font-size:12px;` +
    `line-height:1.5;color:#8b91a1">${footer}</p>` +
    `</td></tr></table></td></tr></table>`
  );
}

const textOf = ({ appName, heading, lines, action, footer }) =>
  [
    appName.toUpperCase(),
    '',
    heading,
    '',
    ...lines.filter(Boolean).map((line) => line.replace(/<[^>]+>/g, '')),
    ...(action ? ['', `${action.label}: ${action.url}`] : []),
    '',
    '--',
    footer.replace(/<[^>]+>/g, ''),
  ].join('\n');

/**
 * A notification, as mail.
 *
 * The inbox entry is the source: whatever it says on screen is what this says, plus a link to the
 * place it points at. Nothing is re-worded here, so the two can never disagree.
 */
export function notificationEmail({ appName, notification, url, unsubscribeNote }) {
  const parts = {
    appName,
    heading: notification.title || 'Something needs your attention',
    lines: [escape(notification.body || ''), notification.context ? escape(notification.context) : ''],
    action: url ? { label: 'Open it', url } : null,
    footer:
      unsubscribeNote ??
      'You are getting this because your account has email notifications switched on. Turn them off under Profile → Notifications.',
  };
  return { subject: notification.title || `${appName} notification`, html: shell(parts), text: textOf(parts) };
}

/**
 * The report going to a client.
 *
 * The covering note is the sender's own words; everything around it is fixed. The hash is in the
 * message on purpose — it is the same hash the delivery register keeps, so the recipient has, in
 * writing, the means to prove which document they were sent.
 */
export function reportEmail({
  appName,
  engagement,
  clientName,
  version,
  message,
  filename,
  hash,
  senderName,
  senderEmail,
}) {
  const note = String(message ?? '').trim();
  const body = note
    ? note
        .split(/\n{2,}/)
        .map((paragraph) => escape(paragraph).replace(/\n/g, '<br>'))
        .join('</p><p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#2c3140">')
    : `Please find the report for <strong>${escape(engagement)}</strong> attached.`;

  const parts = {
    appName,
    heading: version ? `${engagement} — version ${version}` : engagement,
    lines: [
      body,
      `Attached: <strong>${escape(filename)}</strong>`,
      hash
        ? `SHA-256: <span style="font-family:ui-monospace,Consolas,monospace;font-size:12px;` +
          `word-break:break-all">${escape(hash)}</span>`
        : '',
    ],
    action: null,
    footer:
      `Sent by ${escape(senderName)}${senderEmail ? ` &lt;${escape(senderEmail)}&gt;` : ''}` +
      `${clientName ? ` for ${escape(clientName)}` : ''}. ` +
      'This document is confidential. If it has reached you in error, please delete it and tell the sender.',
  };

  return {
    subject: version ? `${engagement} — report version ${version}` : `${engagement} — report`,
    html: shell(parts),
    text: textOf(parts),
  };
}

/**
 * The link a client opens, sent to the client rather than pasted into somebody's own mail.
 *
 * Two wordings, because the two kinds of link ask the reader for opposite things and a single
 * neutral sentence would serve neither. A **status** link is a courtesy: here is how far along we
 * are, nothing is expected of you. A **findings** link is a request: here is what we found, please
 * tell us what you have fixed. Sending the second with the first's wording is how a client comes
 * to believe the link was informational and does nothing with it for three weeks.
 *
 * The expiry is stated plainly, and it is the one detail that must not be left to the covering
 * note. A client who opens the link a month later and finds it dead assumes the report was
 * withdrawn; a client who was told it lasts thirty days simply asks for another.
 *
 * No attachment and no finding text. The mail carries a door, not the room — the report itself
 * goes through `deliveries/send`, which attaches it, hashes it and writes the register. Two
 * messages rather than one, on purpose: the document is the deliverable and the link is the
 * conversation after it, and they have different lifetimes.
 */
export function shareLinkEmail({
  appName,
  engagement,
  clientName,
  kind,
  url,
  expiresAt,
  message,
  senderName,
  senderEmail,
}) {
  const findings = kind !== 'status';
  const note = String(message ?? '').trim();
  const body = note
    ? note
        .split(/\n{2,}/)
        .map((paragraph) => escape(paragraph).replace(/\n/g, '<br>'))
        .join('</p><p style="margin:0 0 14px;font-size:14px;line-height:1.55;color:#2c3140">')
    : findings
      ? `We have finished testing <strong>${escape(engagement)}</strong>. The link below shows what ` +
        'we found, and lets you tell us what you have already fixed.'
      : `The link below shows how <strong>${escape(engagement)}</strong> is progressing. It updates ` +
        'as we go, so there is no need to ask — and it carries no findings.';

  const until = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const parts = {
    appName,
    heading: findings ? `${engagement} — what we found` : `${engagement} — where we are`,
    lines: [
      body,
      findings
        ? 'You can mark anything as fixed, attach a screenshot of the fix, and ask us about a ' +
          'particular finding. We see all of it.'
        : 'Nothing is needed from you.',
      until ? `The link works until <strong>${escape(until)}</strong>.` : '',
      /*
       * Said in the mail, because it is the sentence that stops a client forwarding it to a
       * supplier. Whoever holds this URL is inside, and there is no password behind it.
       */
      'Please treat the address as confidential — anyone who has it can see this page.',
    ],
    action: { label: findings ? 'Open the findings' : 'See where we are', url },
    footer:
      `Sent by ${escape(senderName)}${senderEmail ? ` &lt;${escape(senderEmail)}&gt;` : ''}` +
      `${clientName ? ` for ${escape(clientName)}` : ''}. ` +
      'If this has reached you in error, please delete it and tell the sender.',
  };

  return {
    subject: findings ? `${engagement} — what we found` : `${engagement} — progress`,
    html: shell(parts),
    text: textOf(parts),
  };
}

/**
 * A reminder that findings are still outstanding.
 *
 * The only unprompted mail this application sends to somebody outside the firm, which decides
 * everything about how it reads:
 *
 * **It says what is left, and nothing about what it is.** A number and a name. Severities, titles
 * and counts by rating all belong on the page behind the link, where the reader has already been
 * authenticated by holding the URL — an email is forwarded, quoted and left in mailboxes, and a
 * subject line naming three criticals at a named client is the kind of thing that ends up
 * somewhere it should not.
 *
 * **It carries no link.** Only a hash of the token is kept, so there is nothing to put here — and
 * that turns out to be the right answer anyway: the reader already has the link, and a second URL
 * for the same thing invites them to wonder which one is real.
 *
 * **It says when it will stop.** Somebody who has decided not to act should be able to see the end
 * of it rather than wonder whether this arrives forever. The last one says it is the last one.
 */
export function remediationReminderEmail({
  appName,
  engagement,
  clientName,
  outstanding,
  expiresAt,
  remaining,
  appUrl,
}) {
  const until = expiresAt
    ? new Date(expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
    : '';

  const parts = {
    appName,
    heading: `${engagement} — ${outstanding} still open`,
    lines: [
      `There ${outstanding === 1 ? 'is' : 'are'} still <strong>${outstanding}</strong> ` +
        `finding${outstanding === 1 ? '' : 's'} on <strong>${escape(engagement)}</strong> waiting to ` +
        'be marked as fixed. The link we sent you shows which, and lets you tell us what you have done.',
      until ? `That link works until <strong>${escape(until)}</strong>.` : '',
      remaining > 0
        ? `We will send ${remaining === 1 ? 'one more of these' : `up to ${remaining} more of these`}, and stop as soon as everything is marked.`
        : 'This is the last of these we will send.',
      'If the link has been lost, or somebody else should be receiving this, reply and tell us.',
    ],
    action: null,
    footer:
      `Sent by ${escape(appName)}${clientName ? ` for ${escape(clientName)}` : ''}` +
      `${appUrl ? '' : ''}. Reply to this message to reach the team.`,
  };

  return {
    /* No count and no client name in the subject: see the note above. */
    subject: `${engagement} — findings still open`,
    html: shell(parts),
    text: textOf(parts),
  };
}

/** The test send, which exists to prove one thing and says so. */
export function testEmail({ appName, host, security, by }) {
  const parts = {
    appName,
    heading: 'Email is working',
    lines: [
      `This instance sent this message through <strong>${escape(host)}</strong> over ` +
        `${escape(security === 'tls' ? 'direct TLS' : security === 'starttls' ? 'STARTTLS' : 'an unencrypted connection')}.`,
      'Notifications, review requests and reports can now leave the building.',
    ],
    action: null,
    footer: `Triggered from Settings → Email by ${escape(by)}.`,
  };
  return { subject: `${appName}: email is working`, html: shell(parts), text: textOf(parts) };
}

export default { notificationEmail, reportEmail, testEmail };
