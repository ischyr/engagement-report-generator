/**
 * The entry chunk must stay small, and a lazy page must actually load in a browser.
 *
 *   npm run test:chunks --workspace client
 *
 * Two halves, because code splitting fails in two unrelated ways and a build that succeeds proves
 * neither of them did not happen.
 *
 * **The budget.** Splitting is not a thing you do once. A single static `import` of a page in
 * App.jsx — or of the editor from somewhere shared — silently pulls its whole dependency tree back
 * into the entry chunk, the build keeps succeeding, and the 1.81 MB comes back a few hundred
 * kilobytes at a time. So the entry chunk has a number it may not exceed, and the number is
 * checked rather than remembered.
 *
 * **The browser.** `React.lazy` without a `Suspense` boundary above it throws at runtime, not at
 * build time: "A component suspended while responding to synchronous input". The SSR smoke cannot
 * see it, because it renders each page directly rather than through the router. So this drives a
 * real Chrome at a real lazy route and asserts the page arrived.
 *
 * Needs `npm run build` first, and Chrome. Skips the browser half if Chrome is not installed
 * rather than failing, because the budget half is the one that runs in a hurry.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');

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

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.error('\nNo build to measure. Run `npm run build` first.\n');
  process.exit(1);
}

/*
 * The ceiling, gzipped, for what a browser downloads before it can draw the sign-in screen.
 *
 * 118 kB at the time this was written, from 522 kB before the pages were split. 160 kB leaves
 * room for honest growth — a new context, another shared component — while a page or the editor
 * finding its way back into the entry chunk is tens or hundreds of kilobytes and trips this
 * immediately.
 */
const ENTRY_BUDGET_GZIP = 160 * 1024;

console.log('\nWhat a browser downloads before it can show a password box:');
{
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
  const entries = [...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.js)"/g)].map((m) => m[1]);
  check('index.html names an entry chunk', entries.length > 0, html.slice(0, 200));

  let total = 0;
  for (const name of entries) {
    total += gzipSync(fs.readFileSync(path.join(DIST, name)), { level: 9 }).length;
  }
  const kb = (total / 1024).toFixed(1);
  check(
    `the entry is ${kb} kB gzipped, under the ${(ENTRY_BUDGET_GZIP / 1024).toFixed(0)} kB budget`,
    total <= ENTRY_BUDGET_GZIP,
    `${kb} kB — something large is being imported eagerly again; check App.jsx for a static page import`
  );

  const chunks = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
  check('and the rest of the app is in chunks of its own', chunks.length >= 20, `${chunks.length} chunks`);

  /*
   * The editor is the single heaviest thing in the app — ProseMirror, Yjs, the collaboration
   * plugins. Nobody signing in should be given it, so it having its own chunk is the specific
   * property worth asserting rather than inferring from the total.
   */
  const editor = chunks.find((name) => /RichTextEditor|tiptap|prosemirror/i.test(name));
  check('the rich text editor is not in the entry chunk', Boolean(editor), 'no editor chunk found');
}

/* ------------------------------------------------------------------ browser --- */

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
if (!fs.existsSync(CHROME)) {
  console.log('\nSkipping the browser half: Chrome is not where this expects it.');
  console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

console.log('\nA lazily loaded page, in a real browser:');

/* Serve dist with a single-page fallback, the way the server does in production. */
const server = http.createServer((req, res) => {
  const asked = decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(DIST, asked);
  const send = (at, type) => {
    res.setHeader('Content-Type', type);
    res.end(fs.readFileSync(at));
  };
  if (asked !== '/' && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const type = file.endsWith('.js')
      ? 'text/javascript'
      : file.endsWith('.css')
        ? 'text/css'
        : file.endsWith('.svg')
          ? 'image/svg+xml'
          : 'application/octet-stream';
    return send(file, type);
  }
  return send(path.join(DIST, 'index.html'), 'text/html');
});
await new Promise((resolve) => server.listen(8793, '127.0.0.1', resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'engy-chunks-'));
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--remote-debugging-port=9764',
    `--user-data-dir=${profile}`,
    '--window-size=1440,900',
    '--no-first-run',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

let version = null;
for (let i = 0; i < 60 && !version; i += 1) {
  version = await fetch('http://127.0.0.1:9764/json/version')
    .then((r) => r.json())
    .catch(() => null);
  if (!version) await new Promise((r) => setTimeout(r, 250));
}

const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve) => (socket.onopen = resolve));
let id = 0;
const waiting = new Map();
const events = [];
socket.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    waiting.get(message.id)?.(message.result ?? message.error);
    waiting.delete(message.id);
    return;
  }
  events.push(message);
};
const send = (method, params = {}, sessionId) =>
  new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params, sessionId }));
  });

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, sessionId);
await send('Runtime.enable', {}, sessionId);
await send('Network.enable', {}, sessionId);

const evaluate = async (expression) => {
  const result = await send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId
  );
  return result.result?.value;
};

/*
 * `/set-password/<token>` is the right route to test with: it is lazily loaded, it is outside
 * every guard, and it needs no session — so this asserts the splitting rather than the login flow.
 * The token is nonsense, so the page will say the link is not valid, and that is a rendered page.
 */
await send('Page.navigate', { url: 'http://127.0.0.1:8793/set-password/not-a-real-token' }, sessionId);
await new Promise((r) => setTimeout(r, 6000));

const state = await evaluate(
  `JSON.stringify({
     nodes: document.querySelectorAll('body *').length,
     text: (document.body.innerText || '').slice(0, 200),
   })`
);
const { nodes, text } = JSON.parse(state ?? '{}');

check('the page rendered', nodes > 10, `${nodes} nodes`);
check('with words on it', (text ?? '').trim().length > 10, JSON.stringify(text));

/*
 * The specific failure this is for: a lazy component with no Suspense above it throws, React
 * unmounts the tree, and the body ends up empty or holding an error. React reports it through
 * console.error even when an error boundary swallows the render.
 */
const problems = events
  .filter((event) => event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error')
  .map((event) =>
    (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
  )
  .concat(
    events
      .filter((event) => event.method === 'Runtime.exceptionThrown')
      .map((event) => event.params.exceptionDetails?.exception?.description ?? '')
  );

check(
  'and nothing suspended without a boundary',
  !problems.some((line) => /suspended while responding to synchronous input|Suspense/i.test(line)),
  problems.find((line) => /suspend/i.test(line))?.slice(0, 200)
);
check('with no uncaught errors at all', problems.length === 0, problems[0]?.slice(0, 200));

/* And the chunk for that page was genuinely fetched separately, which is the whole point. */
const fetched = events
  .filter((event) => event.method === 'Network.requestWillBeSent')
  .map((event) => event.params.request.url)
  .filter((url) => url.endsWith('.js'));
check(
  'the page arrived as its own chunk, not in the entry',
  fetched.length >= 2,
  `${fetched.length} script request(s): ${fetched.map((u) => u.split('/').pop()).join(', ')}`
);

await send('Browser.close').catch(() => {});
chrome.kill();
await new Promise((r) => server.close(r));
try {
  fs.rmSync(profile, { recursive: true, force: true });
} catch {}

console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
