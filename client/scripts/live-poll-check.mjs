/**
 * The signed-in app runs one timer, and it touches one endpoint.
 *
 *   npm run test:live-poll --workspace client
 *
 * There were four loops: a presence heartbeat every 25 seconds, a presence roster every 20, a
 * notification list every 30, and another roster read every 8 for each mounted `useHere` — so a
 * page with three of those ran six timers against three endpoints at six unrelated offsets.
 *
 * The heartbeat is the request that cannot be removed, since something has to tell the server this
 * browser is still here, so it became the one that answers everything. This asserts that from the
 * only place the claim is really testable: a mounted tree, with every request counted.
 *
 * Two things it is really guarding against, both of which a build would happily allow:
 *
 *   - a `setInterval` added back to a context, so the app quietly polls twice again;
 *   - `NotificationsProvider` going back to fetching its own list, which works perfectly and
 *     doubles the request count on every page for the life of every session.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/',
});
for (const name of [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'Event',
  'MouseEvent',
  'MutationObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
]) {
  if (globalThis[name] === undefined && dom.window[name] !== undefined) {
    globalThis[name] = dom.window[name];
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/* jsdom has no visibility API by default, and every loop here checks `document.hidden`. */
Object.defineProperty(dom.window.document, 'hidden', { value: false, configurable: true });

const reportError = console.error.bind(console);
console.error = (...args) => {
  if (args.map(String).join(' ').includes('was not wrapped in act')) return;
  reportError(...args);
};

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

const root = path.resolve(import.meta.dirname, '..');
const { createServer } = await import('vite');
const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});
const load = (p) => vite.ssrLoadModule(p);

const React = (await import('react')).default;
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');

const AuthModule = await load('/src/context/AuthContext.jsx');
const AuthContext = AuthModule.AuthContext ?? AuthModule.default;
const { PresenceProvider, useHere, usePresence } = await load('/src/context/PresenceContext.jsx');
const { NotificationsProvider, useNotifications } = await load(
  '/src/context/NotificationsContext.jsx'
);

/** Every request the tree made, so the count is the assertion rather than a guess. */
let calls = [];

const ROSTER = [
  { id: '1', username: 'ines', fullname: 'Ines Adeyemi', isSelf: true, activity: '', location: '' },
  { id: '2', username: 'marcus', fullname: 'Marcus Beaumont', isSelf: false, activity: 'reading the scope', location: 'finding:a:b' },
];
const NOTIFICATIONS = {
  unread: 2,
  items: [
    { _id: 'n1', message: 'Marcus mentioned you', read: false },
    { _id: 'n2', message: 'A review was requested', read: false },
  ],
};

globalThis.fetch = async (url, init = {}) => {
  const at = String(url)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api/, '');
  calls.push({ method: (init.method ?? 'GET').toUpperCase(), at });

  /* Only the heartbeat is stubbed with a real answer. Anything else 404s and is counted. */
  if (at === '/presence/heartbeat') {
    const body = { ok: true, onlineWindowMs: 75000, users: ROSTER, notifications: NOTIFICATIONS };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  }
  return {
    ok: false,
    status: 404,
    headers: { get: () => 'application/json' },
    json: async () => ({ error: 'not stubbed' }),
    text: async () => '{"error":"not stubbed"}',
  };
};

/** What the two contexts hold, reported out so the assertions can read it. */
let seen = {};

function Probe({ here }) {
  const presence = usePresence();
  const notifications = useNotifications();
  const others = useHere(here ?? '');
  seen = {
    online: presence.users.length,
    others: others.length,
    unread: notifications.unread,
    items: notifications.items.length,
    loading: notifications.loading,
  };
  return null;
}

async function mount({ here } = {}) {
  calls = [];
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const tree = ReactDOMClient.createRoot(container);

  await act(async () => {
    tree.render(
      React.createElement(
        AuthContext.Provider,
        {
          value: {
            user: { id: '1', username: 'ines', role: 'user' },
            booting: false,
            loading: false,
            login() {},
            logout() {},
          },
        },
        React.createElement(
          PresenceProvider,
          null,
          React.createElement(
            NotificationsProvider,
            null,
            React.createElement(Probe, { here })
          )
        )
      )
    );
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });
  return tree;
}

console.log('\nOn mount, with nothing open:');
{
  const tree = await mount();

  const endpoints = [...new Set(calls.map((call) => `${call.method} ${call.at}`))];
  check('exactly one endpoint is touched', endpoints.length === 1, endpoints.join(', '));
  check('and it is the heartbeat', endpoints[0] === 'POST /presence/heartbeat', endpoints[0]);
  check('the roster nothing else asked for arrived', seen.online === 2, seen.online);
  check('and so did the notifications', seen.unread === 2 && seen.items === 2, JSON.stringify(seen));
  check('which are no longer loading', seen.loading === false, seen.loading);

  /* The two requests that used to exist, named, so a failure says which one came back. */
  check(
    'GET /presence was never called',
    !calls.some((call) => call.at === '/presence' && call.method === 'GET'),
    'the roster is being fetched separately again'
  );
  check(
    'GET /notifications was never called',
    !calls.some((call) => call.at.startsWith('/notifications')),
    'the notification bar is fetching its own list again'
  );

  tree.unmount();
}

console.log('\nWith a record open, over nine seconds:');
{
  /*
   * `useHere` used to add its own eight-second timer per mount. Now it only declares a place, and
   * the provider's single timer speeds up while anything is declared — so this waits long enough
   * for that faster rate to fire and asserts that what fired was still only the heartbeat.
   *
   * Nine seconds is slow for a test and it is the only way to observe a timer without faking one,
   * which would test the fake.
   */
  const tree = await mount({ here: 'finding:a:b' });

  const onMount = calls.length;
  check('somebody else at the same record is reported', seen.others === 1, seen.others);
  /*
   * Startup and steady state are different questions and the first version of this test asked
   * them as one, which is how it caught two redundant beats: mounting announces, and declaring a
   * place announces, and while those were tangled together they also rebuilt the timer, which
   * announced a third time. Two of those are gone. What is left is the floor of the thing:
   * arriving, and saying where you are.
   */
  check('mounting costs two beats, not more', onMount <= 2, `${onMount} requests before the first tick`);

  calls = [];
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 9_000));
  });

  const beats = calls.filter((call) => call.at === '/presence/heartbeat').length;
  check('the timer ticks while a record is open', beats >= 1, `${beats} beats in 9 seconds`);
  check(
    'and every request in that window was a heartbeat',
    calls.every((call) => call.at === '/presence/heartbeat'),
    [...new Set(calls.map((c) => c.at))].join(', ')
  );
  /*
   * The ceiling matters as much as the floor. One timer at eight seconds gives one or two beats in
   * a nine-second window; three or more means a second timer has been added back, which is the
   * regression this whole file exists to catch and which nothing else would notice.
   */
  check('at the rate of one timer, not several', beats <= 2, `${beats} beats in 9 seconds`);

  tree.unmount();
}

await vite.close();
console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
