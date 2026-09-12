/**
 * The operation timeline opens on the latest ten, and grows backwards.
 *
 *   npm run test:timeline-window --workspace client
 *
 * The rows arrive oldest first, because the card exists to show a sequence. Which meant the first
 * thing it showed was the *start* of the operation — `slice(0, 25)` on a three-week engagement is
 * week one, and the one question somebody opens this tab with is what happened lately. One button
 * then jumped from there to all thirty-seven.
 *
 * It shows the last ten now, in their own order, and each press of **Show more** drags the window
 * ten further back. Which is a slice off the end of an array, with a count beside it — exactly the
 * kind of thing that is out by one and looks plausible. So this asserts *which* rows are on screen
 * rather than how many.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/engagements/x?tab=detection',
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
  'Event',
  'MouseEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'localStorage',
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
/* The fixture: an operation with a long history                              */
/* -------------------------------------------------------------------------- */

const TOTAL = 37;
/** Oldest first, as the server sorts them — day 1 is the start of the operation. */
const rows = Array.from({ length: TOTAL }, (_, index) => ({
  kind: index % 7 === 0 ? 'detection' : 'run',
  occurredAt: new Date(Date.UTC(2026, 7, 1 + index, 9, 0)).toISOString(),
  label: `Event number ${index + 1}`,
  detail: '',
  note: '',
  noticed: false,
}));

let answer = {
  rows,
  summary: { actions: TOTAL, noticed: 6, timeToFirstNoticedLabel: '4 days', longestQuiet: null },
  skipped: { runs: 2 },
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
const OperationTimeline = (await load('/src/components/engagement/OperationTimeline.jsx')).default;

globalThis.fetch = async (url) => {
  const at = String(url).replace(/^https?:\/\/[^/]+/, '').replace(/^\/api/, '');
  if (at === '/audits/x/timeline') {
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => answer,
      text: async () => JSON.stringify(answer),
    };
  }
  return { ok: false, status: 404, headers: { get: () => null }, json: async () => ({}), text: async () => '' };
};

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
let tree = ReactDOMClient.createRoot(container);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 120));
  });

const mount = async () => {
  await act(async () => {
    tree.render(React.createElement(OperationTimeline, { audit: { _id: 'x' } }));
  });
  await settle();
};

await mount();

/** The labels on screen, in the order they are drawn. */
const listed = () =>
  [...container.querySelectorAll('ol li')].map((li) => li.querySelector('span span')?.textContent ?? '');
const control = () =>
  [...container.querySelectorAll('button')].find((button) =>
    /Show (more|fewer)/.test(button.textContent ?? '')
  );
const text = () => container.textContent ?? '';

/* -------------------------------------------------------------------------- */
console.log('\nIt opens on the latest ten, not the first ten:');
{
  check('ten rows', listed().length === 10, String(listed().length));
  check(
    'the newest is at the bottom',
    listed()[9] === `Event number ${TOTAL}`,
    listed()[9]
  );
  check(
    '  and the window starts ten from the end',
    listed()[0] === `Event number ${TOTAL - 9}`,
    listed()[0]
  );
  check(
    '  so the start of the operation is not what you are shown',
    !listed().includes('Event number 1'),
    listed().slice(0, 2).join(' | ')
  );
  check(
    'they are still in the order things happened',
    listed().every((label, index) => label === `Event number ${TOTAL - 9 + index}`),
    listed().join(' | ')
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe control says what is missing, not how big the list is:');
{
  check('the button reads "Show more"', control()?.textContent.trim() === 'Show more', control()?.textContent);
  check('nothing says "Show all 37"', !text().includes('Show all'), '');
  check(
    'and it says how many earlier events there are',
    text().includes('27 earlier events not shown'),
    text().slice(0, 200)
  );
  check(
    'it sits above the list, where those rows will appear',
    container.querySelector('button')?.compareDocumentPosition(container.querySelector('ol')) ===
      dom.window.Node.DOCUMENT_POSITION_FOLLOWING,
    'the button precedes the list'
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nEach press adds ten more, backwards through the history:');
{
  await act(async () => {
    control().click();
  });
  check('twenty rows', listed().length === 20, String(listed().length));
  check(
    '  and the window has moved back, not forward',
    listed()[0] === `Event number ${TOTAL - 19}` && listed()[19] === `Event number ${TOTAL}`,
    `${listed()[0]} … ${listed()[19]}`
  );
  check('  seventeen left', text().includes('17 earlier events not shown'), text().slice(0, 200));

  await act(async () => {
    control().click();
  });
  check('thirty rows', listed().length === 30, String(listed().length));
  check('  seven left', text().includes('7 earlier events not shown'), '');

  await act(async () => {
    control().click();
  });
  check('the last press shows the rest, not thirty-seven plus three', listed().length === TOTAL, String(listed().length));
  check('  from the very first event', listed()[0] === 'Event number 1', listed()[0]);
  check('  and it now offers to collapse', control()?.textContent.trim() === 'Show fewer', control()?.textContent);
  check('  saying so plainly', text().includes('all 37 shown'), '');
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd collapsing goes back to the latest ten:');
{
  await act(async () => {
    control().click();
  });
  check('ten again', listed().length === 10, String(listed().length));
  check('the latest ten', listed()[0] === `Event number ${TOTAL - 9}`, listed()[0]);
  check('the button reads "Show more" again', control()?.textContent.trim() === 'Show more', '');
}

/* -------------------------------------------------------------------------- */
console.log('\nA short operation has nothing to press:');
{
  answer = {
    rows: rows.slice(0, 8),
    summary: { actions: 8, noticed: 1, timeToFirstNoticedLabel: '', longestQuiet: null },
    skipped: { runs: 0 },
  };
  await act(async () => {
    tree.unmount();
  });
  tree = ReactDOMClient.createRoot(container);
  await mount();

  check('all eight are listed', listed().length === 8, String(listed().length));
  check('  oldest first, from the very beginning', listed()[0] === 'Event number 1', listed()[0]);
  check('and there is no control at all', !control(), control()?.textContent);
  check('nor a count of what is missing', !text().includes('not shown'), '');
}

/* -------------------------------------------------------------------------- */
console.log('\nThe note about steps with no recorded time survives all of it:');
{
  answer = {
    rows,
    summary: { actions: TOTAL, noticed: 6, timeToFirstNoticedLabel: '4 days', longestQuiet: null },
    skipped: { runs: 2 },
  };
  await act(async () => {
    tree.unmount();
  });
  tree = ReactDOMClient.createRoot(container);
  await mount();

  check(
    'it is still said, now that it no longer shares a row with the old button',
    text().includes('2 steps ran without a recorded time'),
    text().slice(-200)
  );
}

await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
