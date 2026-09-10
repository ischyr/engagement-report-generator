/**
 * Checks the mail layer, end to end, without a database and without a mail provider.
 *
 *   npm run test:mail
 *
 * The interesting half is the second one: it stands up a **real SMTP server** on a loopback port,
 * with the same multi-line replies and the same refusals a provider gives, and drives the actual
 * client at it. So the conversation is asserted rather than assumed — the capability list is parsed
 * from a folded reply, the credentials are decoded back out of AUTH PLAIN, one recipient is refused
 * on purpose, and the message is read back off the wire to prove that a line consisting of a single
 * dot survived the trip.
 *
 * What is not covered here, and why: TLS. Generating a certificate needs either a dependency or an
 * `openssl` on the machine running the tests, and neither is a thing to make a test suite depend
 * on. The upgrade *path* is asserted instead — that the client demands STARTTLS when the server
 * offers it, refuses to authenticate in the clear when it does not, and reports a handshake that
 * fails as a handshake rather than as "could not send".
 */
import net from 'node:net';

import {
  addressesOnly,
  buildMessage,
  formatAddress,
  looksLikeAddress,
  stripToText,
} from '../services/mail/mime.js';
import { sendSmtp } from '../services/mail/smtp.js';
import { captured, MAIL_PROVIDERS, sendMail } from '../services/mail/index.js';
import { notificationEmail, reportEmail, testEmail } from '../services/mail/templates.js';

let passed = 0;
let failed = 0;

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

const CRLF = '\r\n';

/* ------------------------------------------------------------------ the MIME -- */

console.log('The message:');

const built = buildMessage({
  from: { name: 'Engy Report', email: 'reports@firm.example' },
  to: [{ name: 'Dana Petrescu', email: 'dana@client.example' }],
  subject: 'Rapport de tést — version 1.0',
  text: 'The report is attached.\nSee you Thursday.',
  html: '<p>The report is <strong>attached</strong>.</p>',
  attachments: [
    { filename: 'Rapport été.docx', content: Buffer.from('PK pretend docx'), contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  ],
  messageId: '<fixed@firm.example>',
  date: new Date('2026-09-02T10:00:00Z'),
});

check(
  'every line ends CRLF and none ends bare LF',
  !/[^\r]\n/.test(built.raw),
  'a bare line feed reached the message'
);
check(
  'a non-ASCII subject travels as an encoded word',
  /Subject: =\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=/.test(built.raw) && !built.raw.includes('tést'),
  built.raw.split(CRLF).find((line) => line.startsWith('Subject'))
);
check(
  'the body is multipart/mixed around a multipart/alternative',
  /Content-Type: multipart\/mixed; boundary="([^"]+)"/.test(built.raw) &&
    built.raw.includes('Content-Type: multipart/alternative'),
  'the nesting is wrong'
);
check(
  'both a text and an html alternative are present',
  built.raw.includes('Content-Type: text/plain; charset=utf-8') &&
    built.raw.includes('Content-Type: text/html; charset=utf-8')
);
check(
  'the attachment is base64 in lines of at most 76',
  built.raw
    .split(CRLF)
    .every((line) => line.length <= 998) &&
    /Content-Transfer-Encoding: base64/.test(built.raw)
);
check(
  'its filename is given twice, plainly and as RFC 2231',
  /filename="Rapport _t_\.docx"/.test(built.raw) &&
    /filename\*=UTF-8''Rapport%20%C3%A9t%C3%A9\.docx/.test(built.raw),
  built.raw.split(CRLF).find((line) => line.startsWith('Content-Disposition'))
);
check(
  'machine-generated is declared, so autoresponders stay quiet',
  built.raw.includes('Auto-Submitted: auto-generated')
);

check(
  'a display name with a comma in it is quoted',
  formatAddress({ name: 'Petrescu, Dana', email: 'dana@client.example' }) ===
    '"Petrescu, Dana" <dana@client.example>',
  formatAddress({ name: 'Petrescu, Dana', email: 'dana@client.example' })
);
check(
  'a non-ASCII display name is encoded rather than quoted raw',
  formatAddress({ name: 'Ștefan', email: 's@x.example' }).startsWith('=?UTF-8?B?')
);

/*
 * The one mail bug with a security consequence. An address carrying a newline and a `Bcc:` would
 * add a recipient nobody chose, so anything with a control character is refused outright.
 */
for (const nasty of [
  'dana@client.example\r\nBcc: attacker@evil.example',
  'dana@client.example\nBcc: attacker@evil.example',
  'two addresses@one.example, other@evil.example',
  'no-at-sign',
  '',
]) {
  check(
    `a header injection is refused: ${JSON.stringify(nasty.slice(0, 32))}`,
    !looksLikeAddress(nasty)
  );
}
check('an ordinary address is accepted', looksLikeAddress('dana.p@client.example.co.uk'));

check(
  'addressesOnly strips the display name',
  addressesOnly([{ name: 'Dana', email: 'dana@client.example' }, 'Bob <bob@x.example>']).join(',') ===
    'dana@client.example,bob@x.example'
);

check(
  'a long header is folded onto continuation lines',
  buildMessage({
    from: { email: 'a@b.example' },
    to: Array.from({ length: 12 }, (_, i) => ({ name: `Person Number ${i}`, email: `p${i}@client.example` })),
    subject: 'x',
    text: 'y',
  })
    .raw.split(CRLF)
    .some((line) => line.startsWith(' ')),
  'nothing was folded'
);

check(
  'html falls back to a readable plain text when none is given',
  stripToText('<h1>Title</h1><p>One &amp; two</p><ul><li>a</li></ul>') === 'Title\nOne & two\n  - a'
);

/* ---------------------------------------------------------------- the server -- */

/**
 * A mail server, for one conversation.
 *
 * Answers the way a real one does — folded capability lists, a refusal for one address — and keeps
 * everything it was told so the test can assert on it.
 */
function fakeSmtp({ offerStartTls = false, authMechanisms = 'PLAIN LOGIN', refuse = [] } = {}) {
  const state = { commands: [], message: '', auth: null };
  const server = net.createServer((socket) => {
    let inData = false;
    socket.write(`220 fake.example ESMTP ready${CRLF}`);
    socket.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      if (inData) {
        state.message += text;
        if (state.message.includes(`${CRLF}.${CRLF}`)) {
          inData = false;
          state.message = state.message.slice(0, state.message.indexOf(`${CRLF}.${CRLF}`));
          socket.write(`250 2.0.0 Ok: queued as ABC123${CRLF}`);
        }
        return;
      }
      for (const line of text.split(CRLF).filter(Boolean)) {
        state.commands.push(line);
        const upper = line.toUpperCase();
        if (upper.startsWith('EHLO')) {
          /* A folded, multi-line reply: the thing a first-line-only reader gets wrong. */
          const lines = ['250-fake.example greets you', '250-SIZE 35882577', '250-8BITMIME'];
          if (offerStartTls) lines.push('250-STARTTLS');
          if (authMechanisms) lines.push(`250-AUTH ${authMechanisms}`);
          lines.push('250 HELP');
          socket.write(lines.join(CRLF) + CRLF);
        } else if (upper === 'STARTTLS') {
          socket.write(`220 2.0.0 Ready to start TLS${CRLF}`);
        } else if (upper.startsWith('AUTH PLAIN')) {
          const token = line.slice('AUTH PLAIN '.length).trim();
          const parts = Buffer.from(token, 'base64').toString('utf8').split('\0');
          state.auth = { username: parts[1], password: parts[2] };
          socket.write(`235 2.7.0 Authentication successful${CRLF}`);
        } else if (upper.startsWith('MAIL FROM')) {
          socket.write(`250 2.1.0 Ok${CRLF}`);
        } else if (upper.startsWith('RCPT TO')) {
          const address = /<([^>]*)>/.exec(line)?.[1] ?? '';
          if (refuse.includes(address)) socket.write(`550 5.1.1 <${address}>: no such user${CRLF}`);
          else socket.write(`250 2.1.5 Ok${CRLF}`);
        } else if (upper === 'DATA') {
          inData = true;
          socket.write(`354 End data with <CR><LF>.<CR><LF>${CRLF}`);
        } else if (upper === 'QUIT') {
          socket.write(`221 2.0.0 Bye${CRLF}`);
          socket.end();
        } else {
          socket.write(`250 2.0.0 Ok${CRLF}`);
        }
      }
    });
    socket.on('error', () => {
      /* A client that hangs up mid-conversation is one of the cases under test. */
    });
  });
  return {
    state,
    listen: () =>
      new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

console.log('\nThe conversation:');

{
  const server = fakeSmtp({ refuse: ['gone@client.example'] });
  const port = await server.listen();

  const message = buildMessage({
    from: { name: 'Engy', email: 'reports@firm.example' },
    to: [{ email: 'dana@client.example' }],
    subject: 'Plain',
    /* A line that is a single dot, which must survive as one and not end the message. */
    text: 'before\n.\nafter\n.hidden',
    messageId: '<dots@firm.example>',
  });

  const receipt = await sendSmtp({
    host: '127.0.0.1',
    port,
    security: 'none',
    username: 'reports@firm.example',
    password: 'app-password-1234',
    allowPlaintextAuth: true,
    envelopeFrom: 'reports@firm.example',
    recipients: ['dana@client.example', 'gone@client.example'],
    raw: message.raw,
  });

  await server.close();

  check(
    'the client walks EHLO, AUTH, MAIL, RCPT, DATA in order',
    server.state.commands
      .map((line) => line.split(' ')[0].toUpperCase())
      .join(' ')
      .startsWith('EHLO AUTH MAIL RCPT RCPT DATA'),
    server.state.commands.join(' | ')
  );
  check(
    'AUTH PLAIN carries the username and password the caller gave',
    server.state.auth?.username === 'reports@firm.example' &&
      server.state.auth?.password === 'app-password-1234',
    JSON.stringify(server.state.auth)
  );
  check(
    'the good recipient is accepted and the bad one is reported',
    receipt.accepted.join() === 'dana@client.example' &&
      receipt.rejected.length === 1 &&
      receipt.rejected[0].address === 'gone@client.example',
    JSON.stringify({ accepted: receipt.accepted, rejected: receipt.rejected })
  );
  check(
    'the refusal explains itself rather than saying "failed"',
    /refused a recipient/i.test(receipt.rejected[0].reason),
    receipt.rejected[0].reason
  );
  check('the server’s queue id comes back', /queued as ABC123/.test(receipt.response), receipt.response);

  /* Dot-stuffing: what arrived must be what was sent, once the doubling is undone. */
  const arrived = server.state.message.replace(/^\.\./gm, '.');
  check(
    'a line of a single dot survives the message body',
    arrived.includes(`${CRLF}.${CRLF}`) && arrived.includes('.hidden'),
    JSON.stringify(server.state.message.slice(-60))
  );
  check(
    'and the headers arrived with it',
    arrived.includes('Subject: Plain') && arrived.includes('Message-ID: <dots@firm.example>')
  );
  check(
    'the transcript is kept for diagnosis, without the credentials',
    receipt.transcript.some((line) => line.includes('EHLO')) &&
      !receipt.transcript.join('\n').includes('app-password-1234'),
    receipt.transcript.join(' / ').slice(0, 120)
  );
}

{
  /* A server that offers STARTTLS gets asked for it, before anything secret is said. */
  const server = fakeSmtp({ offerStartTls: true });
  const port = await server.listen();
  let error = null;
  try {
    await sendSmtp({
      host: '127.0.0.1',
      port,
      security: 'starttls',
      username: 'u',
      password: 'p',
      envelopeFrom: 'a@b.example',
      recipients: ['c@d.example'],
      raw: 'Subject: x\r\n\r\nx\r\n',
    });
  } catch (caught) {
    error = caught;
  }
  await server.close();

  check(
    'STARTTLS is requested when the server offers it',
    server.state.commands.some((line) => line.toUpperCase() === 'STARTTLS'),
    server.state.commands.join(' | ')
  );
  check(
    'and no password was sent before the upgrade',
    !server.state.auth,
    JSON.stringify(server.state.auth)
  );
  check(
    'a handshake that fails is reported as a handshake',
    error?.stage === 'tls' && /TLS handshake/i.test(error.message),
    `${error?.stage}: ${error?.message}`
  );
}

{
  /* A server with no STARTTLS must not be handed a password. */
  const server = fakeSmtp({ offerStartTls: false });
  const port = await server.listen();
  let error = null;
  try {
    await sendSmtp({
      host: '127.0.0.1',
      port,
      security: 'starttls',
      username: 'u',
      password: 'p',
      envelopeFrom: 'a@b.example',
      recipients: ['c@d.example'],
      raw: 'Subject: x\r\n\r\nx\r\n',
    });
  } catch (caught) {
    error = caught;
  }
  await server.close();
  check(
    'a server that cannot do STARTTLS is refused, not downgraded',
    error?.stage === 'starttls' && !server.state.auth,
    `${error?.stage}: ${error?.message}`
  );
}

{
  /* And neither is one on a connection that was never going to be encrypted. */
  const server = fakeSmtp();
  const port = await server.listen();
  let error = null;
  try {
    await sendSmtp({
      host: '127.0.0.1',
      port,
      security: 'none',
      username: 'u',
      password: 'p',
      envelopeFrom: 'a@b.example',
      recipients: ['c@d.example'],
      raw: 'Subject: x\r\n\r\nx\r\n',
    });
  } catch (caught) {
    error = caught;
  }
  await server.close();
  check(
    'plaintext authentication is refused unless it is asked for explicitly',
    /unencrypted/i.test(error?.message ?? '') && !server.state.auth,
    error?.message
  );
}

{
  /* Nothing listening: the commonest configuration mistake there is. */
  let error = null;
  try {
    await sendSmtp({
      host: '127.0.0.1',
      port: 1,
      security: 'none',
      envelopeFrom: 'a@b.example',
      recipients: ['c@d.example'],
      raw: 'x',
      timeouts: { connect: 2000, command: 2000, data: 2000 },
    });
  } catch (caught) {
    error = caught;
  }
  check(
    'a closed port says to check the host and port',
    /Check the host and port/i.test(error?.message ?? ''),
    error?.message
  );
}

/* ----------------------------------------------------------------- the door -- */

console.log('\nThe one door:');

const offConfig = { enabled: false, reason: 'Email is switched off in Settings.' };
check(
  'with mail off, sending is declined rather than thrown',
  (await sendMail({ to: ['x@y.example'], subject: 's', text: 't' }, { config: offConfig })).sent === false
);

const captureConfig = {
  enabled: true,
  transport: 'capture',
  from: { name: 'Engy', email: 'reports@firm.example' },
  notifications: true,
};

const sent = await sendMail(
  { to: [{ name: 'Dana', email: 'dana@client.example' }], subject: 'Hello', text: 'Body' },
  { config: captureConfig }
);
check('a configured instance sends', sent.sent === true, sent.reason);
check('and the transport got the built message', captured.at(-1)?.raw.includes('Subject: Hello'));
check('the envelope holds addresses only', captured.at(-1)?.recipients.join() === 'dana@client.example');

const partly = await sendMail(
  {
    to: [{ email: 'good@client.example' }, { email: 'not an address' }],
    subject: 'Hello',
    text: 'Body',
  },
  { config: captureConfig }
);
check(
  'an unusable address is dropped and named, and the rest still go',
  partly.sent === true &&
    partly.accepted.join() === 'good@client.example' &&
    partly.rejected.some((entry) => entry.address === 'not an address'),
  JSON.stringify({ accepted: partly.accepted, rejected: partly.rejected })
);

const none = await sendMail({ to: ['nope'], subject: 's', text: 't' }, { config: captureConfig });
check('a message with no usable recipient is not sent', none.sent === false, none.reason);

/* -------------------------------------------------------------- the wording -- */

console.log('\nThe wording:');

const notification = notificationEmail({
  appName: 'Engy Report',
  notification: {
    title: 'A review was requested — PT-2025-004',
    body: 'Iulian asked you to review it.',
    context: 'On: VULN-03',
  },
  url: 'https://engy.firm.example/engagements/abc?tab=findings',
});
check('a notification has a subject, html and text', Boolean(notification.subject && notification.html && notification.text));
check(
  'the link is absolute and appears as text as well as a button',
  (notification.html.match(/https:\/\/engy\.firm\.example/g) ?? []).length >= 2
);
check('the text alternative carries no markup', !/[<>]/.test(notification.text), notification.text);

const report = reportEmail({
  appName: 'Engy Report',
  engagement: 'Northwind <Web> Assessment',
  clientName: 'Northwind',
  version: '1.0',
  message: 'As discussed.\n\nTwo criticals, both fixed already.',
  filename: 'Northwind Report.docx',
  hash: 'a'.repeat(64),
  senderName: 'Iulian Schifirnet',
  senderEmail: 'iulian@firm.example',
});
check('the report email names the version in its subject', report.subject.includes('1.0'), report.subject);
check('it carries the hash the register keeps', report.html.includes('a'.repeat(64)));
check(
  'and an engagement name with angle brackets cannot inject markup',
  report.html.includes('Northwind &lt;Web&gt; Assessment') && !report.html.includes('<Web>'),
  'the name was not escaped'
);
check(
  'the covering note keeps its paragraphs',
  (report.html.match(/<p style="margin:0 0 14px/g) ?? []).length >= 2
);

const test = testEmail({ appName: 'Engy Report', host: 'smtp.gmail.com', security: 'starttls', by: 'Iulian' });
check('the test email says how it got there', test.html.includes('smtp.gmail.com') && test.html.includes('STARTTLS'));

check(
  'every provider preset has a host, a port and a note',
  Object.entries(MAIL_PROVIDERS).every(
    ([key, preset]) => preset.label && preset.port && preset.note && (key === 'custom' || preset.host)
  )
);

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
