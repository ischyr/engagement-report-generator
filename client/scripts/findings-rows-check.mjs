/**
 * Counts how many findings re-render when you touch one thing.
 *
 *   npm run test:findings-rows --workspace client
 *
 * The findings list was two hundred lines of JSX inside `findings.map`, so every row was rebuilt
 * whenever anything in the tab re-rendered — and the tab re-renders on every keystroke in the
 * quick-capture box above the list, on every step of the `j`/`k` walk and on every tick of a
 * checkbox. Sixty findings, each with a CVSS badge, an avatar and a team-sized `<select>`, rebuilt
 * to put one more character in a text input.
 *
 * The row is a memoised component now. That is the kind of claim which is easy to make, easy to
 * believe and quietly false the moment somebody passes an inline arrow as a prop — so this counts.
 *
 * **How the counting works, since it looks like a trick.** Nothing was added to the component for
 * the sake of being testable. Each fixture finding is given a `tags` array whose `slice` is
 * instrumented, and the row calls `finding.tags.slice(0, 3)` once while rendering its chips. The
 * parent copies findings with `{...finding}`, which copies the array by reference, so the
 * instrumented `slice` survives into the row. One `slice` call is one row render.
 *
 * Then the assertions are the ones worth making: typing in the capture box renders no rows at all,
 * moving the cursor renders two — the one it left and the one it arrived at — and ticking a
 * checkbox renders one. And, because a 231-line extraction is exactly the change that silently
 * drops a prop, the second half of the file checks that the rows still say everything they said.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements/x?tab=findings',
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

/* jsdom has no layout, so the cursor's `scrollIntoView` is not there to be called. */
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

const FINDING_COUNT = 60;
/** How many times each row has rendered, by finding id. */
const renders = new Map();

/**
 * A tags array that counts the row reading it.
 *
 * `slice` rather than a getter on the finding, because the parent's `useMemo` spreads each finding
 * into a new object — a getter would be invoked and flattened by the copy, and the count would be
 * of the parent's work rather than the row's. An array survives a spread by reference.
 */
function countingTags(id, tags) {
  const array = [...tags];
  array.slice = function slice(...args) {
    renders.set(id, (renders.get(id) ?? 0) + 1);
    return Array.prototype.slice.apply(this, args);
  };
  return array;
}

const VECTORS = [
  'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
  'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N',
  'CVSS:3.1/AV:N/AC:H/PR:L/UI:R/S:U/C:L/I:N/A:N',
];
/** Nothing scored on any axis, which is what makes a finding read as a draft. */
const UNSCORED = 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N';

const ines = { _id: 'u1', username: 'ines', firstname: 'Ines', lastname: 'Adeyemi' };
const marijke = { _id: 'u2', username: 'marijke', firstname: 'Marijke', lastname: 'de Vries' };

const findings = Array.from({ length: FINDING_COUNT }, (_, index) => ({
  _id: `f${index}`,
  identifier: index + 1,
  title: `Finding number ${index + 1}`,
  category: 'Web',
  vulnType: 'Injection',
  snippet: 'The parameter is reflected without encoding.',
  /*
   * Row 0 is scored Critical and reported Medium, which is the only arrangement that draws the
   * "scored Critical" note beside the badge — an override equal to the computed severity is not an
   * override, and the first version of this fixture set both to Critical and then asserted the note
   * was there. Row 1 is the draft: no write-up *and* nothing scored on any axis, since a finding
   * with a real vector is not a draft however empty its description is.
   */
  cvssv3: index === 1 ? UNSCORED : VECTORS[index % VECTORS.length],
  severityOverride: index === 0 ? 'Medium' : '',
  severityOverrideReason: index === 0 ? 'Agreed with the client to report it lower' : '',
  hasDescription: index !== 1,
  description: index === 1 ? '' : '<p>Written up.</p>',
  tags: countingTags(`f${index}`, index % 4 === 0 ? ['external', 'quick-win'] : []),
  assignedTo: index % 3 === 0 ? ines : null,
  createdBy: ines,
  updatedBy: index % 5 === 0 ? marijke : ines,
  lockedBy: index === 2 ? marijke : null,
  priority: index === 3 ? 3 : null,
  clientClaim: index === 4 ? { status: 'fixed', by: 'The client', at: '2026-07-22' } : null,
  sortIndex: index,
}));

const audit = {
  _id: 'x',
  name: 'Northwind Shipment Portal',
  reference: 'PT-2026-041',
  language: 'en',
  sortFindings: false,
  creator: ines,
  collaborators: [marijke],
  reviewers: [],
  scope: [],
  findings,
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
 * The real `UnsavedProvider`, not left out.
 *
 * `useUnsaved()` falls back to a fresh object literal when there is no provider, which would make
 * `guard` — and therefore `select`, which is a prop on every row — a new identity on every render.
 * `main.jsx` mounts the provider, so leaving it out here would be this harness inventing a
 * re-render the application does not have. The tab holds it at arm's length through a ref anyway;
 * mounting it is what makes this a test of the application rather than of the workaround.
 */
const { UnsavedProvider } = await load('/src/context/UnsavedContext.jsx');
const { MemoryRouter } = await load('react-router-dom');
const FindingsTab = (await load('/src/components/engagement/FindingsTab.jsx')).default;

/** The two lists the tab asks for beside the engagement it was handed. */
const ANSWERS = {
  '/data/custom-fields': [],
  '/audits/x/history': { byFinding: {} },
  '/audits/x/findings/deleted': [],
  '/audits/x/tags': [],
};

globalThis.fetch = async (url, init = {}) => {
  const at = String(url)
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/^\/api/, '')
    .replace(/\?.*$/, '');
  if ((init.method ?? 'GET').toUpperCase() !== 'GET') {
    return { ok: true, status: 204, headers: { get: () => null }, text: async () => '' };
  }
  const body = ANSWERS[at];
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
    await new Promise((resolve) => setTimeout(resolve, 120));
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
              { initialEntries: ['/engagements/x?tab=findings'] },
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
  await settle();
} finally {
  restore();
}

/** Every row's count, reset so the next interaction is measured on its own. */
const zero = () => {
  for (const key of renders.keys()) renders.set(key, 0);
};
const rendered = () => [...renders.entries()].filter(([, count]) => count > 0).map(([id]) => id);
const rows = () => [...container.querySelectorAll('li')];

/* -------------------------------------------------------------------------- */
console.log('\nIt mounts, with every finding on screen:');
{
  check('no render errors', problems.length === 0, problems.slice(0, 2).join(' | '));
  check(`${FINDING_COUNT} rows`, rows().length === FINDING_COUNT, String(rows().length));
  check(
    'every row rendered exactly once',
    [...renders.values()].every((count) => count === 1),
    JSON.stringify([...renders.entries()].filter(([, c]) => c !== 1).slice(0, 4))
  );
  check(
    'and the counter is instrumented on all of them',
    renders.size === FINDING_COUNT,
    `${renders.size} of ${FINDING_COUNT}`
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nTyping in the quick-capture box renders no rows at all:');
{
  zero();
  const input = container.querySelector('input[aria-label="Quick-capture a finding"]');
  check('the box is there', Boolean(input));
  for (const text of ['O', 'Op', 'Ope', 'Open']) {
    await act(async () => {
      /* React's own onChange path: set the value, then dispatch input. */
      const setter = Object.getOwnPropertyDescriptor(
        dom.window.HTMLInputElement.prototype,
        'value'
      ).set;
      setter.call(input, text);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  }
  check('the box took the text', input.value === 'Open', input.value);
  check(
    `four keystrokes re-rendered 0 of ${FINDING_COUNT} rows`,
    rendered().length === 0,
    `${rendered().length} rendered: ${rendered().slice(0, 5).join(', ')}`
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nWalking the list on the keyboard renders the two rows that changed:');
{
  zero();
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  });
  check(
    'the first press renders one row — the one the cursor landed on',
    rendered().length === 1,
    `${rendered().length}: ${rendered().slice(0, 5).join(', ')}`
  );

  zero();
  await act(async () => {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'j', bubbles: true }));
  });
  check(
    'the second renders two — the one it left and the one it reached',
    rendered().length === 2,
    `${rendered().length}: ${rendered().slice(0, 5).join(', ')}`
  );
  check(
    '  and the cursor is drawn on exactly one row',
    rows().filter((row) => row.className.includes('inset_2px')).length === 1,
    String(rows().filter((row) => row.className.includes('inset_2px')).length)
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nTicking a checkbox renders that row:');
{
  zero();
  const boxes = rows().map((row) => row.querySelector('input[type="checkbox"]'));
  await act(async () => {
    boxes[7].click();
  });
  check(
    'one row re-rendered, not sixty',
    rendered().length === 1 && rendered()[0] === 'f7',
    `${rendered().length}: ${rendered().slice(0, 5).join(', ')}`
  );
  check('and it is ticked', boxes[7].checked === true, String(boxes[7].checked));
  check(
    'the selection header appeared',
    container.textContent.includes('of 60 selected'),
    container.textContent.slice(0, 160)
  );

  /*
   * Shift-click, which is the one behaviour the anchor-as-a-ref change could have broken: the
   * anchor is no longer state, so if it were being read at the wrong moment the run would come
   * out empty or off by one.
   */
  zero();
  await act(async () => {
    /*
     * The box is flipped before the click is dispatched, which is not a detail.
     *
     * React implements `onChange` for a checkbox on top of the `click` event — that is why the
     * component can read `event.nativeEvent.shiftKey` at all, since a `change` event carries no
     * modifier keys. But it only fires the handler when its value tracker sees the checked state
     * actually change, and a dispatched (untrusted) click does not run jsdom's activation
     * behaviour. Without this line the handler ran off some other event with no `shiftKey` on it,
     * the run came out as a single tick, and the failure looked like the anchor being broken.
     */
    boxes[11].checked = true;
    boxes[11].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, shiftKey: true }));
  });
  const ticked = boxes.filter((box) => box.checked).map((box) => box.getAttribute('aria-label'));
  check(
    'shift-click still takes the run from the anchor',
    ticked.length === 5,
    `${ticked.length} ticked: ${ticked.join(', ')}`
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd the rows still say everything they said before the extraction:');
{
  const text = container.textContent ?? '';
  const html = container.innerHTML ?? '';
  check('the title', text.includes('Finding number 1'));
  check('the severity, from the vector', text.includes('Critical') || text.includes('High'));
  check('an override, and the score it departs from', text.includes('scored '), '');
  check('the category and the snippet', text.includes('Web · Injection'), '');
  check('the reflected-parameter snippet', text.includes('reflected without encoding'));
  check('a lock, with the holder', html.includes('Locked by Marijke de Vries'));
  check('a priority, by its label rather than its number', text.includes('High priority'));
  check('the draft badge on the one with no write-up', text.includes('draft'));
  check("the client's claim", text.includes('client says fixed'));
  check('the tag chips', text.includes('quick-win'));
  check('the author', html.includes('Added by Ines Adeyemi'));
  check('and who last edited it', html.includes('last edited by Marijke de Vries'));
  check(
    'the assignee dropdown, with the team in it',
    rows()[0].querySelector('select') !== null &&
      rows()[0].querySelectorAll('select option').length === 3,
    String(rows()[0].querySelectorAll('select option').length)
  );
  check('a delete button', html.includes('Delete finding'));
  check(
    'the reorder buttons, because this engagement sorts by hand',
    rows()[1].querySelector('button[aria-label="Move up"]') !== null
  );
  check(
    '  and the first row cannot move up',
    rows()[0].querySelector('button[aria-label="Move up"]')?.disabled === true
  );
  check(
    '  and the last cannot move down',
    rows()[FINDING_COUNT - 1].querySelector('button[aria-label="Move down"]')?.disabled === true
  );
  check('no errors after all of that', problems.length === 0, problems.slice(0, 2).join(' | '));
}

/* -------------------------------------------------------------------------- */
/* The guard: a prop that is rebuilt every render makes the memo decorative   */
/* -------------------------------------------------------------------------- */
console.log('\nAnd nothing is passed to a row that would defeat the memo:');
{
  const fs = await import('node:fs');
  const source = fs.readFileSync(
    path.join(root, 'src/components/engagement/FindingsTab.jsx'),
    'utf8'
  );
  const call = source.slice(source.indexOf('<FindingRow'), source.indexOf('/>', source.indexOf('<FindingRow')));

  check('the row is memoised', /const FindingRow = memo\(/.test(source), '');
  check('and the tab renders it', call.length > 0, '');

  /*
   * The regression this is here for: `onSomething={() => ...}` or `repeats={x ?? []}` on the call
   * below is a new value on every render, and one of them is enough to make every row re-render
   * again — with nothing failing, nothing warning, and the memo still sitting there looking
   * correct. So the props are checked to be identifiers, member reads, comparisons and literals.
   */
  const props = [...call.matchAll(/^\s{16}(\w+)=\{([^\n]*)\}$/gm)].map(([, name, value]) => ({
    name,
    value: value.trim(),
  }));
  check(`every prop on the call is checked (${props.length} of them)`, props.length >= 17, String(props.length));

  const unstable = props.filter(
    ({ value }) => value.includes('=>') || /(\?\?|\|\|)\s*(\[\]|\{\})/.test(value)
  );
  check(
    'no inline function or fresh array among them',
    unstable.length === 0,
    unstable.map((p) => `${p.name}={${p.value}}`).join(', ')
  );

  /* And the two that are not primitives are the two that are memoised upstream. */
  check(
    'team comes from a useMemo',
    /const team = useMemo\(/.test(source),
    ''
  );
  check(
    'repeats comes from a useCallback over a shared empty array',
    /const repeatsOf = useCallback\(/.test(source) && /const NO_REPEATS = \[\];/.test(source),
    ''
  );
  check(
    'the callbacks are useCallbacks',
    ['const select = useCallback(', 'const toggle = useCallback(', 'const move = useCallback(', 'const assign = useCallback(']
      .every((needle) => source.includes(needle)),
    ''
  );
  check(
    'and the anchor is a ref, so ticking a box does not re-render the tab',
    /const anchor = useRef\(null\);/.test(source),
    ''
  );
}

tree.unmount();
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
