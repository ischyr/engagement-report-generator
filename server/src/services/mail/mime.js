/**
 * A message, assembled by hand.
 *
 * Mail is the one place where "it worked when I tested it" is worth the least: the message is
 * parsed by somebody else's client, weeks later, and a header folded in the wrong place turns a
 * report into a download called `part1.bin`. So the rules that matter are written out here rather
 * than assumed, and `mail-test` asserts each of them against the bytes this produces.
 *
 * What it does, and why:
 *
 * - **CRLF everywhere.** SMTP is a line protocol and a bare LF is not a line ending. Node writes
 *   `\n` given the chance, so every join here is explicit.
 * - **RFC 2047 for headers.** A subject with a client's name in it may hold anything; a raw
 *   non-ASCII byte in a header is illegal and gets mangled differently by every server it passes.
 * - **RFC 2231 for filenames**, with a plain `filename=` beside it, because the two halves of the
 *   world read one or the other and a report named in Cyrillic must arrive named.
 * - **Base64 when a part needs it, 7bit when it does not.** Quoted-printable is the third option
 *   and the one with the sharp edges; a body is either plain ASCII in short lines, in which case it
 *   travels as it is, or it is base64. The 998-octet line limit decides.
 *
 * No HTML is generated here. The templates live in `templates.js`, which is prose, and this file
 * is structure — keeping them apart is what stops a wording change from breaking an encoding.
 */
import crypto from 'node:crypto';

const CRLF = '\r\n';

/** SMTP allows 998 octets plus the CRLF. Anything near it travels base64 instead. */
const LINE_LIMIT = 990;

const isAscii = (value) => !/[^\x20-\x7e\t]/.test(String(value ?? ''));

/**
 * The same question for a body, where a line ending is ordinary rather than illegal.
 *
 * Kept separate on purpose. A header may not contain a newline at all — that is header injection —
 * so the two predicates must not be one predicate, and sharing it sent every plain body down the
 * base64 path because it happened to contain the line breaks that make it a body.
 */
const isAsciiText = (value) => !/[^\x20-\x7e\t\r\n]/.test(String(value ?? ''));

/**
 * An address as a header writes it.
 *
 * The display name is quoted rather than left bare: a name containing a comma or a full stop —
 * "Schifirnet, Iulian", "J. Smith Ltd." — parses as two addresses or as a broken one otherwise.
 */
export function formatAddress(address) {
  if (typeof address === 'string') return address.trim();
  const email = String(address?.email ?? '').trim();
  const name = String(address?.name ?? '').trim();
  if (!email) return '';
  if (!name) return email;
  if (isAscii(name)) return `"${name.replace(/[\\"]/g, '\\$&')}" <${email}>`;
  return `${encodeWord(name)} <${email}>`;
}

export const formatAddressList = (list) =>
  (Array.isArray(list) ? list : [list])
    .map((entry) => formatAddress(entry))
    .filter(Boolean)
    .join(', ');

/** Just the addresses, which is what the envelope wants — no names, no angle brackets. */
export function addressesOnly(list) {
  return (Array.isArray(list) ? list : [list])
    .map((entry) => {
      const raw = typeof entry === 'string' ? entry : entry?.email;
      const match = /<([^>]+)>/.exec(String(raw ?? ''));
      return String(match ? match[1] : (raw ?? '')).trim();
    })
    .filter(Boolean);
}

/**
 * Not a validator so much as a refusal to put a newline in a header.
 *
 * Header injection is the one mail bug with a security consequence: an address field carrying
 * `\r\nBcc:` adds a recipient nobody chose. Anything with a control character in it is rejected
 * outright rather than stripped, because a silently altered address is worse than an error.
 */
export function looksLikeAddress(value) {
  const email = String(value ?? '').trim();
  if (!email || /[\s<>,;"\\]/.test(email) || /[\x00-\x1f]/.test(email)) return false;
  return /^[^@]+@[^@.]+(\.[^@.]+)+$/.test(email);
}

/** RFC 2047: a header value that is not ASCII travels base64 inside an encoded word. */
export function encodeWord(value) {
  const text = String(value ?? '');
  if (isAscii(text)) return text;
  /*
   * Split on whole characters, not bytes. An encoded word may be 75 octets, so the chunks are
   * built from the UTF-8 length of each character — a half-encoded emoji is not a character.
   */
  const words = [];
  let chunk = '';
  for (const char of text) {
    const candidate = chunk + char;
    if (Buffer.byteLength(candidate, 'utf8') > 45) {
      words.push(chunk);
      chunk = char;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) words.push(chunk);
  return words.map((part) => `=?UTF-8?B?${Buffer.from(part, 'utf8').toString('base64')}?=`).join(' ');
}

/**
 * Folds a header onto continuation lines at 78 columns where it can.
 *
 * "Where it can" is the whole subtlety: folding is only legal at whitespace, so a single
 * unbreakable token — a long Message-ID, a base64 encoded word — stays over-length rather than
 * being broken into something that no longer means what it said.
 */
export function foldHeader(name, value) {
  const text = String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
  let line = `${name}:`;
  const out = [];
  for (const token of text.split(' ').filter(Boolean)) {
    if (line.length + 1 + token.length > 78 && line !== `${name}:`) {
      out.push(line);
      line = ` ${token}`;
    } else {
      line += ` ${token}`;
    }
  }
  out.push(line);
  return out.join(CRLF);
}

const base64Lines = (buffer) =>
  (Buffer.from(buffer).toString('base64').match(/.{1,76}/g) ?? []).join(CRLF);

/** A body part: as it stands if it is plain and short, base64 otherwise. */
function encodeBody(text) {
  const value = String(text ?? '');
  const safe =
    isAsciiText(value) && !value.split(/\r?\n/).some((line) => line.length > LINE_LIMIT);
  if (safe) return { encoding: '7bit', body: value.replace(/\r?\n/g, CRLF) };
  return { encoding: 'base64', body: base64Lines(Buffer.from(value, 'utf8')) };
}

const boundary = () => `--=_engy_${crypto.randomBytes(12).toString('hex')}`;

/**
 * A filename in a Content-Disposition, both ways round.
 *
 * `filename=` for everything that reads RFC 2183 and nothing newer, `filename*=` for everything
 * that reads RFC 2231. Old clients take the first and ignore the second, new ones prefer the
 * second — so a report called `Rapport été.docx` arrives with its accents in both.
 */
function dispositionFilename(name) {
  const clean = String(name ?? 'attachment').replace(/[\r\n"\\]/g, '_');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/'/g, '%27');
  return `filename="${ascii}"${clean === ascii ? '' : `; filename*=UTF-8''${encoded}`}`;
}

/**
 * Builds the message.
 *
 * @param {object} message
 * @param {{name?:string,email:string}|string} message.from
 * @param {Array} message.to
 * @param {Array} [message.cc]
 * @param {{name?:string,email:string}|string} [message.replyTo]
 * @param {string} message.subject
 * @param {string} [message.text] the plain-text alternative, and the whole body if there is no html
 * @param {string} [message.html]
 * @param {{filename:string, content:Buffer, contentType?:string}[]} [message.attachments]
 * @param {string} [message.messageId] supply one to make a test deterministic
 * @param {Date} [message.date]
 * @returns {{raw: string, messageId: string}} the message, CRLF-terminated, ready for DATA
 */
export function buildMessage(message) {
  const {
    from,
    to,
    cc = [],
    replyTo,
    subject = '',
    text = '',
    html = '',
    attachments = [],
    date = new Date(),
  } = message;

  const domain = (addressesOnly(from)[0] ?? 'localhost').split('@').pop();
  const messageId = message.messageId ?? `<${crypto.randomBytes(16).toString('hex')}@${domain}>`;

  const headers = [
    foldHeader('From', formatAddress(from)),
    foldHeader('To', formatAddressList(to)),
    ...(cc.length ? [foldHeader('Cc', formatAddressList(cc))] : []),
    ...(replyTo ? [foldHeader('Reply-To', formatAddress(replyTo))] : []),
    foldHeader('Subject', encodeWord(subject)),
    foldHeader('Date', date.toUTCString().replace('GMT', '+0000')),
    foldHeader('Message-ID', messageId),
    'MIME-Version: 1.0',
    /* So a client that files by conversation groups a thread of reminders about one engagement. */
    ...(message.references ? [foldHeader('References', message.references)] : []),
    ...(message.inReplyTo ? [foldHeader('In-Reply-To', message.inReplyTo)] : []),
    /* Machine-generated: tells a mailing list not to reply and an autoresponder to stay quiet. */
    'Auto-Submitted: auto-generated',
  ];

  /** text and html as siblings — the client picks, and both say the same thing. */
  const alternative = () => {
    const plain = encodeBody(text || stripToText(html));
    if (!html) {
      return {
        headers: [`Content-Type: text/plain; charset=utf-8`, `Content-Transfer-Encoding: ${plain.encoding}`],
        body: plain.body,
      };
    }
    const rich = encodeBody(html);
    const mark = boundary();
    return {
      headers: [`Content-Type: multipart/alternative; boundary="${mark}"`],
      body: [
        `--${mark}`,
        'Content-Type: text/plain; charset=utf-8',
        `Content-Transfer-Encoding: ${plain.encoding}`,
        '',
        plain.body,
        `--${mark}`,
        'Content-Type: text/html; charset=utf-8',
        `Content-Transfer-Encoding: ${rich.encoding}`,
        '',
        rich.body,
        `--${mark}--`,
      ].join(CRLF),
    };
  };

  const inner = alternative();

  if (!attachments.length) {
    return {
      messageId,
      raw: [...headers, ...inner.headers, '', inner.body, ''].join(CRLF),
    };
  }

  const mark = boundary();
  const parts = [`--${mark}`, ...inner.headers, '', inner.body];
  for (const file of attachments) {
    parts.push(
      `--${mark}`,
      `Content-Type: ${file.contentType || 'application/octet-stream'}; name="${String(
        file.filename ?? 'attachment'
      ).replace(/[^\x20-\x7e]/g, '_')}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; ${dispositionFilename(file.filename)}`,
      '',
      base64Lines(file.content)
    );
  }
  parts.push(`--${mark}--`);

  return {
    messageId,
    raw: [
      ...headers,
      `Content-Type: multipart/mixed; boundary="${mark}"`,
      '',
      parts.join(CRLF),
      '',
    ].join(CRLF),
  };
}

/**
 * The plain-text alternative, when a caller only wrote HTML.
 *
 * Crude on purpose. A real converter is `htmlToPlainText` over in the OOXML layer, and reaching
 * into the report pipeline from the mail layer to reflow a two-paragraph notification would couple
 * them for nothing. Callers who care supply their own `text`.
 */
export function stripToText(html) {
  return String(html ?? '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '  - ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export default { buildMessage, formatAddress, formatAddressList, addressesOnly, looksLikeAddress };
