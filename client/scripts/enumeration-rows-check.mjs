/**
 * Counts how many enumeration rows re-render when you touch one thing.
 *
 *   npm run test:enumeration-rows --workspace client
 *
 * The workbench is a tree beside an editor, and the editor's draft is state on the tab that holds
 * both. So every keystroke in a step's write-up re-rendered the tab, which re-rendered the list,
 * which rebuilt every row — sixty of them on an ordinary operation, two hundred on a large one,
 * each with its indent guides, its icon, its five chips and its drag handlers. The findings list
 * had exactly this fault and was fixed the same way; this is the other screen people spend the day
 * in, and it is the one where the typing happens next to the list rather than above it.
 *
 * The row is a memoised component now. That claim is easy to make and quietly false the moment
 * somebody passes an inline arrow as a prop, so this counts instead of asserting.
 *
 * **How the counting works, since it looks like a trick.** Nothing was added to the component to
 * make it testable. Each fixture row is given an `outputLines` property whose getter counts, and
 * `TreeRow` reads `row.outputLines` once while rendering its chips — it is the one field in the
 * payload that nothing else on the client reads. The getter is deliberately *non-enumerable*: the
 * tab builds the open step as `{...detail, ...row, ...pickBody(detail)}`, and an enumerable getter
 * would be invoked by that spread, so the selected row's count would include the parent's work
 * rather than its own. One getter call is one row render.
 *
 * Then the assertions are the ones worth making: typing in the write-up renders no rows at all,
 * moving the selection renders two, folding a section renders one, and the first tick of a
 * checkbox renders every row on purpose — the boxes appear — while the second renders one. The
 * last section checks the rows still say everything they said before the extraction, because a
 * two-hundred-line lift into a new component is exactly the change that silently drops a prop.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements/x?tab=enumeration',
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
  'DragEvent',
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

/* jsdom has no layout, so the tree's `scrollIntoView` is not there to be called. */
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

/* -------------------------------------------------------------------------- */
/* The fixture                                                                */
/* -------------------------------------------------------------------------- */

const SECTIONS = 6;
const PER_SECTION = 9;
const ROW_COUNT = SECTIONS * (PER_SECTION + 1);

/** How many times each row has rendered, by step id. */
const renders = new Map();

/**
 * Hangs the counter off the one field only the row reads.
 *
 * Non-enumerable for the reason in the header: the tab spreads the selected row, and a spread
 * invokes every enumerable getter it copies.
 */
function counting(row, lines) {
  Object.defineProperty(row, 'outputLines', {
    enumerable: false,
    configurable: true,
    get() {
      renders.set(row._id, (renders.get(row._id) ?? 0) + 1);
      return lines;
    },
  });
  return row;
}

const TOOLS = ['nmap', 'httpx', 'ffuf', 'subfinder'];
const STATUS = ['completed', 'nothing', 'timeout', 'blocked'];

const rows = [];
for (let s = 0; s < SECTIONS; s += 1) {
  rows.push(
    counting(
      {
        _id: `s${s}`,
        parent: null,
        depth: 0,
        hasChildren: true,
        path: String(s + 1),
        title: `Section number ${s + 1}`,
        summary: `What section ${s + 1} was for`,
        tool: '',
        target: '',
        command: '',
        phase: 'recon',
        status: '',
        heldBack: s === 5,
        hasOutput: false,
        hasTable: false,
        noteCount: 0,
        notesStale: 0,
        findings: [],
        outputPreview: '',
        outputAge: null,
        outputStale: false,
        documents: [],
        printOutput: 'all',
        printLines: 40,
      },
      0
    )
  );
  for (let c = 0; c < PER_SECTION; c += 1) {
    const index = s * PER_SECTION + c;
    rows.push(
      counting(
        {
          _id: `s${s}c${c}`,
          parent: `s${s}`,
          depth: 1,
          hasChildren: false,
          path: `${s + 1}.${c + 1}`,
          title: `Step number ${index + 1}`,
          summary: index === 0 ? 'Three live hosts; staging was not in the scope document.' : '',
          tool: TOOLS[index % TOOLS.length],
          target: 'acme.example',
          command: `${TOOLS[index % TOOLS.length]} $TARGET`,
          commandResolved: `${TOOLS[index % TOOLS.length]} acme.example`,
          phase: 'recon',
          status: STATUS[index % STATUS.length],
          heldBack: false,
          hasOutput: true,
          hasTable: index % 5 === 0,
          /* One with marked lines, one with a finding written up, one gone stale. */
          noteCount: index === 1 ? 4 : 0,
          notesStale: index === 1 ? 1 : 0,
          findings: index === 2 ? ['f1', 'f2'] : [],
          outputPreview: 'Starting Nmap 7.94',
          outputAge: index === 3 ? 12 : 1,
          outputStale: index === 3,
          documents: [],
          printOutput: 'all',
          printLines: 40,
        },
        24
      )
    );
  }
}

const ines = { _id: 'u1', username: 'ines', firstname: 'Ines', lastname: 'Adeyemi' };

const audit = {
  _id: 'x',
  name: 'Northwind Shipment Portal',
  reference: 'PT-2026-041',
  language: 'en',
  creator: ines,
  collaborators: [],
  reviewers: [],
  scope: [],
  findings: [],
  enumerationVars: [{ key: 'TARGET', value: 'acme.example' }],
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
/*
 * The real `UnsavedProvider`, not left out: `useUnsaved()` falls back to a fresh object literal
 * when there is no provider, which would make `guard` — and so the tab's `select` — a new identity
 * on every render. `main.jsx` mounts it, so leaving it out here would be this harness inventing a
 * re-render the application does not have.
 */
const { UnsavedProvider } = await load('/src/context/UnsavedContext.jsx');
const { MemoryRouter } = await load('react-router-dom');
const EnumerationTab = (await load('/src/components/engagement/EnumerationTab.jsx')).default;

/** Every request the mounted tree has made, so an interaction can be priced. */
const calls = [];

/** The body of one step, which the tab fetches for whichever one is open. */
const bodyOf = (id) => ({
  _id: id,
  title: `Step ${id}`,
  tool: 'nmap',
  target: 'acme.example',
  command: 'nmap $TARGET',
  output: 'Starting Nmap 7.94\nHost is up (0.014s latency).\n',
  content: '<p>Three hosts answered.</p>',
  notes: [],
  phase: 'recon',
  status: 'completed',
  summary: '',
  printOutput: 'all',
  printLines: 40,
});

globalThis.fetch = async (url, init = {}) => {
  const at = String(url)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api/, '')
    .replace(/\?.*$/, '');
  const method = (init.method ?? 'GET').toUpperCase();
  calls.push(`${method} ${at}`);

  const answer = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });

  if (method !== 'GET') {
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  }
  if (at === '/audits/x/enumeration') return answer(rows);
  const step = /^\/audits\/x\/enumeration\/(s[0-9c]+)$/.exec(at);
  if (step) return answer(bodyOf(step[1]));
  return { ok: false, status: 404, json: async () => ({ error: 'not stubbed' }), text: async () => '' };
};

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
const tree = ReactDOMClient.createRoot(container);

const problems = [];
const captureErrors = () => {
  const original = console.error;
  console.error = (...args) => {
    const text = args.map(String).join(' ');
    if (text.includes('was not wrapped in act')) return;
    problems.push(text);
  };
  return () => {
    console.error = original;
  };
};

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 150));
  });

const restore = captureErrors();
try {
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
                user: { id: 'u1', username: 'ines', role: 'user' },
                loading: false,
                login() {},
                logout() {},
              },
            },
            React.createElement(
              MemoryRouter,
              { initialEntries: ['/engagements/x?tab=enumeration'] },
              React.createElement(EnumerationTab, {
                audit,
                editable: true,
                onReload: async () => {},
              })
            )
          )
        )
      )
    );
  });
  await settle();
} finally {
  restore();
}

/** Every row's count, reset so the next interaction is measured on its own. */
const zero = () => {
  for (const key of renders.keys()) renders.set(key, 0);
};
const rendered = () => [...renders.entries()].filter(([, count]) => count > 0).map(([id]) => id);
const listed = () => [...container.querySelectorAll('li[role="treeitem"]')];
const titleButton = (li) => li.querySelector('button[title], button');

/* -------------------------------------------------------------------------- */
console.log('\nIt mounts, with the whole tree on screen:');
{
  check('no render errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  check(`${ROW_COUNT} rows`, listed().length === ROW_COUNT, String(listed().length));
  /*
   * Every row once, except the first — which renders twice, and correctly so. The tab opens the
   * first step from an effect, which by definition runs after the tree has been drawn, so that one
   * row flips to selected and draws again. One row, one extra render, at mount only; pinned here
   * rather than rounded away, so a future change that makes it sixty is a failure.
   */
  const twice = [...renders.entries()].filter(([, count]) => count !== 1);
  check(
    'every row rendered once, but for the one the tab opens',
    twice.length === 1 && twice[0][0] === rows[0]._id && twice[0][1] === 2,
    JSON.stringify(twice.slice(0, 4))
  );
  check(
    'and the counter is instrumented on all of them',
    renders.size === ROW_COUNT,
    `${renders.size} of ${ROW_COUNT}`
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nOpening another step renders the two rows that changed:');
{
  zero();
  await act(async () => {
    titleButton(listed()[7]).click();
  });
  await settle();
  check(
    'two rows — the one it left and the one it reached',
    rendered().length === 2,
    `${rendered().length}: ${rendered().slice(0, 6).join(', ')}`
  );
  check(
    '  and exactly one row is marked selected',
    listed().filter((li) => li.getAttribute('aria-selected') === 'true').length === 1,
    String(listed().filter((li) => li.getAttribute('aria-selected') === 'true').length)
  );
  check(
    '  fetching one body, not the whole tree again',
    calls.filter((line) => line === 'GET /audits/x/enumeration').length === 1,
    calls.filter((line) => line.startsWith('GET /audits/x/enumeration')).join(' | ')
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nTicking a checkbox renders the boxes once, then one row at a time:');
{
  zero();
  const boxes = () => listed().map((li) => li.querySelector('input[type="checkbox"]'));
  await act(async () => {
    boxes()[3].click();
  });
  /*
   * The first tick genuinely changes every row: the checkboxes are hidden until something is
   * picked, so `anyPicked` flips for all of them. Asserted rather than worked around — a memo is
   * supposed to skip the rows whose props did not change, not the rows whose props did.
   */
  check(
    'the first tick renders every row, because the boxes appear',
    rendered().length === ROW_COUNT,
    `${rendered().length} of ${ROW_COUNT}`
  );

  zero();
  await act(async () => {
    boxes()[11].click();
  });
  check(
    'the second renders one row, not sixty',
    rendered().length === 1 && rendered()[0] === rows[11]._id,
    `${rendered().length}: ${rendered().slice(0, 6).join(', ')}`
  );
  check(
    '  and two are ticked',
    boxes().filter((box) => box?.checked).length === 2,
    String(boxes().filter((box) => box?.checked).length)
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nFolding a section renders the section, and hides its branch:');
{
  zero();
  const twisty = listed()[0].querySelector('button[aria-label="Collapse"]');
  check('the twisty is on the section', Boolean(twisty));
  await act(async () => {
    twisty.click();
  });
  check(
    'one row re-rendered — the one that folded',
    rendered().length === 1,
    `${rendered().length}: ${rendered().slice(0, 6).join(', ')}`
  );
  check(
    `its ${PER_SECTION} children left the list`,
    listed().length === ROW_COUNT - PER_SECTION,
    String(listed().length)
  );
  check(
    '  and it now says how many are inside',
    listed()[0].textContent.includes(String(PER_SECTION)),
    listed()[0].textContent.slice(0, 80)
  );

  zero();
  await act(async () => {
    listed()[0].querySelector('button[aria-label="Expand"]').click();
  });
  check(
    'unfolding renders the section and the branch that came back',
    rendered().length === PER_SECTION + 1,
    `${rendered().length}, expected ${PER_SECTION + 1}`
  );
  check('the whole tree is back', listed().length === ROW_COUNT, String(listed().length));
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd typing in the write-up beside the tree renders no rows at all:');
{
  await settle();
  const input = container.querySelector('input[placeholder="Subdomain Enumeration"]');
  check("the open step's title box is there", Boolean(input));

  zero();
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  for (const text of ['S', 'Su', 'Sub', 'Subd', 'Subdo']) {
    await act(async () => {
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  check('the box took the text', input.value === 'Subdo', input.value);
  check(
    `five keystrokes re-rendered 0 of ${ROW_COUNT} rows`,
    rendered().length === 0,
    `${rendered().length} rendered: ${rendered().slice(0, 6).join(', ')}`
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe rows still say everything they said before the extraction:');
{
  const text = container.textContent ?? '';
  const html = container.innerHTML ?? '';
  const first = listed()[0];
  const child = listed()[1];

  check('the section title', text.includes('Section number 1'));
  check('the step title', text.includes('Step number 1'));
  check('the outline path', child.textContent.includes('1.1'), child.textContent.slice(0, 40));
  check('the tool, on the wide layout only', !child.textContent.includes('nmap'), 'compact shows no tool');
  check('the output line count', child.textContent.includes('24'), child.textContent.slice(0, 60));
  check('marked lines, with the stale ones counted', html.includes('no longer in the output'));
  check('findings written up from a step', html.includes('Written up as 2 finding(s)'));
  check('output that has gone stale', html.includes('worth re-running before this ships'));
  check('the outcome dot, by name', html.includes('title="Completed"'));
  check('a held-back section is struck through', html.includes('line-through'));
  check('the add-a-child button', html.includes('Add a step under this one'));
  check(
    'depth and place, for a screen reader',
    child.getAttribute('aria-level') === '2' &&
      child.getAttribute('aria-posinset') === '1' &&
      child.getAttribute('aria-setsize') === String(PER_SECTION),
    `${child.getAttribute('aria-level')} / ${child.getAttribute('aria-posinset')} of ${child.getAttribute('aria-setsize')}`
  );
  check(
    'and the section says it is expanded',
    first.getAttribute('aria-expanded') === 'true',
    String(first.getAttribute('aria-expanded'))
  );
  check('no errors after all of that', problems.length === 0, problems.slice(0, 2).join(' | '));
}

/* -------------------------------------------------------------------------- */
/* The guard: a prop rebuilt every render makes the memo decorative           */
/* -------------------------------------------------------------------------- */
console.log('\nAnd nothing is handed to a row that would defeat the memo:');
{
  const fs = await import('node:fs');
  const treeSource = fs.readFileSync(
    path.join(root, 'src/components/engagement/EnumerationTree.jsx'),
    'utf8'
  );
  const tabSource = fs.readFileSync(
    path.join(root, 'src/components/engagement/EnumerationTab.jsx'),
    'utf8'
  );

  check('the row is memoised', /const TreeRow = memo\(/.test(treeSource), '');

  const call = treeSource.slice(
    treeSource.indexOf('<TreeRow'),
    treeSource.indexOf('/>', treeSource.indexOf('<TreeRow'))
  );
  const props = [...call.matchAll(/^\s{12}(\w+)=\{([^\n]*)\}$/gm)].map(([, name, value]) => ({
    name,
    value: value.trim(),
  }));
  check(`every prop on the row is checked (${props.length} of them)`, props.length >= 19, String(props.length));
  const unstable = props.filter(
    ({ value }) => value.includes('=>') || /(\?\?|\|\|)\s*(\[\]|\{\})/.test(value)
  );
  check(
    'no inline function or fresh array among them',
    unstable.length === 0,
    unstable.map((p) => `${p.name}={${p.value}}`).join(', ')
  );
  check(
    'the row is handed answers, not the Sets to look itself up in',
    /isPicked=\{picked\.has\(id\)\}/.test(call) && /isCollapsed=\{collapsed\.has\(id\)\}/.test(call),
    ''
  );
  check(
    'the shape of the tree comes from a useMemo',
    /const \{ descendants, among \} = useMemo\(\(\) => treeShape\(rows\), \[rows\]\)/.test(treeSource),
    ''
  );

  /*
   * And the same question of the tab, which is where the arrows used to be. An inline handler on
   * the `<EnumerationTree>` call is a new prop for every row on every keystroke, and it would make
   * all of the above decorative without anything failing or warning.
   */
  const treeCall = tabSource.slice(
    tabSource.indexOf('<EnumerationTree'),
    tabSource.indexOf('/>', tabSource.indexOf('<EnumerationTree'))
  );
  const handed = [...treeCall.matchAll(/^\s{16}(\w+)=\{([^\n]*)\}$/gm)].map(([, name, value]) => ({
    name,
    value: value.trim(),
  }));
  check(`every prop on the tree is checked (${handed.length} of them)`, handed.length >= 15, String(handed.length));
  const arrows = handed.filter(({ value }) => value.includes('=>'));
  check(
    'the tab hands the tree no inline handlers',
    arrows.length === 0,
    arrows.map((p) => `${p.name}={${p.value}}`).join(', ')
  );
  check(
    'the five it hands over are created once',
    ['const onSelectRow = useCallback(', 'const onPickRow = useCallback(', 'const onToggleRow = useCallback(', 'const onAddChildRow = useCallback(', 'const onDropRow = useCallback(']
      .every((needle) => tabSource.includes(needle)),
    ''
  );
  check(
    '  and read the current implementation through a ref',
    /const latest = useRef\(null\);/.test(tabSource) && /latest\.current = \{/.test(tabSource),
    ''
  );
}

tree.unmount();
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
