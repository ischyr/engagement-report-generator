/**
 * Mounts the Intrusive tab against the payloads the API really sends.
 *
 *   npm run test:intrusive-tab --workspace client
 *
 * The SSR smoke renders every page once with no network, which is exactly why it missed the bug this
 * exists for: `/audits/:id/credentials` answers `{ enabled, disabledReason, credentials }` rather
 * than a bare array, and treating the envelope as the list costs nothing until an engagement has one
 * credential and somebody opens the form. Then `.map` throws during render, and with no error
 * boundary between here and the top of the app the whole page goes blank.
 *
 * So this is jsdom and React DOM, with the responses copied from a running server, and it renders
 * the states the smoke cannot reach: after the fetches resolve, with data, and with the form open.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements/x?tab=intrusive',
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

/*
 * A shared request can resolve after the tree it was for has gone, and React notices the state
 * update landed outside act(). That is this harness's business and says nothing about the
 * component, so it is dropped once here rather than filtered in three places.
 */
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

/**
 * What the running server answers, verbatim.
 *
 * The envelope on the credentials route is the whole point of this file: copied rather than
 * imagined, because the version I imagined was an array and that is the bug.
 */
const ONE_CREDENTIAL = {
  enabled: true,
  disabledReason: '',
  credentials: [
    { _id: 'c1', label: 'Read-only portal account', username: 'nw-reader' },
    { _id: 'c2', label: 'Portal administrator', username: 'nw-admin' },
  ],
};

const CHANGE = {
  _id: 'i1',
  title: 'Disabled MFA on the test user',
  action: 'disabled',
  target: 'PATCH /api/users/4471/mfa',
  host: 'portal.example',
  before: '{"mfa":{"enabled":true}}',
  after: '{"mfa":{"enabled":false}}',
  revertPlan: 'Re-enable under Security.',
  notes: '',
  at: '22 Jul 2026',
  authorisedBy: 'Marijke de Vries',
  reversible: true,
  print: true,
  revertedAt: null,
  credentialsUsed: ['c1'],
  order: 1,
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

/* React from node rather than through the SSR loader, whose CJS interop chokes on its entry. */
const React = (await import('react')).default;
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');

const { ToastProvider } = await load('/src/context/ToastContext.jsx');
const AuthModule = await load('/src/context/AuthContext.jsx');
const AuthContext = AuthModule.AuthContext ?? AuthModule.default;
const { MemoryRouter } = await load('react-router-dom');
const IntrusiveTab = (await load('/src/components/engagement/IntrusiveTab.jsx')).default;

const audit = { _id: 'x', name: 'Northwind', reference: 'PT-2026-041', findings: [], intrusions: [] };

/** Every request the mounted tab made, so a handler can be checked by what it asked for. */
let calls = [];

/** Mounts the tab with the given responses and returns the rendered text, or the error. */
async function mount({ intrusions, credentials }) {
  const answers = {
    '/audits/x/intrusions': intrusions,
    '/audits/x/credentials': credentials,
  };
  calls = [];
  /*
   * The client fetches `/api${path}` relative to the origin, so the stub has to strip that prefix
   * to recognise the path — an earlier version matched an absolute URL, answered 404 to everything,
   * and every assertion about content failed while the page still rendered its empty state. Which
   * is a good illustration of why "it rendered" is not the assertion worth making.
   */
  globalThis.fetch = async (url, init = {}) => {
    const at = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/api/, '')
      .replace(/\?.*$/, '');
    const method = (init.method ?? 'GET').toUpperCase();
    calls.push({ method, at });

    /*
     * A write is answered the way the server answers one: 204 and no body. The client reads the
     * content-type to decide whether to parse, so an empty string here is the honest reply — and
     * a handler that assumed JSON came back would fall over in this harness as it does live.
     */
    if (method !== 'GET') {
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }

    const body = answers[at];
    if (body === undefined) {
      return { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }), text: async () => '' };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const tree = ReactDOMClient.createRoot(container);

  /* React reports a render error through console.error as well as throwing; catch both. */
  const problems = [];
  const originalError = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    /* An act() warning is this harness's business, not a defect in the component. */
    if (text.includes('was not wrapped in act')) return;
    problems.push(text);
  };

  try {
    await act(async () => {
      tree.render(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(
            AuthContext.Provider,
            { value: { user: { id: '1', username: 'tester', role: 'user' }, loading: false, login() {}, logout() {} } },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/engagements/x?tab=intrusive'] },
              React.createElement(IntrusiveTab, { audit, editable: true })
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    return { text: container.textContent ?? '', html: container.innerHTML, problems, container, tree };
  } catch (error) {
    return { error, problems, container, tree };
  } finally {
    console.error = originalError;
  }
}

console.log('\nAn engagement with nothing changed yet:');
{
  const result = await mount({ intrusions: [], credentials: { enabled: true, disabledReason: '', credentials: [] } });
  check('renders', !result.error, String(result.error?.message).slice(0, 160));
  check('and offers to record one', result.text?.includes('Record a change'), result.text?.slice(0, 120));
  result.tree?.unmount();
}

console.log('\nWith a change and two borrowed accounts:');
{
  const result = await mount({ intrusions: [CHANGE], credentials: ONE_CREDENTIAL });
  check('renders', !result.error, String(result.error?.message).slice(0, 200));
  check('shows the change', result.text?.includes('Disabled MFA'), result.text?.slice(0, 160));
  check('says it is still standing', result.text?.includes('Still standing'));
  check('warns that it has not been put back', result.text?.includes('not been put back'));
  check('prints the value to type back in', result.text?.includes('"enabled":true'));
  /*
   * The assertion this file was written for. The account name comes from the credentials envelope,
   * so a component that treated the envelope as an array would have thrown before reaching here.
   */
  check(
    'and names the account it was done with',
    result.text?.includes('Read-only portal account'),
    'the credentials envelope was not unwrapped'
  );
  check('with no React errors', result.problems.length === 0, result.problems[0]?.slice(0, 200));
  result.tree?.unmount();
}

console.log('\nWith the form open, which is where the list is iterated:');
{
  const result = await mount({ intrusions: [], credentials: ONE_CREDENTIAL });
  check('renders', !result.error, String(result.error?.message).slice(0, 200));

  /* Click "Record a change" and let the form appear: this is the state that used to throw. */
  const button = [...result.container.querySelectorAll('button')].find((node) =>
    (node.textContent ?? '').includes('Record a change')
  );
  check('the button is there', Boolean(button));

  const problems = [];
  const originalError = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (text.includes('was not wrapped in act')) return;
    problems.push(text);
  };
  let clickError = null;
  try {
    await act(async () => {
      button?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    });
  } catch (error) {
    clickError = error;
  } finally {
    console.error = originalError;
  }

  check('opening it does not throw', !clickError, String(clickError?.message).slice(0, 200));
  check('and React reported nothing', problems.length === 0, problems[0]?.slice(0, 240));
  const text = result.container.textContent ?? '';
  check('the form is showing', text.includes('The value before'), text.slice(0, 160));
  check(
    'with both accounts in the picker',
    text.includes('Read-only portal account') && text.includes('Portal administrator'),
    'the picker did not list the accounts'
  );
  result.tree?.unmount();
}

console.log('\nRemoving a record, which is a handler nothing renders:');
{
  /*
   * This block exists because `api.delete(...)` shipped. The client exposes `del` — `delete` is a
   * reserved word — so the call was `undefined`, the build was happy, the page rendered fine, and
   * the operator got "(intermediate value).delete is not a function" on the first click. The
   * render smoke could not see it: a click handler is not rendered. So the flow is clicked here.
   */
  const result = await mount({ intrusions: [CHANGE], credentials: ONE_CREDENTIAL });
  check('renders', !result.error, String(result.error?.message).slice(0, 200));

  const click = async (node) => {
    const problems = [];
    const originalError = console.error;
    console.error = (...args) => {
      const text = args.map(String).join(' ');
      if (text.includes('was not wrapped in act')) return;
      problems.push(text);
    };
    let thrown = null;
    try {
      await act(async () => {
        node?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    } catch (error) {
      thrown = error;
    } finally {
      console.error = originalError;
    }
    return { thrown, problems };
  };

  const trash = result.container.querySelector('button[title="Remove the record"]');
  check('the row has a remove button', Boolean(trash));
  const opened = await click(trash);

  /* The dialog is portalled onto the body, so it is not inside the container the tab rendered into. */
  const body = dom.window.document.body;
  check(
    'asking to remove opens the confirmation',
    (body.textContent ?? '').includes('Remove this record?'),
    opened.problems[0]?.slice(0, 200) ?? (body.textContent ?? '').slice(-160)
  );

  /* The dialog's own button, told apart from the icon button by having a label rather than a title. */
  const confirm = [...body.querySelectorAll('button')].find(
    (node) => (node.textContent ?? '').trim() === 'Remove the record' && !node.getAttribute('title')
  );
  check('the confirmation has a button', Boolean(confirm));

  const confirmed = await click(confirm);
  check('confirming does not throw', !confirmed.thrown, String(confirmed.thrown?.message).slice(0, 200));
  check(
    'and nothing was reported',
    confirmed.problems.length === 0,
    confirmed.problems[0]?.slice(0, 240)
  );
  /*
   * The assertion that would have failed: with `api.delete` the handler threw before reaching the
   * network, so no DELETE was ever sent and the row stayed on screen.
   */
  check(
    'the record is deleted on the server',
    calls.some((call) => call.method === 'DELETE' && call.at === '/audits/x/intrusions/i1'),
    `requests made: ${calls.map((call) => `${call.method} ${call.at}`).join(', ')}`
  );
  check(
    'and the list is read again afterwards',
    calls.filter((call) => call.method === 'GET' && call.at === '/audits/x/intrusions').length >= 2,
    `requests made: ${calls.map((call) => `${call.method} ${call.at}`).join(', ')}`
  );
  result.tree?.unmount();
}

await vite.close();
console.log(`\n${failed ? 'FAILED' : 'RESULT'}: ${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
