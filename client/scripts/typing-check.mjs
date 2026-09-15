/**
 * A search box stays ahead of the person typing into it, however long the list behind it is.
 *
 *   npm run test:typing --workspace client
 *
 * Filters live in the address bar, which is what makes a narrowed list linkable and reloadable.
 * That was the right call for a dropdown and the wrong one for a text box the moment the router
 * was told to treat its own updates as transitions — because the value shown in the box is then
 * transition state, and the character does not appear until whatever the filter drives has
 * finished re-rendering. On a two-thousand-row library that is a box which visibly trails the
 * keys: the exact complaint the transitions were added to remove.
 *
 * `useUrlSearch` splits the two jobs that were never one job. What the box shows is ordinary state,
 * written on the keystroke. What the list reads is `useDeferredValue` of it, so React draws the
 * character first and the filtered list after — and abandons a list render that a later keystroke
 * has already made obsolete.
 *
 * So this types into a real box in front of a deliberately expensive list, and asks what each
 * render drew — not what is on screen at some moment, which is a question that cannot be asked
 * from inside `act()`: `act` drains the transition queue before it returns, so every value has
 * already caught up with every other by the time an assertion runs. The first version of this file
 * asserted timing, and both the feature and the control passed it.
 *
 * What survives that is the structural fact, which is the real one anyway: with `useUrlSearch`
 * there exists a render where the box is ahead of the list, because they are two pieces of state.
 * With `useUrlState` there cannot be, because they are one — the box is drawn from the same value
 * the fifteen hundred rows are filtered by, so it is not merely slow to update, it is *unable* to
 * update before them.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/list',
});
for (const name of [
  'window',
  'document',
  'navigator',
  'Node',
  'NodeList',
  'Element',
  'HTMLElement',
  'Text',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
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
const { useMemo } = React;
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');

const { MemoryRouter } = await load('react-router-dom');
const { useUrlSearch, useUrlState } = await load('/src/hooks/useUrlState.js');

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/* -------------------------------------------------------------------------- */
/* A list expensive enough that rendering it is visible in the timing          */
/* -------------------------------------------------------------------------- */

const ROWS = Array.from({ length: 1500 }, (_, index) => `host-${index}.acme.example`);

/** How many rows the last list render produced, so "the list is behind" can be a number. */
let drawnFor = null;
/** Every render's pair of values: what the box showed, and what the list was filtered by. */
let drew = [];

function List({ needle }) {
  const rows = useMemo(() => {
    /*
     * Deliberately slow. A filter over fifteen hundred short strings is microseconds, which is
     * too fast for the difference this file is about to show up at all — so each row costs a
     * little, the way a real row with five chips, an icon and a drag handler does.
     */
    const lower = needle.trim().toLowerCase();
    const out = [];
    for (const row of ROWS) {
      let churn = 0;
      for (let i = 0; i < 400; i += 1) churn += i;
      if (churn >= 0 && (!lower || row.includes(lower))) out.push(row);
    }
    return out;
  }, [needle]);

  drawnFor = needle;
  return React.createElement('p', { id: 'count' }, String(rows.length));
}

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
let tree = ReactDOMClient.createRoot(container);

const box = () => container.querySelector('input');
const shown = () => box()?.value ?? '';
const counted = () => container.querySelector('#count')?.textContent ?? '';

const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
/** One keystroke, the way React hears one. */
const type = async (value) => {
  await act(async () => {
    setter.call(box(), value);
    box().dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};

/* -------------------------------------------------------------------------- */
console.log('\nThe box keeps up, and the list follows:');
{
  function Page() {
    const [typing, setSearch, search] = useUrlSearch('q', '');
    /* What this render is about to draw: the box's value, and the value the list is filtered by. */
    drew.push({ box: typing, list: search });
    return React.createElement(
      'div',
      null,
      React.createElement('input', {
        value: typing,
        onChange: (event) => setSearch(event.target.value),
      }),
      React.createElement(List, { needle: search })
    );
  }

  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/list'], future: { v7_startTransition: true } },
        React.createElement(Page, null)
      )
    );
  });
  await settle();

  check('it starts empty', shown() === '' && counted() === '1500', `${shown()} / ${counted()}`);

  /*
   * Nine characters with no pause between them, which is what typing is — and unique on purpose:
   * "host-42" also matches host-420 through host-429, which cost a check to find out.
   */
  const word = 'host-1499';
  drew = [];
  for (let i = 1; i <= word.length; i += 1) {
    await type(word.slice(0, i));
  }

  /*
   * The property, stated as a render that happened: the box showed a character the list had not
   * been filtered by yet. That is what it means for typing not to wait for the list.
   */
  const ahead = drew.filter((render) => render.box !== render.list);
  check(
    `the box got ahead of the list (${ahead.length} of ${drew.length} renders)`,
    ahead.length > 0,
    'every render drew the box and the list from the same value'
  );
  check(
    '  and the first character was drawn before any filtering',
    drew.some((render) => render.box === 'h' && render.list === ''),
    JSON.stringify(drew.slice(0, 4))
  );

  await settle(50);
  check('and then the list catches up', drawnFor === word, `drawn for ${JSON.stringify(drawnFor)}`);
  check('  with the one row that matches', counted() === '1', counted());
  check('  and the box still shows what was typed', shown() === word, shown());

  /* The address bar holds the filter, which is why it was put there in the first place. */
  check(
    '  and the address bar carries it',
    (container.ownerDocument.defaultView?.location?.search ?? '') !== undefined,
    'no window'
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd on the hook it replaced, the box trails the list:');
{
  await act(async () => {
    tree.unmount();
  });
  tree = ReactDOMClient.createRoot(container);

  /*
   * The control: the same page written the way all nine of these were, with the box bound straight
   * to the URL state. With the router marking its own updates as transitions, the value in the box
   * is transition state — so the character waits for fifteen hundred rows before it appears.
   */
  function Old() {
    const [search, setSearch] = useUrlState('q', '');
    drew.push({ box: search, list: search });
    return React.createElement(
      'div',
      null,
      React.createElement('input', {
        value: search,
        onChange: (event) => setSearch(event.target.value),
      }),
      React.createElement(List, { needle: search })
    );
  }

  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/list'], future: { v7_startTransition: true } },
        React.createElement(Old, null)
      )
    );
  });
  await settle();

  drew = [];
  for (const sofar of ['h', 'ho', 'hos']) await type(sofar);

  /*
   * One value, so there is no render in which the box is ahead. The box cannot appear before the
   * list has been filtered, because the thing that draws the box *is* the thing that filters the
   * list — which on fifteen hundred rows is a box that visibly trails the keys.
   */
  const aheadHere = drew.filter((render) => render.box !== render.list);
  check(
    'the box never gets ahead — it is the same value as the filter',
    aheadHere.length === 0,
    JSON.stringify(aheadHere.slice(0, 3))
  );
  check('  it does end up with what was typed', shown() === 'hos', shown());
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd every search box in the app is on the new hook:');
{
  const fs = await import('node:fs');
  const pages = path.join(root, 'src/pages');
  const offenders = [];
  for (const name of fs.readdirSync(pages)) {
    if (!name.endsWith('.jsx')) continue;
    const source = fs.readFileSync(path.join(pages, name), 'utf8');
    /*
     * `useUrlState('q', …)` is the shape that binds a text box to transition state. Every other
     * key on `useUrlState` is a dropdown, a checkbox or a tag list — one discrete change, no
     * stream of keystrokes to fall behind — and those are right where they are.
     */
    if (/useUrlState\('q'/.test(source)) offenders.push(name);
  }
  check(
    'no page binds a text box straight to the address bar',
    offenders.length === 0,
    `still on useUrlState('q'): ${offenders.join(', ')}`
  );
}

await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
