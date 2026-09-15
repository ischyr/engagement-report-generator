/**
 * Every tab of the engagement editor still opens, now that none of them is on the page to begin with.
 *
 *   npm run test:engagement-tabs --workspace client
 *
 * The page imported twenty-one tab bodies statically, so opening an engagement to read its overview
 * downloaded the phishing campaign, the kit register, the detection log, the signature pad and
 * everything else — a 356 kB chunk for a tab bar with one tab showing. They are `lazy()` now,
 * behind one `Suspense`.
 *
 * Which converts a build-time guarantee into a runtime one. A static import that cannot resolve is
 * a build failure; a dynamic one that cannot resolve is a blank tab in production, and a `lazy()`
 * with no boundary above it throws only when somebody opens it. Neither shows up in a build log,
 * and the SSR smoke cannot see either, because it renders this page in its loading state — it has
 * no engagement to draw.
 *
 * So this mounts the page with one, walks the tab bar, and opens every single tab.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements/x',
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
  'sessionStorage',
]) {
  if (globalThis[name] === undefined && dom.window[name] !== undefined) {
    globalThis[name] = dom.window[name];
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
dom.window.HTMLCanvasElement.prototype.getContext = () => null;

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
/* An engagement with enough on it that every conditional tab appears          */
/* -------------------------------------------------------------------------- */

const ines = { _id: 'u1', username: 'ines', firstname: 'Ines', lastname: 'Adeyemi' };

const audit = {
  _id: 'x',
  name: 'Northwind Shipment Portal',
  reference: 'PT-2026-041',
  language: 'en',
  state: 'EDIT',
  /* Red team, so the kind-specific tabs — enumeration, detection, phishing — are all offered. */
  kind: 'redteam',
  company: { _id: 'c1', name: 'Northwind' },
  creator: ines,
  collaborators: [ines],
  reviewers: [],
  approvals: [],
  scope: [],
  sections: [],
  notes: [],
  questions: [],
  testChecks: [],
  enumerationCount: 3,
  phishingCount: 2,
  findings: [
    {
      _id: 'f1',
      identifier: 1,
      title: 'Session cookie without Secure',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
      severityOverride: '',
      remediationStatus: 'open',
      /* A claim, which is what makes the Retest tab appear at all. */
      clientClaim: { status: 'fixed', at: '2026-09-01T09:00:00.000Z', by: 'Dana', note: '', media: [] },
      tags: [],
      createdBy: ines,
      sortIndex: 0,
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
const { UnsavedProvider } = await load('/src/context/UnsavedContext.jsx');
const { MemoryRouter, Routes, Route } = await load('react-router-dom');
const EngagementEditorPage = (await load('/src/pages/EngagementEditorPage.jsx')).default;

globalThis.fetch = async (url, init = {}) => {
  const at = String(url)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api/, '')
    .replace(/\?.*$/, '');
  const method = (init.method ?? 'GET').toUpperCase();

  const answer = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  if (method !== 'GET') return answer({ ok: true });
  if (at === '/audits/x') return answer(audit);
  if (at === '/audits/x/pulse') return answer({ here: [], activity: [] });
  /*
   * Everything else a tab asks for its own data with, empty but the right *shape*.
   *
   * Emptiness matters less than shape: a tab handed `[]` where it expects an object does not draw
   * an empty state, it throws — and `[].entries` is a real function, so a time sheet asking for
   * `data.entries.find` fails with "not a function" rather than with anything that points at the
   * stub. The object-shaped endpoints are listed by hand against what their routes answer with;
   * everything else is a list, which is the common case.
   */
  const SHAPED = {
    '/time/audit/x': { entries: [], hoursPerDay: 8, totals: { hours: 0, entries: 0, days: 0 }, audits: [] },
    '/audits/x/history': { byFinding: {} },
    '/audits/x/timeline': { rows: [], summary: null, skipped: { runs: 0 } },
    '/audits/x/preflight': { ready: true, clean: true, counts: {}, issues: [], checked: 0 },
    '/audits/x/phishing': { targets: [], summary: {} },
    '/audits/x/activity/calendar': { from: '2026-01-01', to: '2026-12-31', days: [], total: 0, activeDays: 0 },
    '/media/bin/x': { items: [] },
    '/audits/x/activity': { entries: [], hasMore: false },
    '/audits/x/deliveries': { deliveries: [], channels: [], nextVersion: '1.0' },
    '/audits/x/documents': { documents: [], kinds: [], maxBytes: 20971520 },
    '/audits/x/kit': { items: [], summary: {}, clashes: [], kinds: [] },
    '/audits/x/detections': { detections: [], summary: {}, outcomes: [], kinds: [] },
    '/audits/x/signatures': { signatures: [], previous: null, roles: [] },
    '/audits/x/scope-changes': { scopeChanges: [], kinds: [] },
    '/audits/x/hosts': { hosts: [], summary: {} },
  };
  if (at in SHAPED) return answer(SHAPED[at]);
  return answer([]);
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
    /* jsdom cannot lay anything out, and several tabs measure themselves. Not this test's business. */
    if (text.includes('getContext') || text.includes('Not implemented')) return;
    problems.push(text);
  };
  return () => {
    console.error = original;
  };
})();

/**
 * The tab currently being opened, so that a chunk which cannot be fetched can be named.
 */
let opening = null;

/*
 * A chunk that cannot be fetched ends the process rather than failing a check — which is precisely
 * the failure this file exists to catch, so it is reported here as a named failure instead.
 *
 * Both doors, because it uses whichever is open. With no error boundary above it, React's lazy
 * machinery rejects a promise nobody is holding; vite's module runner, resolving the import a step
 * earlier, rethrows out of band as an uncaught exception. Handling only the rejection left a
 * missing module killing the run with a RunnerError and no check to show for it.
 *
 * And it reports and stops rather than carrying on to the next tab: the throw happens inside an
 * `act()` that then never resolves, so a handler that merely records and returns leaves the run
 * hanging on the settle it is already inside. The tabs after this one go untested — said plainly
 * below — which is the right trade for a suite whose whole job is to catch exactly this.
 */
const crashed = (reason) => {
  const why = String(reason?.message ?? reason).split('\n')[0];
  check(`the ${opening ?? 'current'} tab loads`, false, why);
  console.log('        (the tabs after this one went untested — this ends the run)');
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(1);
};
process.on('unhandledRejection', crashed);
process.on('uncaughtException', crashed);

const settle = (ms = 200) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

await act(async () => {
  tree.render(
    React.createElement(
      ToastProvider,
      null,
      React.createElement(
        UnsavedProvider,
        null,
        React.createElement(
          AuthContext.Provider,
          {
            value: {
              user: { id: 'u1', _id: 'u1', username: 'ines', role: 'admin' },
              canWrite: true,
              loading: false,
              login() {},
              logout() {},
            },
          },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/engagements/x'] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: '/engagements/:id',
                element: React.createElement(EngagementEditorPage, null),
              })
            )
          )
        )
      )
    )
  );
});
await settle(400);

const text = () => container.textContent ?? '';
/**
 * The tab bar's buttons, which is the list of tabs this engagement actually has.
 *
 * By role, not by class. The first version of this matched on a utility class that the header's
 * action buttons happen to share, so it walked "Archive", "Sign off" and "Save changes" and
 * reported ten cheerful passes without opening a single tab.
 */
const tabButtons = () => [...container.querySelectorAll('[role="tab"]')];

/* -------------------------------------------------------------------------- */
console.log('\nThe page arrives without any of its tabs:');
{
  check('it mounted', text().includes('Northwind Shipment Portal'), text().slice(0, 120));
  check('no render errors', problems.length === 0, problems.slice(0, 2).join(' | '));

  const fs = await import('node:fs');
  const source = fs.readFileSync(path.join(root, 'src/pages/EngagementEditorPage.jsx'), 'utf8');
  const lazyCount = (source.match(/= lazy\(\(\) => import\(/g) ?? []).length;
  check(`${lazyCount} tabs are lazy`, lazyCount >= 21, String(lazyCount));
  check(
    'and none of them is imported statically as well',
    !/^import \w+Tab from '\.\.\/components\/engagement\//m.test(source),
    (source.match(/^import \w+Tab from.*$/m) ?? [])[0] ?? ''
  );
  check(
    'there is a boundary above them',
    /<Suspense fallback=\{<LoadingBlock/.test(source),
    ''
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd every tab in the bar opens when it is clicked:');
{
  const buttons = tabButtons();
  check(`the bar has tabs (${buttons.length})`, buttons.length >= 18, String(buttons.length));

  const opened = [];
  const blank = [];
  for (const button of buttons) {
    const label = (button.textContent ?? '').trim();
    opening = label;
    const before = problems.length;
    await act(async () => {
      button.click();
    });

    /*
     * Waited for rather than slept through. The chunks are not the same size — the findings tab
     * is 84 kB and drags a dependency tree behind it, the kit register is a few — and a fixed
     * delay long enough for the largest makes every run take that long, while one tuned to the
     * average reports the two biggest tabs as broken. Which is exactly what a 300ms sleep did.
     */
    let stuck = true;
    for (let waited = 0; waited < 8000 && stuck; waited += 100) {
      await settle(100);
      stuck = text().includes('Loading…');
      /* No point waiting out the clock for a chunk that has already failed to arrive. */
      if (problems.length > before) break;
    }
    if (stuck) blank.push(label);
    else opened.push(label);
    if (problems.length > before) blank.push(`${label} (threw)`);
  }

  check(
    `all ${opened.length} of them rendered something`,
    blank.length === 0,
    `stuck or broken: ${blank.join(', ')}`
  );
  check('and nothing threw on the way', problems.length === 0, problems.slice(0, 2).join(' | '));
  console.log(`        (${opened.join(', ')})`);
}

restoreErrors();
await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
