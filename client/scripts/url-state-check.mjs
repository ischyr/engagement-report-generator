/**
 * A filter you can reload, bookmark and send to somebody.
 *
 *   npm run test:url-state --workspace client
 *
 * Eleven list pages kept their search, status and tag filters in `useState`. Reloading lost them,
 * the back button did nothing, and "look at the engagements in review that need attention" was a
 * sentence rather than a link. They are in the query string now, through one hook.
 *
 * Two halves, because the hook and the pages can be wrong in different ways. First the rules —
 * strings, booleans and repeated keys, defaults left out of the URL entirely, two filters changed
 * in one tick not discarding each other. Then a real page mounted at a filtered address, which is
 * the only way to find out whether the filters are actually *applied* rather than merely parsed:
 * the SSR smoke renders every page with no query string at all, so it would pass either way.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements',
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

/* jsdom has no layout, so the tab bar's overflow observer is not there to be constructed. */
if (globalThis.ResizeObserver === undefined) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = globalThis.ResizeObserver;
}
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

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

const { useUrlState } = await load('/src/hooks/useUrlState.js');
const RouterModule = await load('react-router-dom');
const { MemoryRouter, Routes, Route, useLocation } = RouterModule;

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });

/* -------------------------------------------------------------------------- */
/* The rules                                                                  */
/* -------------------------------------------------------------------------- */

/** A probe that exposes the hook's values and the address they produce. */
let api = null;
let seenSearch = '';

function Probe() {
  const [text, setText] = useUrlState('q', '');
  const [flag, setFlag] = useUrlState('attention', false);
  const [tags, setTags] = useUrlState('tag', []);
  const [mode, setMode] = useUrlState('state', 'all');
  const location = useLocation();
  seenSearch = location.search;
  api = { text, setText, flag, setFlag, tags, setTags, mode, setMode };
  return React.createElement('div', null, `${text}|${flag}|${tags.join(',')}|${mode}`);
}

async function mountProbe(initial) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const tree = ReactDOMClient.createRoot(container);
  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: [initial] },
        React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(Probe) }))
      )
    );
  });
  await settle();
  return { container, tree };
}

console.log('\nThe address bar is the state:');
{
  const { tree } = await mountProbe('/engagements?q=northwind&attention=1&tag=pci&tag=retest&state=REVIEW');

  check('a string is read', api.text === 'northwind', api.text);
  check('a boolean is read', api.flag === true, String(api.flag));
  check(
    'repeated keys become an array, in order',
    api.tags.join(',') === 'pci,retest',
    api.tags.join(',')
  );
  check('and a plain choice is read', api.mode === 'REVIEW', api.mode);

  await act(async () => api.setText('acme'));
  await settle();
  check('writing a string updates the address', /[?&]q=acme\b/.test(seenSearch), seenSearch);

  await act(async () => api.setTags(['pci']));
  await settle();
  check(
    'writing an array rewrites every copy of the key',
    (seenSearch.match(/tag=/g) ?? []).length === 1 && seenSearch.includes('tag=pci'),
    seenSearch
  );

  /*
   * The default is not written. A URL reading `?state=all&attention=0` for a page with nothing
   * filtered would be noise in every link anybody pastes.
   */
  await act(async () => api.setMode('all'));
  await settle();
  check('setting a filter back to its default removes it', !seenSearch.includes('state='), seenSearch);

  await act(async () => api.setFlag(false));
  await settle();
  check('  and so does switching a toggle off', !seenSearch.includes('attention='), seenSearch);

  await act(async () => api.setTags([]));
  await settle();
  check('  and emptying an array', !seenSearch.includes('tag='), seenSearch);

  /*
   * Two filters in one tick. The updater reads the live params rather than a closure, so the
   * second write must not discard the first — which is exactly what a naive
   * `setParams({...everything, [key]: value})` would do.
   */
  await act(async () => {
    api.setText('portal');
    api.setMode('EDIT');
  });
  await settle();
  check(
    'two filters changed together both survive',
    seenSearch.includes('q=portal') && seenSearch.includes('state=EDIT'),
    seenSearch
  );

  tree.unmount();
}

console.log('\nAnd nothing is left behind when a page is opened clean:');
{
  const { tree } = await mountProbe('/engagements');
  check('an address with no filters reads the defaults', api.text === '' && api.flag === false && api.mode === 'all' && api.tags.length === 0, JSON.stringify({ t: api.text, f: api.flag, m: api.mode, g: api.tags }));
  check('  and writes nothing until something is narrowed', seenSearch === '', seenSearch);
  tree.unmount();
}

/* -------------------------------------------------------------------------- */
/* A real page, at a real address                                             */
/* -------------------------------------------------------------------------- */

console.log('\nA real list arrives already filtered:');
{
  const { ToastProvider } = await load('/src/context/ToastContext.jsx');
  const AuthModule = await load('/src/context/AuthContext.jsx');
  const AuthContext = AuthModule.AuthContext ?? AuthModule.default;
  const EngagementsPage = (await load('/src/pages/EngagementsPage.jsx')).default;

  const AUDITS = [
    {
      _id: 'a1',
      name: 'Northwind portal',
      reference: 'PT-1',
      state: 'EDIT',
      tags: ['pci'],
      company: { _id: 'c1', name: 'Northwind' },
      health: {},
      creator: { _id: 'u1', username: 'ines' },
      collaborators: [],
      reviewers: [],
    },
    {
      _id: 'a2',
      name: 'Contoso review',
      reference: 'PT-2',
      state: 'REVIEW',
      tags: ['pci', 'retest'],
      company: { _id: 'c2', name: 'Contoso' },
      health: {},
      creator: { _id: 'u1', username: 'ines' },
      collaborators: [],
      reviewers: [],
    },
    {
      _id: 'a3',
      name: 'Fabrikam approved',
      reference: 'PT-3',
      state: 'APPROVED',
      tags: [],
      company: { _id: 'c3', name: 'Fabrikam' },
      health: {},
      creator: { _id: 'u1', username: 'ines' },
      collaborators: [],
      reviewers: [],
    },
  ];

  globalThis.fetch = async (url, init = {}) => {
    const at = String(url)
      .replace(/^https?:\/\/[^/]+/, '')
      .replace(/^\/api/, '')
      .replace(/\?.*$/, '');
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') {
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }
    const body = at === '/audits' ? AUDITS : [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  const mountPage = async (address) => {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const tree = ReactDOMClient.createRoot(container);
    await act(async () => {
      tree.render(
        React.createElement(
          ToastProvider,
          null,
          React.createElement(
            AuthContext.Provider,
            {
              value: {
                user: { id: 'u1', username: 'ines', role: 'user' },
                canWrite: true,
                isAdmin: false,
                loading: false,
                login() {},
                logout() {},
              },
            },
            React.createElement(
              MemoryRouter,
              { initialEntries: [address] },
              React.createElement(EngagementsPage)
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    return { container, tree };
  };

  {
    const { container, tree } = await mountPage('/engagements');
    const text = container.textContent ?? '';
    check(
      'unfiltered, all three are there',
      text.includes('Northwind portal') && text.includes('Contoso review') && text.includes('Fabrikam approved'),
      text.slice(0, 160)
    );
    tree.unmount();
  }

  {
    const { container, tree } = await mountPage('/engagements?state=REVIEW');
    const text = container.textContent ?? '';
    check(
      'a status in the address filters the list on arrival',
      text.includes('Contoso review') && !text.includes('Northwind portal'),
      text.slice(0, 200)
    );
    tree.unmount();
  }

  {
    const { container, tree } = await mountPage('/engagements?q=fabrikam');
    const text = container.textContent ?? '';
    check(
      'and so does a search term',
      text.includes('Fabrikam approved') && !text.includes('Contoso review'),
      text.slice(0, 200)
    );
    tree.unmount();
  }

  {
    const { container, tree } = await mountPage('/engagements?tag=retest');
    const text = container.textContent ?? '';
    check(
      'and a tag, which is the one carried as a repeated key',
      text.includes('Contoso review') && !text.includes('Fabrikam approved'),
      text.slice(0, 200)
    );
    tree.unmount();
  }
}

console.log('\nThe severity strip on the engagement header is a control:');
{
  const { ToastProvider } = await load('/src/context/ToastContext.jsx');
  const { UnsavedProvider } = await load('/src/context/UnsavedContext.jsx');
  const AuthModule = await load('/src/context/AuthContext.jsx');
  const AuthContext = AuthModule.AuthContext ?? AuthModule.default;
  const FindingsTab = (await load('/src/components/engagement/FindingsTab.jsx')).default;
  const { SeverityLegend } = await load('/src/components/cvss/CvssEditor.jsx');

  const CRITICAL = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H';
  const HIGH = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N';

  const ines = { _id: 'u1', username: 'ines', firstname: 'Ines', lastname: 'Adeyemi' };
  const audit = {
    _id: 'x',
    name: 'Northwind',
    reference: 'PT-1',
    language: 'en',
    sortFindings: false,
    creator: ines,
    collaborators: [],
    reviewers: [],
    scope: [],
    findings: [
      { _id: 'f1', identifier: 1, title: 'A critical one', cvssv3: CRITICAL, tags: [], sortIndex: 0, createdBy: ines },
      { _id: 'f2', identifier: 2, title: 'A high one', cvssv3: HIGH, tags: [], sortIndex: 1, createdBy: ines },
      {
        /* Scored critical, reported medium. The header used to count this under Critical and the
           list has always shown it as Medium — so it is the one that proves they now agree. */
        _id: 'f3',
        identifier: 3,
        title: 'Scored critical, reported medium',
        cvssv3: CRITICAL,
        severityOverride: 'Medium',
        tags: [],
        sortIndex: 2,
        createdBy: ines,
      },
    ],
  };

  globalThis.fetch = async (url, init = {}) => {
    if ((init.method ?? 'GET').toUpperCase() !== 'GET') {
      return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
    }
    const at = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '').replace(/\?.*$/, '');
    const body = at === '/audits/x/history' ? { byFinding: {} } : [];
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };

  const mountTab = async (address) => {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const tree = ReactDOMClient.createRoot(container);
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
              { value: { user: { id: 'u1', username: 'ines', role: 'user' }, loading: false, login() {}, logout() {} } },
              React.createElement(
                MemoryRouter,
                { initialEntries: [address] },
                React.createElement(FindingsTab, {
                  audit,
                  editable: true,
                  onReload: async () => {},
                  onPatch: async () => {},
                })
              )
            )
          )
        )
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    return { container, tree };
  };

  {
    const { container, tree } = await mountTab('/engagements/x?tab=findings');
    check(
      'unfiltered, all three findings are listed',
      /A critical one/.test(container.textContent) &&
        /A high one/.test(container.textContent) &&
        /reported medium/.test(container.textContent),
      container.textContent.slice(0, 200)
    );
    tree.unmount();
  }

  {
    const { container, tree } = await mountTab('/engagements/x?tab=findings&severity=High');
    const text = container.textContent ?? '';
    check(
      'a severity in the address narrows the list to it',
      /A high one/.test(text) && !/A critical one/.test(text),
      text.slice(0, 240)
    );
    tree.unmount();
  }

  {
    const { container, tree } = await mountTab('/engagements/x?tab=findings&severity=Medium');
    const text = container.textContent ?? '';
    check(
      'and it is the reported severity, not the scored one',
      /reported medium/.test(text) && !/A critical one/.test(text),
      text.slice(0, 240)
    );
    tree.unmount();
  }

  /* And the legend only offers a click when it is given somewhere to send you. */
  {
    const container = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(container);
    const tree = ReactDOMClient.createRoot(container);
    const picked = [];
    await act(async () => {
      tree.render(
        React.createElement(SeverityLegend, {
          counts: { critical: 2, high: 1, medium: 0, low: 0, none: 0 },
          onPick: (label) => picked.push(label),
        })
      );
    });
    const buttons = [...container.querySelectorAll('button')];
    check('the legend offers a button per severity when it can act', buttons.length === 2, String(buttons.length));
    await act(async () => buttons[0].click());
    check('  and reports the label the list filters by', picked[0] === 'Critical', picked.join(','));
    tree.unmount();

    const plain = dom.window.document.createElement('div');
    dom.window.document.body.appendChild(plain);
    const plainTree = ReactDOMClient.createRoot(plain);
    await act(async () => {
      plainTree.render(
        React.createElement(SeverityLegend, { counts: { critical: 2, high: 1, medium: 0, low: 0, none: 0 } })
      );
    });
    check(
      '  and stays a caption where there is nowhere to go',
      plain.querySelectorAll('button').length === 0,
      String(plain.querySelectorAll('button').length)
    );
    plainTree.unmount();
  }
}

console.log('\nColumns sort, and the sort is in the address too:');
{
  const { useTableSort } = await load('/src/hooks/useTableSort.js');
  const { TH } = await load('/src/components/ui/Table.jsx');

  let sortApi = null;
  let sortSearch = '';
  function SortProbe() {
    const sort = useTableSort('name');
    sortApi = sort;
    sortSearch = useLocation().search;
    return null;
  }

  const container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
  const tree = ReactDOMClient.createRoot(container);
  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/users'] },
        React.createElement(Routes, null, React.createElement(Route, { path: '*', element: React.createElement(SortProbe) }))
      )
    );
  });
  await settle();

  const PEOPLE = [
    { name: 'Marijke', seen: '2026-01-02', score: 9.8, note: '' },
    { name: 'ines', seen: null, score: 4.3, note: 'x' },
    { name: 'Arto', seen: '2026-03-04', score: 7.5, note: '' },
  ];
  const by = {
    name: (row) => row.name,
    seen: (row) => row.seen,
    score: (row) => row.score,
  };

  check(
    'the default column sorts, case-insensitively',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',') === 'Arto,ines,Marijke',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',')
  );

  await act(async () => sortApi.toggle('name'));
  await settle();
  check('clicking the same column reverses it', sortApi.direction === 'desc', sortApi.direction);
  check('  and says so in the address', /dir=desc/.test(sortSearch), sortSearch);

  await act(async () => sortApi.toggle('score'));
  await settle();
  check('clicking a different one starts ascending again', sortApi.direction === 'asc', sortApi.direction);
  check(
    '  and both the column and the direction survive that single tick',
    /sort=score/.test(sortSearch) && !/dir=desc/.test(sortSearch),
    sortSearch
  );
  check(
    '  sorting numbers as numbers, not as text',
    sortApi.apply(PEOPLE, by).map((row) => row.score).join(',') === '4.3,7.5,9.8',
    sortApi.apply(PEOPLE, by).map((row) => row.score).join(',')
  );

  /*
   * Empty last in both directions. "Sort by last signed in, newest first" is asking who was here
   * most recently; answering with everyone who has never signed in is defensible and useless.
   */
  await act(async () => sortApi.toggle('seen'));
  await settle();
  check(
    'a blank sorts last ascending',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',') === 'Marijke,Arto,ines',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',')
  );
  await act(async () => sortApi.toggle('seen'));
  await settle();
  check(
    '  and last descending too, rather than first',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',') === 'Arto,Marijke,ines',
    sortApi.apply(PEOPLE, by).map((row) => row.name).join(',')
  );

  check(
    'a column nothing knows how to read leaves the order alone',
    sortApi.apply(PEOPLE, { nothing: (row) => row.name }).map((row) => row.name).join(',') ===
      'Marijke,ines,Arto',
    'it reordered anyway'
  );

  /* References sort the way a person reads them, which is the point of the numeric collation. */
  const REFS = [{ r: 'PT-10' }, { r: 'PT-2' }, { r: 'PT-1' }];
  await act(async () => sortApi.toggle('r'));
  await settle();
  check(
    'PT-2 comes before PT-10',
    sortApi.apply(REFS, { r: (row) => row.r }).map((row) => row.r).join(',') === 'PT-1,PT-2,PT-10',
    sortApi.apply(REFS, { r: (row) => row.r }).map((row) => row.r).join(',')
  );

  tree.unmount();

  /* And the heading is only a button when it has been given a sort to drive. */
  const head = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(head);
  const headTree = ReactDOMClient.createRoot(head);
  await act(async () => {
    headTree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/users?sort=name&dir=desc'] },
        React.createElement('table', null,
          React.createElement('thead', null,
            React.createElement('tr', null,
              React.createElement(TH, { sort: { key: 'name', direction: 'desc', toggle() {} }, sortKey: 'name' }, 'Name'),
              React.createElement(TH, null, 'Actions')
            )
          )
        )
      )
    );
  });
  const cells = [...head.querySelectorAll('th')];
  check('a sortable heading is a button', cells[0].querySelector('button') !== null, '');
  check('  and announces the direction', cells[0].getAttribute('aria-sort') === 'descending', cells[0].getAttribute('aria-sort'));
  check('a plain heading is not', cells[1].querySelector('button') === null, '');
  check('  and announces nothing', cells[1].getAttribute('aria-sort') === null, cells[1].getAttribute('aria-sort'));
  headTree.unmount();
}

await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
