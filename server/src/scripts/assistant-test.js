/**
 * Checks the optional assistant.
 *
 *   npm run test:assistant
 *
 * No key, no provider, no database. Everything the assistant does that could hurt somebody is a
 * pure function or a single HTTP request, and both are testable here: the prompts are built by pure
 * builders, the answers are parsed by pure parsers, and the two wire shapes are pointed at a
 * throwaway server on an ephemeral port that answers exactly what a provider would.
 *
 * What is actually being asserted, in order of how much it matters:
 *
 *   1. **What leaves the machine.** Redaction of every secret shape it claims to know, and — just
 *      as important — that it does not eat ordinary tool output, because a redactor that ruins
 *      the summary is one people switch off.
 *   2. **That the model's output cannot become markup.** Every job escapes what comes back before
 *      it becomes HTML. A provider that returned a `<script>` tag is not a hypothetical when the
 *      endpoint is a field an administrator typed into a form.
 *   3. **That a refusal is reported as a refusal.** The whole configuration story rests on the test
 *      button saying what the provider said, rather than "it did not work".
 */
import http from 'node:http';

import { redact, redactAndTrim } from '../services/assistant/redact.js';
import {
  enumerationJob,
  libraryJob,
  paragraphsToHtml,
  plainText,
  REWRITABLE,
  rewriteJob,
  summaryJob,
} from '../services/assistant/jobs.js';
import { ASSISTANT_PROVIDERS, askAssistant, providerPreset } from '../services/assistant/index.js';
import { captured, setCaptureReply, WIRES } from '../services/assistant/wire.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/* -------------------------------------------------------------------------- */
console.log('\nThe provider presets:');

/*
 * A preset is configuration somebody will trust without checking, so the things that would waste
 * their afternoon are asserted rather than reviewed: a wire shape that does not exist, a URL that
 * will not compose, a provider that needs a key and has nowhere to send it. Every preset added
 * later is covered by these without anybody remembering to write a test for it.
 */
for (const [key, preset] of Object.entries(ASSISTANT_PROVIDERS)) {
  check(`${key}: names a wire shape that exists`, Boolean(WIRES[preset.wire]), preset.wire);
  check(`${key}: has a label and a note worth reading`, Boolean(preset.label) && preset.note.length > 40);
  check(
    `${key}: a provider that needs a key has somewhere to send it`,
    !preset.keyRequired || preset.wire === 'anthropic' || Boolean(preset.endpoint),
    preset.endpoint
  );
  if (preset.endpoint) {
    check(`${key}: the endpoint is a URL`, URL.canParse(preset.endpoint), preset.endpoint);
    check(
      `${key}: with no trailing slash to double up`,
      !preset.endpoint.endsWith('/'),
      preset.endpoint
    );
  }
}

/* The two that carry a model name carry an alias, not a dated snapshot that will rot. */
check(
  'anthropic points at a stable model alias',
  ASSISTANT_PROVIDERS.anthropic.model === 'claude-opus-5',
  ASSISTANT_PROVIDERS.anthropic.model
);
check(
  'deepseek points at the chat-completions host, where /chat/completions lives',
  `${ASSISTANT_PROVIDERS.deepseek.endpoint}/chat/completions` ===
    'https://api.deepseek.com/chat/completions',
  ASSISTANT_PROVIDERS.deepseek.endpoint
);
check(
  'and at a model name that tracks the current version',
  ASSISTANT_PROVIDERS.deepseek.model === 'deepseek-v4-pro',
  ASSISTANT_PROVIDERS.deepseek.model
);
check(
  "the local runtime asks for no key, because it does not want one",
  ASSISTANT_PROVIDERS.ollama.keyRequired === false
);
check('an unknown provider falls back to custom', providerPreset('nope') === ASSISTANT_PROVIDERS.custom);

/* -------------------------------------------------------------------------- */
console.log('\nWhat never leaves the machine:');

const LEAKY = [
  '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g',
  'Cookie: session=8f4b2c1d9e0a7b6c5d4e3f2a1b0c9d8e; theme=dark',
  'curl -H "X-Api-Key: sk-proj-abcdefghijklmnopqrstuvwx" https://api.example.com',
  'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345',
  'AKIAIOSFODNN7EXAMPLE',
  'smbclient //10.0.0.5/share -U admin --password=Summer2024!',
  'Administrator:500:aad3b435b51404eeaad3b435b51404ee:31d6cfe0d16ae931b73c59d7e0c089c0:::',
  'root:$6$saltsalt$8Xk9lPq2mNvRtYuIoP3aSdFgHjKlZxCvBnM1234567890abcdefghij:19000:0:99999:7:::',
  'mysql://report:hunter2@db.internal:3306/findings',
];

for (const line of LEAKY) {
  const result = redact(line);
  check(
    `${result.kinds[0] ?? 'nothing'} is removed from: ${line.slice(0, 44)}…`,
    result.removed > 0,
    'nothing matched'
  );
}

const jwt = redact('token=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g');
check('and the value is actually gone', !jwt.text.includes('dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1g'), jwt.text);

const named = redact('--password=Summer2024! --user admin');
check(
  'a password keeps its name and loses its value',
  named.text.includes('password=') && !named.text.includes('Summer2024'),
  named.text
);

/*
 * The other half, and the half a redactor usually fails.
 *
 * Everything below is a line of real tool output with nothing secret in it. A pattern that eats any
 * of these costs the enumeration summary its meaning, and a summary that has been redacted into
 * uselessness teaches people to turn the whole feature off.
 */
const INNOCENT = [
  'Nmap scan report for mail.example.com (203.0.113.24)',
  '443/tcp open  https   nginx 1.24.0',
  'Discovered subdomain: staging-api-2.internal.example.com',
  'HTTP/1.1 200 OK  Content-Length: 51823',
  '[INFO] 1412 hosts scanned, 9 up, 0 filtered in 41.20 seconds',
  'GET /admin/users?page=2&sort=created_at HTTP/1.1',
  'sha256:9f2c4e1a7b3d5f8c0e6a2b4d1f3c5e7a9b0d2f4c6e8a1b3d5f7c9e0a2b4d6f8c  release.tar.gz',
];

INNOCENT.push('nmap -sV -p 22,80,443,8080 10.0.0.0/24');
INNOCENT.push('The password policy allowed six characters, so the password was guessed in minutes.');

for (const line of INNOCENT) {
  const result = redact(line);
  check(`ordinary output survives: ${line.slice(0, 44)}…`, result.removed === 0, result.text);
}

const big = redactAndTrim(`START ${'x'.repeat(40_000)} END`, 2000);
check('a huge output is trimmed', big.text.length < 2200 && big.truncated, String(big.text.length));
check(
  'and keeps both ends, because a tool concludes on its last line',
  big.text.startsWith('START') && big.text.trimEnd().endsWith('END'),
  big.text.slice(0, 20)
);

/* -------------------------------------------------------------------------- */
console.log('\nTurning HTML into something worth sending:');

check(
  'tags go, list markers stay',
  plainText('<p>One</p><ul><li>Two</li><li>Three</li></ul>') === 'One\n- Two\n- Three',
  JSON.stringify(plainText('<p>One</p><ul><li>Two</li><li>Three</li></ul>'))
);
check(
  'entities come back as characters',
  plainText('<p>a &amp; b &lt;tag&gt; &quot;q&quot;</p>') === 'a & b <tag> "q"',
  plainText('<p>a &amp; b &lt;tag&gt; &quot;q&quot;</p>')
);
check('scripts do not survive as text', !plainText('<script>alert(1)</script>x').includes('alert'));

/* -------------------------------------------------------------------------- */
console.log('\nAnd nothing the model says becomes markup:');

const hostile = '<img src=x onerror=alert(1)> and <script>fetch("//evil")</script>';
const asHtml = paragraphsToHtml(hostile);
check('a paragraph is escaped', !asHtml.includes('<img') && asHtml.includes('&lt;img'), asHtml);
check('two blank-line-separated blocks become two paragraphs', paragraphsToHtml('a\n\nb') === '<p>a</p><p>b</p>');
check('a single newline becomes a break', paragraphsToHtml('a\nb') === '<p>a<br />b</p>');

const rewritten = rewriteJob.parse('Intro line.\n\n- first <b>item</b>\n- second item');
check(
  'a bulleted block becomes a real list',
  rewritten.html === '<p>Intro line.</p><ul><li>first &lt;b&gt;item&lt;/b&gt;</li><li>second item</li></ul>',
  rewritten.html
);

/* -------------------------------------------------------------------------- */
console.log('\nThe executive summary prompt:');

const brief = {
  name: 'Northwind external test',
  client: 'Northwind Traders',
  type: 'External infrastructure',
  window: '2026-02-02 to 2026-02-13',
  scope: '18 hosts across 2 groups',
  findings: [
    { identifier: '#1', title: 'Unauthenticated RCE in the file uploader', severity: 'Critical', score: 9.8, status: 'open', snippet: 'The upload endpoint accepts .jsp' },
    { identifier: '#2', title: 'Session fixation', severity: 'Medium', score: 5.3, status: 'fixed', snippet: '' },
  ],
};

const summary = summaryJob(brief, 'Never write "malicious actor".');
check('the counts are worked out here, not by the model', summary.user.includes('Critical: 1, High: 0, Medium: 1'), summary.user);
check('every finding is listed with its identifier and severity', summary.user.includes('#1 · Critical · CVSS 9.8 · open — Unauthenticated RCE'), summary.user);
check('the house style is carried into the system prompt', summary.system.includes('Never write "malicious actor"'));
check('and it is told not to invent anything', /never invent/i.test(summary.system));
check('the job names itself, so a switched-off job can be refused by name', summary.job === 'summary');

const drafted = summaryJob.parse('One paragraph.\n\nAnd <b>another</b>.');
check('the draft comes back as escaped paragraphs', drafted.html === '<p>One paragraph.</p><p>And &lt;b&gt;another&lt;/b&gt;.</p>', drafted.html);

/* -------------------------------------------------------------------------- */
console.log('\nThe rewrite prompt:');

const rewrite = rewriteJob({
  field: 'remediation',
  finding: {
    title: 'Weak SMB credentials',
    severity: 'High',
    remediation: '<p>Rotate the account. It was reachable with --password=Summer2024! from the DMZ.</p>',
  },
});
check('the passage is redacted on the way out', rewrite.redacted === 1, String(rewrite.redacted));
check('and the password is not in the prompt', !rewrite.user.includes('Summer2024'), rewrite.user);
check('the finding is named for context', rewrite.user.includes('Weak SMB credentials'));
check('it is told to keep every fact', /every fact must survive/i.test(rewrite.system));

/*
 * The proof of concept is not a field a rewrite can be asked for. Not a check on a route — a check
 * that the list itself does not contain it, because that list is what the route validates against.
 */
check('the proof of concept is not rewritable', !('poc' in REWRITABLE), Object.keys(REWRITABLE).join());

/* -------------------------------------------------------------------------- */
console.log('\nThe enumeration prompt:');

const enumeration = enumerationJob({
  step: { title: 'SMB sweep', tool: 'crackmapexec', target: '10.0.0.0/24', command: 'cme smb 10.0.0.0/24 -u admin -p Summer2024!' },
  output: `START\n${'noise line\n'.repeat(4000)}9 hosts responded, 2 with signing off\nEND`,
});
check('the command is redacted too', !enumeration.user.includes('Summer2024'), enumeration.user.slice(0, 200));
check('the output is trimmed and says so', enumeration.truncated === true);
check('the last line survives the trim', enumeration.user.includes('9 hosts responded'), 'the conclusion was cut');
check('it is asked for one sentence', enumeration.maxTokens === 200 && /one sentence/i.test(enumeration.system));

check('the answer is one line, unquoted', enumerationJob.parse('  "Three live hosts."  \nand more').text === 'Three live hosts', enumerationJob.parse('  "Three live hosts."  \nand more').text);
check('and is capped at what the field holds', enumerationJob.parse('x'.repeat(900)).text.length === 600);

/* -------------------------------------------------------------------------- */
console.log('\nThe library match:');

const library = libraryJob({
  finding: { title: 'Stored XSS in the export view', vulnType: 'XSS', description: '<p>The name field is reflected.</p>' },
  candidates: [
    { title: 'Reflected cross-site scripting', category: 'Web', snippet: 'User input is echoed…' },
    { title: 'Stored cross-site scripting', category: 'Web', snippet: 'Input is persisted and rendered…' },
  ],
});
check('the shortlist is numbered for the model to point at', library.user.includes('1. Reflected') && library.user.includes('2. Stored'));
check('a near miss is called out as a wrong answer', /near miss/i.test(library.system));

check('a pick is read back', libraryJob.parse('2\nBecause the input is persisted.').index === 2);
check('and its reason comes with it', libraryJob.parse('2\nBecause the input is persisted.').reason === 'Because the input is persisted.');
check('zero means none of them', libraryJob.parse('0\nNone describe this weakness.').index === null);
check('and so does prose that starts with no number', libraryJob.parse('None of these match.').index === null);
check('a hash in front of the number is still a number', libraryJob.parse('#1\nThis one.').index === 1);

/* -------------------------------------------------------------------------- */
console.log('\nAsking, with nothing configured:');

const OFF = { enabled: false, reason: 'The assistant is switched off in Settings.', jobs: {} };
const refused = await askAssistant({ job: 'summary', system: 's', user: 'u', maxTokens: 10 }, { config: OFF });
check('an unconfigured instance refuses politely rather than throwing', refused.ok === false && refused.stage === 'config');
check('and says what to switch on', refused.reason.includes('switched off'), refused.reason);

const CAPTURE = {
  enabled: true,
  wire: 'capture',
  model: 'test-model',
  key: '',
  endpoint: '',
  timeoutMs: 5000,
  jobs: { summary: true, rewrite: false, enumeration: true, library: true },
};

setCaptureReply('A drafted paragraph.');
const asked = await askAssistant({ job: 'summary', system: 's', user: 'u', maxTokens: 10, redacted: 3 }, { config: CAPTURE });
check('a configured instance answers', asked.ok === true && asked.text === 'A drafted paragraph.');
check('the prompt is what was built', captured.at(-1)?.user === 'u');
check('and the redaction count comes back with the answer', asked.redacted === 3);

const offJob = await askAssistant({ job: 'rewrite', system: 's', user: 'u', maxTokens: 10 }, { config: CAPTURE });
check('a job switched off on its own is refused by name', offJob.ok === false && offJob.reason.includes('house style'), offJob.reason);

/* -------------------------------------------------------------------------- */
console.log('\nAgainst something that answers like a provider:');

/*
 * A throwaway server on an ephemeral port, answering the two wire shapes.
 *
 * This is the only way to test the part that matters most about the configuration story — that a
 * provider's own refusal reaches the person who pressed Test — without a key, a bill or a network.
 */
let mode = 'ok';
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    const sent = JSON.parse(body || '{}');
    const reply = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.url === '/v1/messages') {
      if (mode === 'refusal') {
        return reply(200, {
          id: 'msg_1',
          model: sent.model,
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'cyber', explanation: 'This looks like an attack tool.' },
          usage: { input_tokens: 10, output_tokens: 0 },
        });
      }
      if (mode === 'nokey') {
        return reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
      }
      return reply(200, {
        id: 'msg_1',
        model: sent.model,
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'the assistant is connected.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 6 },
      });
    }

    if (req.url === '/v1/chat/completions') {
      if (mode === 'nokey') {
        return reply(401, { error: { message: 'Incorrect API key provided.' } });
      }
      if (mode === 'html') {
        res.writeHead(502, { 'content-type': 'text/html' });
        return res.end('<html><body>502 Bad Gateway</body></html>');
      }
      if (mode === 'empty') {
        return reply(200, { model: sent.model, choices: [{ message: { content: '' }, finish_reason: 'stop' }] });
      }
      if (mode === 'allthinking') {
        /* What DeepSeek actually returned: the whole budget spent before a word was written. */
        return reply(200, {
          model: sent.model,
          choices: [
            {
              message: { role: 'assistant', content: '', reasoning_content: 'We need answer executive summary…' },
              finish_reason: 'length',
            },
          ],
        });
      }
      if (mode === 'cutoff') {
        return reply(200, {
          model: sent.model,
          choices: [
            { message: { role: 'assistant', content: 'The engagement found four issues, of which' }, finish_reason: 'length' },
          ],
        });
      }
      if (mode === 'echo') {
        return reply(200, {
          model: sent.model,
          /* Hands the request back, so the test can read what was actually sent. */
          choices: [{ message: { role: 'assistant', content: JSON.stringify(sent) }, finish_reason: 'stop' }],
        });
      }
      return reply(200, {
        model: sent.model,
        choices: [{ message: { role: 'assistant', content: 'the assistant is connected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 6 },
      });
    }

    return reply(404, { error: { message: `no route for ${req.url}` } });
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const base = { enabled: true, model: 'a-model', key: 'k', timeoutMs: 5000, jobs: {} };
const PROMPT = { system: 's', user: 'u', maxTokens: 32 };

const anthropicOk = await askAssistant(PROMPT, {
  config: { ...base, wire: 'anthropic', endpoint: origin },
});
check('the Messages API shape works', anthropicOk.ok && anthropicOk.text === 'the assistant is connected.', anthropicOk.reason);
check('empty thinking blocks are not mistaken for the answer', !String(anthropicOk.text).startsWith(' '), anthropicOk.text);
check('and the usage comes back', anthropicOk.usage?.input === 12 && anthropicOk.usage?.output === 6);

const openaiOk = await askAssistant(PROMPT, {
  config: { ...base, wire: 'openai', endpoint: `${origin}/v1` },
});
check('the chat-completions shape works', openaiOk.ok && openaiOk.text === 'the assistant is connected.', openaiOk.reason);
check('and its usage is read from its own field names', openaiOk.usage?.input === 12 && openaiOk.usage?.output === 6);

mode = 'refusal';
const declined = await askAssistant(PROMPT, { config: { ...base, wire: 'anthropic', endpoint: origin } });
check('a policy refusal is reported as a refusal, not a failure', declined.stage === 'refusal', declined.stage);
check('with the category', declined.reason.includes('cyber'), declined.reason);
check("and the provider's own explanation", declined.detail === 'This looks like an attack tool.', declined.detail);

mode = 'nokey';
const badKeyAnthropic = await askAssistant(PROMPT, { config: { ...base, wire: 'anthropic', endpoint: origin } });
check('a rejected key is an auth problem', badKeyAnthropic.stage === 'auth', badKeyAnthropic.stage);
check("and quotes the provider's words", /invalid x-api-key/.test(badKeyAnthropic.detail), badKeyAnthropic.detail);

const badKeyOpenai = await askAssistant(PROMPT, { config: { ...base, wire: 'openai', endpoint: `${origin}/v1` } });
check('the other wire says the same thing', badKeyOpenai.stage === 'auth' && badKeyOpenai.detail === 'Incorrect API key provided.', badKeyOpenai.detail);

mode = 'html';
const notJson = await askAssistant(PROMPT, { config: { ...base, wire: 'openai', endpoint: `${origin}/v1` } });
check('a proxy that answered with HTML is described by what it sent', notJson.detail.includes('502 Bad Gateway'), notJson.detail);

mode = 'empty';
const nothing = await askAssistant(PROMPT, { config: { ...base, wire: 'openai', endpoint: `${origin}/v1` } });
check('an answer with no text is not passed off as an answer', nothing.ok === false && nothing.stage === 'empty');

mode = 'allthinking';
const thoughtItAway = await askAssistant(PROMPT, {
  config: { ...base, wire: 'openai', endpoint: `${origin}/v1` },
});
check(
  'a reasoning model that spent the budget thinking is told apart from a broken endpoint',
  thoughtItAway.stage === 'budget',
  thoughtItAway.stage
);
check(
  'and the message says what actually happened',
  /thinking/i.test(thoughtItAway.reason),
  thoughtItAway.reason
);
check(
  'with something to do about it',
  /Settings/.test(thoughtItAway.detail),
  thoughtItAway.detail
);

mode = 'cutoff';
const cutOff = await askAssistant(PROMPT, {
  config: { ...base, wire: 'openai', endpoint: `${origin}/v1` },
});
check('half an answer is still an answer', cutOff.ok === true && cutOff.text.endsWith('of which'));
check('but it is flagged as cut off rather than passed off', cutOff.cut === true);

/*
 * What actually goes on the wire. The bug this covers shipped: the job's answer budget was sent as
 * the whole budget, and a model that thinks first answered with nothing at all.
 */
mode = 'echo';
const sentPlain = JSON.parse(
  (await askAssistant({ ...PROMPT, maxTokens: 200 }, {
    config: { ...base, wire: 'openai', endpoint: `${origin}/v1` },
  })).text
);
check(
  'the request leaves room to think on top of the answer budget',
  sentPlain.max_tokens > 200,
  String(sentPlain.max_tokens)
);
check('and carries no provider extras when the preset asks for none', !('reasoning_effort' in sentPlain));

const sentDeepSeek = JSON.parse(
  (await askAssistant(PROMPT, {
    config: {
      ...base,
      wire: 'openai',
      endpoint: `${origin}/v1`,
      body: ASSISTANT_PROVIDERS.deepseek.body,
    },
  })).text
);
check(
  "a reasoning provider's preset asks it to think briefly",
  sentDeepSeek.reasoning_effort === 'low' && sentDeepSeek.thinking?.type === 'enabled',
  JSON.stringify({ reasoning_effort: sentDeepSeek.reasoning_effort, thinking: sentDeepSeek.thinking })
);
check(
  'and both parameters sit at the top level, where that provider documents them',
  !('reasoning_effort' in (sentDeepSeek.thinking ?? {})),
  JSON.stringify(sentDeepSeek.thinking)
);

mode = 'ok';
const wrongPath = await askAssistant(PROMPT, {
  config: { ...base, wire: 'openai', endpoint: `${origin}/nope` },
});
check('a wrong base URL says which URL', wrongPath.ok === false && wrongPath.detail.includes('no route for'), wrongPath.detail);

const unreachable = await askAssistant(PROMPT, {
  /* Port 1 on the loopback: refused immediately rather than hanging. */
  config: { ...base, wire: 'openai', endpoint: 'http://127.0.0.1:1/v1' },
});
check('an endpoint that is not there is a connection problem', unreachable.stage === 'connect', unreachable.stage);

server.close();

/* -------------------------------------------------------------------------- */
console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
