/**
 * The library page draws rows without prose, and will not save an entry it has not read.
 *
 *   npm run test:library-editor --workspace client
 *
 * `GET /vulnerabilities` stopped sending descriptions, impacts and remediations — the list draws a
 * title, a stored snippet, a severity and a date, and that is now all it is given. Which creates
 * one way to lose somebody's work: the editor is opened from a row, and it saves whatever the form
 * is holding. A form seeded from a row without prose, saved before the real entry arrives, writes
 * three empty fields over a write-up that took an afternoon.
 *
 * So the dialog fetches the entry and the save button waits for it. That is the assertion this file
 * exists for — the rest is the list itself: that it renders what the light payload carries, that
 * the snippet shown is the server's rather than one parsed here, and that typing in the search box
 * re-renders no rows, counted the same way the findings and enumeration suites count.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/library',
});
for (const name of [
  'window',
  'document',
  'navigator',
  'DOMParser',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'Text',
  'Range',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getSelection',
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
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

/*
 * jsdom has neither layout nor a ResizeObserver, and the page header watches its own width to
 * decide how to wrap. A no-op is honest here: with no layout there is nothing to observe, and
 * every assertion below is about what the page holds rather than where it sits.
 */
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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

/* -------------------------------------------------------------------------- */
/* The fixture: what the endpoint now answers with                            */
/* -------------------------------------------------------------------------- */

const ENTRY_COUNT = 40;
/** How many times each row has rendered, by entry id. */
const renders = new Map();

/**
 * The counter, hung off the one field only the row reads.
 *
 * Non-enumerable so that a spread of the entry — the page makes one per entry in a `useMemo` —
 * does not count as a render of the row. Same trick as `enumeration-rows-check.mjs`, same reason.
 */
function counting(entry, updatedAt) {
  Object.defineProperty(entry, 'updatedAt', {
    enumerable: false,
    configurable: true,
    get() {
      renders.set(entry._id, (renders.get(entry._id) ?? 0) + 1);
      return updatedAt;
    },
  });
  return entry;
}

const VECTORS = [
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', 'Critical', 9.8],
  ['CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', 'High', 7.5],
  ['CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N', 'Low', 3.1],
];

/** The prose, which lives on exactly one entry and must never reach the list. */
const PROSE = '<p>The <strong>session cookie</strong> is issued without the Secure attribute.</p>';
const IMPACT = '<p>Session theft on a shared network.</p>';
const FIX = '<p>Set Secure, HttpOnly and SameSite.</p>';

const listRows = Array.from({ length: ENTRY_COUNT }, (_, index) => {
  const [cvssv3, severity, cvssScore] = VECTORS[index % VECTORS.length];
  return counting(
    {
      _id: `v${index}`,
      cvssv3,
      severity,
      cvssScore,
      category: index % 2 ? 'Web' : 'Infrastructure',
      priority: null,
      remediationComplexity: null,
      details: [
        {
          locale: 'en',
          title: `Library entry number ${index + 1}`,
          vulnType: 'Session management',
          /* The server's line, already text. Nothing here parses HTML to draw a row. */
          snippet: index === 3 ? 'The session cookie is issued without the Secure attribute.' : '',
          references: [],
        },
      ],
    },
    '2026-09-01T09:00:00.000Z'
  );
});

/** The one entry in full, as `GET /vulnerabilities/:id` answers. */
const fullEntry = {
  _id: 'v3',
  cvssv3: VECTORS[0][0],
  severity: 'Critical',
  cvssScore: 9.8,
  category: 'Web',
  priority: null,
  remediationComplexity: null,
  details: [
    {
      locale: 'en',
      title: 'Library entry number 4',
      vulnType: 'Session management',
      description: PROSE,
      observation: IMPACT,
      remediation: FIX,
      snippet: 'The session cookie is issued without the Secure attribute.',
      references: ['https://example.invalid/cookies'],
      customFields: [],
    },
  ],
};

/* -------------------------------------------------------------------------- */
/* Mounting                                                                   */
/* -------------------------------------------------------------------------- */

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

const { ToastProvider } = await load('/src/context/ToastContext.jsx');
const AuthModule = await load('/src/context/AuthContext.jsx');
const AuthContext = AuthModule.AuthContext ?? AuthModule.default;
const { MemoryRouter } = await load('react-router-dom');
const LibraryPage = (await load('/src/pages/LibraryPage.jsx')).default;

const calls = [];
/** Requests held open, so "while it is still loading" is a state this can actually be in. */
let holdEntry = null;
/** Set to make the entry fetch fail instead. */
let entryFails = false;
/** What the server says matches deeper than a row shows — the ids are all the page uses. */
let deepAnswer = [];
const sent = [];

globalThis.fetch = async (url, init = {}) => {
  const at = String(url)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api/, '');
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${at}`);
  if (init.body) sent.push({ at, method, body: JSON.parse(init.body) });

  const answer = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  if (method !== 'GET') return answer({ ok: true });
  if (at.startsWith('/vulnerabilities?search=')) return answer(deepAnswer);
  if (at === '/vulnerabilities') return answer(listRows);
  if (at === '/data/vulnerability-types' || at === '/data/vulnerability-categories') {
    return answer([]);
  }
  if (at === '/vulnerabilities/v3') {
    if (entryFails) {
      return { ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({ error: 'nope' }), text: async () => '{"error":"nope"}' };
    }
    if (holdEntry) {
      await holdEntry;
      holdEntry = null;
    }
    return answer(fullEntry);
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
const tree = ReactDOMClient.createRoot(container);

const problems = [];
const restoreErrors = (() => {
  const original = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (text.includes('was not wrapped in act')) return;
    problems.push(text);
    };
  return () => {
    console.error = original;
  };
})();

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

await act(async () => {
  tree.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(
        AuthContext.Provider,
        {
          value: {
            user: { id: 'u1', username: 'ines', role: 'admin' },
            canWrite: true,
            loading: false,
            login() {},
            logout() {},
          },
        },
        React.createElement(
          MemoryRouter,
          { initialEntries: ['/library'] },
          React.createElement(LibraryPage, null)
        )
      )
    )
  );
});
await settle();

const zero = () => {
  for (const key of renders.keys()) renders.set(key, 0);
};
const rendered = () => [...renders.entries()].filter(([, count]) => count > 0).map(([id]) => id);
const rows = () => [...container.querySelectorAll('tbody tr')];
/*
 * The dialog is portalled to `document.body`, not rendered inside the page's container — so it is
 * looked for in the document. The first version of this file asked `container` for the save button
 * and for the word "References", which meant one of the assertions below passed because the dialog
 * was somewhere else entirely rather than because the form was still loading.
 */
const dialog = () => dom.window.document.querySelector('[role="dialog"]');
const buttonBy = (label) =>
  [...dom.window.document.querySelectorAll('button')].find((button) =>
    (button.textContent ?? '').trim().startsWith(label)
  );
/** An input in the dialog holding this exact value — React sets it as a property, not an attribute. */
const fieldWith = (value) =>
  [...(dialog()?.querySelectorAll('input') ?? [])].find((input) => input.value === value);

/* -------------------------------------------------------------------------- */
console.log('\nThe list draws from what the light payload carries:');
{
  check('no render errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  check(`${ENTRY_COUNT} rows`, rows().length === ENTRY_COUNT, String(rows().length));
  check(
    'the severity comes from the server, not from a second CVSS pass here',
    container.textContent.includes('Critical') && container.textContent.includes('9.8'),
    container.textContent.slice(0, 120)
  );
  check(
    "the description line is the server's stored snippet",
    container.textContent.includes('The session cookie is issued without the Secure attribute.'),
    ''
  );
  check(
    'and no row asked for the entry behind it',
    calls.filter((line) => /^GET \/vulnerabilities\/v/.test(line)).length === 0,
    calls.join(' | ')
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nTyping in the search box renders no rows at all:');
{
  zero();
  const input = container.querySelector('input[type="search"], input[placeholder^="Search"]');
  check('the box is there', Boolean(input));
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  for (const text of ['L', 'Li', 'Lib', 'Libr']) {
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  check(
    `four keystrokes re-rendered 0 of ${ENTRY_COUNT} rows`,
    rendered().length === 0,
    `${rendered().length}: ${rendered().slice(0, 5).join(', ')}`
  );
  /* Back to everything, so the row this opens below is the one this expects. */
  await act(async () => {
    setter.call(input, '');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
}

/* -------------------------------------------------------------------------- */
console.log('\nOpening an entry fetches it, and will not save until it has:');
{
  let release = null;
  holdEntry = new Promise((resolve) => {
    release = resolve;
  });

  const before = calls.length;
  await act(async () => {
    rows()[3].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  check(
    'opening it asks for the one entry',
    calls.slice(before).includes('GET /vulnerabilities/v3'),
    calls.slice(before).join(' | ') || 'nothing'
  );

  const saveWhileLoading = buttonBy('Save entry');
  check('the dialog is open, with its save button', Boolean(saveWhileLoading));
  check(
    'and the button is disabled while the entry is still on its way',
    saveWhileLoading?.disabled === true,
    String(saveWhileLoading?.disabled)
  );
  check(
    '  with the form not yet showing fields it could save empty',
    Boolean(dialog()) && !dialog().textContent.includes('References'),
    (dialog()?.textContent ?? 'no dialog').slice(0, 80)
  );

  await act(async () => {
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  await settle();

  check(
    'once it arrives the button is live',
    buttonBy('Save entry')?.disabled === false,
    String(buttonBy('Save entry')?.disabled)
  );
  check(
    'and the form is holding the real entry',
    Boolean(fieldWith('Library entry number 4')),
    [...(dialog()?.querySelectorAll('input') ?? [])].map((i) => i.value).join(' | ')
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd saving sends the prose back, not three empty fields:');
{
  const before = sent.length;
  await act(async () => {
    buttonBy('Save entry').click();
  });
  await settle();

  const write = sent.slice(before).find((call) => call.method === 'PUT');
  check('it writes', Boolean(write), JSON.stringify(sent.slice(before).map((c) => c.method)));
  const detail = write?.body?.details?.[0] ?? {};
  check(
    'the description is the one that was there',
    detail.description === PROSE,
    JSON.stringify(detail.description ?? null)
  );
  check('the impact too', detail.observation === IMPACT, JSON.stringify(detail.observation ?? null));
  check('and the remediation', detail.remediation === FIX, JSON.stringify(detail.remediation ?? null));
  check(
    'and the references the light row did not carry',
    JSON.stringify(detail.references) === JSON.stringify(['https://example.invalid/cookies']),
    JSON.stringify(detail.references ?? null)
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nIf the entry cannot be read, the button stays shut rather than saving a blank:');
{
  entryFails = true;
  await act(async () => {
    rows()[3].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();

  check(
    'the save button is disabled',
    buttonBy('Save entry')?.disabled === true,
    String(buttonBy('Save entry')?.disabled)
  );
  check(
    '  and the dialog says so rather than showing an empty form',
    !fieldWith('Library entry number 4') && !dialog()?.textContent.includes('References'),
    (dialog()?.textContent ?? 'no dialog').slice(0, 80)
  );
  entryFails = false;
}

/* -------------------------------------------------------------------------- */
console.log('\nA word only in a description still finds its entry:');
{
  /*
   * The capability the payload cut could have quietly removed. The list holds titles and a first
   * line, so filtering here can only see those — and the page asks the server, which has the text,
   * then keeps the entries it names. The needle below appears on no row at all: without the merge,
   * nothing would match it.
   */
  deepAnswer = [{ _id: 'v17' }];
  const input = container.querySelector('input[type="search"], input[placeholder^="Search"]');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, 'nowhere-on-any-row');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  /*
   * Long enough for the debounce. The pass waits 250ms before asking — one keystroke is not a
   * request — and the harness's own settle is 150, so the first version of this asserted on the
   * answer before it had been asked for and read the empty list as a broken merge.
   */
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 400));
  });

  check(
    'the entry the server named is listed',
    rows().length === 1 && container.textContent.includes('Library entry number 18'),
    `${rows().length} rows`
  );
  check(
    '  and the page says why it is there, since the row shows no sign of it',
    container.textContent.includes('somewhere in the full text'),
    container.textContent.slice(0, 200)
  );

  deepAnswer = [];
  await act(async () => {
    setter.call(input, '');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
  check('clearing the box brings everything back', rows().length === ENTRY_COUNT, String(rows().length));
}

console.log('\nNothing on the page parses HTML to draw a row any more:');
{
  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(root, 'src/pages/LibraryPage.jsx'), 'utf8');
  check('the row is memoised', /const LibraryRow = memo\(/.test(source), '');
  check('no htmlToSnippet on this page', !source.includes('htmlToSnippet'), '');
  check(
    'and the list does not recompute a score the server sent',
    !/calculateCvss\(entry\.cvssv3\)/.test(source),
    ''
  );
  const picker = fs.readFileSync(
    path.join(root, 'src/components/engagement/FindingsTab.jsx'),
    'utf8'
  );
  check(
    'nor does the picker inside a finding',
    !picker.includes('htmlToSnippet') && !/calculateCvss\(entry\.cvssv3\)/.test(picker),
    ''
  );
  const dashboard = fs.readFileSync(path.join(root, 'src/pages/DashboardPage.jsx'), 'utf8');
  check(
    'and the dashboard asks for a count rather than a library',
    dashboard.includes("useResource('/vulnerabilities/count'"),
    ''
  );
}

restoreErrors();
await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
