/**
 * SMTP, spoken directly.
 *
 * Hand-rolled for the reason the PNG encoder and the TOTP are: the protocol is small, the
 * dependency would be large, and the bytes involved leave the building. What it has to get right
 * is a short list, and each item on it is something a wrapper would otherwise hide:
 *
 * - **Replies are multi-line.** `250-STARTTLS` continues, `250 STARTTLS` ends. A reader that takes
 *   the first line back is a reader that mistakes a capability list for a result.
 * - **STARTTLS is an upgrade, not an option.** After it succeeds the session is new — capabilities
 *   are re-read with a second EHLO, because a server may only offer AUTH once the pipe is private,
 *   and because trusting the plaintext list is how a downgrade goes unnoticed.
 * - **A line beginning with a dot must be doubled**, or the message ends early and the rest of it
 *   is read as commands.
 * - **A refusal has a code.** 535 is a wrong password, 550 after RCPT is a refused recipient, 421 is
 *   the server closing on you. Handing back "send failed" for all three is what makes mail
 *   configuration miserable, so each becomes a sentence somebody can act on.
 *
 * Not implemented, deliberately: pipelining (saves round trips this app will never notice), DSN,
 * and XOAUTH2. Gmail and Microsoft both accept an app password over this, which is the documented
 * path for an application that is not a mail client.
 */
import net from 'node:net';
import os from 'node:os';
import tls from 'node:tls';

const CRLF = '\r\n';

/** Long enough for a slow relay, short enough that a wrong port fails while somebody is watching. */
const DEFAULT_TIMEOUTS = { connect: 20_000, command: 30_000, data: 120_000 };

export class SmtpError extends Error {
  constructor(message, { code = 0, stage = '', response = '' } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.stage = stage;
    this.response = response;
  }
}

/** The sentence a person can act on, for the refusals that actually happen. */
function explain(code, stage, response) {
  if (stage === 'connect') {
    return 'Could not reach the mail server. Check the host and port, and that this machine is allowed out on it.';
  }
  if (stage === 'tls') {
    return 'The TLS handshake failed. Check the security setting — 465 is direct TLS, 587 is STARTTLS — and whether this machine trusts the certificate.';
  }
  if (code === 535 || code === 534 || code === 530) {
    return 'The mail server rejected the username or password. Gmail and Microsoft both want an app password here rather than the account password.';
  }
  if (code === 550 && stage === 'mail-from') {
    return 'The server refused the From address. Most providers insist it matches the account that authenticated.';
  }
  if (code === 550 || code === 553 || code === 554) {
    return 'The server refused a recipient. Check the address, and whether this account may relay to it.';
  }
  if (code === 421) return 'The mail server closed the connection. It may be rate-limiting this account.';
  if (code === 552 || code === 523) {
    return 'The message was refused as too large — a report attachment may be over the provider limit.';
  }
  return `The mail server refused the ${stage} step: ${String(response).split(CRLF)[0]}`;
}

/**
 * One connection's worth of conversation.
 *
 * A class because a session is genuinely stateful: a socket, a buffer, and a capability list that
 * changes under it when TLS comes up. No private fields, because `attach` is called twice — once
 * for the plain socket and again for the TLS socket that replaces it — and both need the same
 * parsing.
 */
class Session {
  constructor(options = {}) {
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts ?? {}) };
    this.socket = null;
    this.buffer = '';
    this.pending = null;
    this.capabilities = new Set();
    /** What was said, minus anything secret — so a failed test send can show its working. */
    this.transcript = [];
  }

  log(line, direction) {
    if (this.transcript.length < 60) this.transcript.push(`${direction} ${line}`);
  }

  /**
   * Points the session at a socket.
   *
   * Called again after STARTTLS. The old socket's listeners are dropped first: its `close`, once
   * the upgrade has taken it over, is not a failure and must not be reported as one.
   */
  attach(socket) {
    if (this.socket) this.socket.removeAllListeners();
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      this.buffer += chunk;
      this.pump();
    });
    socket.on('error', (error) => this.abort(error));
    socket.on('close', () => this.abort(new SmtpError('The connection closed unexpectedly.', { stage: 'socket' })));
  }

  /** Resolves the waiting read as soon as a complete reply is in the buffer. */
  pump() {
    if (!this.pending) return;
    const lines = this.buffer.split(CRLF);
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^\d{3} /.test(lines[i])) continue;
      const reply = lines.slice(0, i + 1).join(CRLF);
      this.buffer = lines.slice(i + 1).join(CRLF);
      const waiting = this.pending;
      this.pending = null;
      clearTimeout(waiting.timer);
      this.log(reply, '<');
      waiting.resolve({ code: Number(reply.slice(0, 3)), text: reply });
      return;
    }
  }

  abort(error) {
    const waiting = this.pending;
    this.pending = null;
    if (!waiting) return;
    clearTimeout(waiting.timer);
    waiting.reject(
      error instanceof SmtpError ? error : new SmtpError(error.message, { stage: 'socket' })
    );
  }

  read(stage, timeout = this.timeouts.command) {
    return new Promise((resolve, reject) => {
      this.pending = {
        resolve,
        reject,
        timer: setTimeout(
          () => this.abort(new SmtpError(`The mail server did not answer the ${stage} step in time.`, { stage })),
          timeout
        ),
      };
      this.pump();
    });
  }

  /** Sends a command and waits for its reply. `secret` keeps a password out of the transcript. */
  async command(line, stage, { expect = [250], timeout, secret = false } = {}) {
    this.log(secret ? '(credentials)' : line, '>');
    this.socket.write(line + CRLF);
    const reply = await this.read(stage, timeout);
    if (expect.length && !expect.includes(reply.code)) {
      throw new SmtpError(explain(reply.code, stage, reply.text), {
        code: reply.code,
        stage,
        response: reply.text,
      });
    }
    return reply;
  }

  readCapabilities(text) {
    this.capabilities = new Set();
    for (const line of String(text).split(CRLF).slice(1)) {
      const value = line.slice(4).trim().toUpperCase();
      if (value) this.capabilities.add(value);
    }
  }

  authMechanisms() {
    for (const capability of this.capabilities) {
      if (capability.startsWith('AUTH ')) return capability.slice(5).split(/\s+/);
    }
    return [];
  }

  async ehlo(hostname) {
    /*
     * HELO is the fallback, not the plan. A server old enough to refuse EHLO can do neither
     * STARTTLS nor AUTH, so what follows will refuse to send a password over it anyway.
     */
    try {
      const reply = await this.command(`EHLO ${hostname}`, 'ehlo');
      this.readCapabilities(reply.text);
    } catch (error) {
      if (error.code !== 500 && error.code !== 502) throw error;
      await this.command(`HELO ${hostname}`, 'helo');
      this.capabilities = new Set();
    }
  }

  async close() {
    if (!this.socket || this.socket.destroyed) return;
    /* Goodbye is a courtesy: the message is already accepted, or already refused. */
    this.socket.removeAllListeners('data');
    this.socket.removeAllListeners('close');
    /*
     * The error listener is replaced rather than removed.
     *
     * `removeAllListeners()` would take it with the rest, and a socket that then failed on the
     * way down — the QUIT write racing the server's own close, which is ordinary — would emit an
     * `error` with nobody listening, and an unhandled `error` event takes the process with it.
     * A send that already succeeded must not be able to stop the server.
     */
    this.socket.removeAllListeners('error');
    this.socket.on('error', () => {});
    try {
      this.socket.write(`QUIT${CRLF}`);
    } catch {
      /* Nothing to do about a socket that has already gone. */
    }
    this.socket.destroy();
  }
}

/** Opens a socket, or fails with a sentence rather than an errno. */
const open = (factory, stage, timeout) =>
  new Promise((resolve, reject) => {
    const socket = factory();
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener(event, onReady);
      fn(value);
    };
    const event = stage === 'tls' ? 'secureConnect' : 'connect';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError(explain(0, stage, ''), { stage }));
    }, timeout);
    const onReady = () => settle(resolve)(socket);
    const onError = (error) =>
      settle(reject)(new SmtpError(`${explain(0, stage, '')} (${error.message})`, { stage }));
    socket.once(event, onReady);
    socket.once('error', onError);
  });

/**
 * Delivers one message.
 *
 * @param {object} options
 * @param {string} options.host
 * @param {number} options.port
 * @param {'tls'|'starttls'|'none'} options.security direct TLS, an upgrade, or neither
 * @param {string} [options.username] no username means no AUTH, for an open internal relay
 * @param {string} [options.password]
 * @param {boolean} [options.allowInvalidCertificates] for a relay with its own CA
 * @param {boolean} [options.allowPlaintextAuth] only ever for a test server on this machine
 * @param {string} [options.clientName] what to call ourselves in EHLO
 * @param {string} options.envelopeFrom
 * @param {string[]} options.recipients
 * @param {string} options.raw the message, headers and all
 * @returns {Promise<{accepted:string[], rejected:{address:string,reason:string}[],
 *   response:string, secure:boolean, transcript:string[]}>}
 */
export async function sendSmtp(options) {
  const {
    host,
    port,
    security = 'starttls',
    username = '',
    password = '',
    allowInvalidCertificates = false,
    allowPlaintextAuth = false,
    clientName = os.hostname() || 'localhost',
    envelopeFrom,
    recipients,
    raw,
  } = options;

  if (!host) throw new SmtpError('No mail server is configured.', { stage: 'config' });
  if (!recipients?.length) throw new SmtpError('No recipients.', { stage: 'config' });

  const session = new Session(options);
  /*
   * No SNI for an IP literal. RFC 6066 forbids it, Node warns that it will start ignoring it, and
   * a relay addressed by number has no name to present a certificate for anyway.
   */
  const isIpLiteral = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
  const tlsOptions = {
    host,
    ...(isIpLiteral ? {} : { servername: host }),
    rejectUnauthorized: !allowInvalidCertificates,
  };

  try {
    const socket =
      security === 'tls'
        ? await open(() => tls.connect({ ...tlsOptions, port }), 'tls', session.timeouts.connect)
        : await open(() => net.connect({ host, port }), 'connect', session.timeouts.connect);
    session.attach(socket);

    await session.read('greeting', session.timeouts.connect);
    await session.ehlo(clientName);

    let secure = security === 'tls';
    if (security === 'starttls') {
      if (!session.capabilities.has('STARTTLS')) {
        throw new SmtpError(
          'The server did not offer STARTTLS, so a password would cross the wire in the clear. Use direct TLS on 465, or set the security to none only for a relay you trust.',
          { stage: 'starttls' }
        );
      }
      await session.command('STARTTLS', 'starttls', { expect: [220] });
      const upgraded = await open(
        () => tls.connect({ ...tlsOptions, socket }),
        'tls',
        session.timeouts.connect
      );
      session.attach(upgraded);
      secure = true;
      /* A new session: the capability list from before the upgrade is not this session's. */
      await session.ehlo(clientName);
    }

    if (username) {
      if (!secure && !allowPlaintextAuth) {
        throw new SmtpError('Refusing to send a password over an unencrypted connection. Use TLS or STARTTLS.', {
          stage: 'auth',
        });
      }
      const mechanisms = session.authMechanisms();
      if (mechanisms.includes('PLAIN') || !mechanisms.length) {
        const token = Buffer.from(`\0${username}\0${password}`, 'utf8').toString('base64');
        await session.command(`AUTH PLAIN ${token}`, 'auth', { expect: [235], secret: true });
      } else if (mechanisms.includes('LOGIN')) {
        await session.command('AUTH LOGIN', 'auth', { expect: [334] });
        await session.command(Buffer.from(username, 'utf8').toString('base64'), 'auth', {
          expect: [334],
          secret: true,
        });
        await session.command(Buffer.from(password, 'utf8').toString('base64'), 'auth', {
          expect: [235],
          secret: true,
        });
      } else {
        throw new SmtpError(
          `The server offers no authentication this understands (${mechanisms.join(', ') || 'none'}).`,
          { stage: 'auth' }
        );
      }
    }

    await session.command(`MAIL FROM:<${envelopeFrom}>`, 'mail-from', { expect: [250] });

    const accepted = [];
    const rejected = [];
    for (const address of recipients) {
      try {
        await session.command(`RCPT TO:<${address}>`, 'rcpt-to', { expect: [250, 251] });
        accepted.push(address);
      } catch (error) {
        /*
         * One bad address does not cancel the send. A report going to four people, one of whom has
         * left the client, should reach the other three — and say who it did not reach.
         */
        if (error.stage !== 'rcpt-to') throw error;
        rejected.push({ address, reason: error.message });
      }
    }
    if (!accepted.length) {
      throw new SmtpError(rejected[0]?.reason ?? 'Every recipient was refused.', { stage: 'rcpt-to' });
    }

    await session.command('DATA', 'data', { expect: [354] });
    /* Dot-stuffed, and guaranteed to end on its own line before the terminator. */
    const body = raw.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
    session.log(`(message, ${Buffer.byteLength(body)} bytes)`, '>');
    session.socket.write(body.endsWith(CRLF) ? body : body + CRLF);
    session.socket.write(`.${CRLF}`);
    const receipt = await session.read('data', session.timeouts.data);
    if (receipt.code !== 250) {
      throw new SmtpError(explain(receipt.code, 'data', receipt.text), {
        code: receipt.code,
        stage: 'data',
        response: receipt.text,
      });
    }

    return {
      accepted,
      rejected,
      response: receipt.text.split(CRLF)[0],
      secure,
      transcript: session.transcript,
    };
  } finally {
    await session.close();
  }
}

export default { sendSmtp, SmtpError };
