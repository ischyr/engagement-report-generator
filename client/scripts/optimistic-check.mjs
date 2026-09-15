/**
 * A tick shows at once, and goes back if the server refuses it.
 *
 *   npm run test:optimistic --workspace client
 *
 * Every small write in this app was send-wait-refetch-redraw: ticking a check on a methodology
 * list was a POST and then a GET before the box moved. Beside the server that is invisible; over a
 * VPN from a client site — which is where this software is actually used — it is a checkbox that
 * hesitates, forty times down a list, and the application feels broken though nothing is.
 *
 * `optimistically` draws the answer first. Which introduces the one failure mode that did not
 * exist before: a write that fails after the screen has already agreed with it. So the rollback is
 * the half of this file worth having — a tick left standing over a write that was refused is worse
 * than the hesitation it replaced, because the next person to open the engagement sees the truth
 * and has no way to know why it differs.
 *
 * The request is held open by hand rather than being slow, so "before it lands" is a real moment
 * rather than a race.
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
  'NodeList',
  'Element',
  'HTMLElement',
  'Text',
  'Event',
  'MouseEvent',
  'requestAnimationFrame',
  'cancelAnimationFrame',
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
const { useState } = React;
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');

const { optimistically, replacing } = await load('/src/lib/optimistic.js');

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
let tree = ReactDOMClient.createRoot(container);
const text = () => container.textContent ?? '';

/* -------------------------------------------------------------------------- */
/* A list of two rows and a button that pins the first                        */
/* -------------------------------------------------------------------------- */

const ROWS = [
  { _id: 'n1', title: 'First note', pinned: false },
  { _id: 'n2', title: 'Second note', pinned: true },
];

/** Held open until the test decides. */
let land = null;
let refuse = null;
let reloads = 0;

function Page({ onError }) {
  const [rows, setRows] = useState(ROWS);

  const toggle = async () => {
    try {
      await optimistically({
        from: rows,
        to: replacing(rows, 'n1', { pinned: true }),
        setData: setRows,
        request: () =>
          new Promise((resolve, reject) => {
            land = resolve;
            refuse = reject;
          }),
        reload: async () => {
          reloads += 1;
        },
      });
    } catch (error) {
      onError?.(error);
    }
  };

  return React.createElement(
    'div',
    null,
    React.createElement('button', { id: 'pin', onClick: toggle }, 'Pin'),
    React.createElement(
      'p',
      { id: 'state' },
      rows.map((row) => `${row.title}:${row.pinned ? 'pinned' : 'loose'}`).join(' ')
    )
  );
}

const state = () => container.querySelector('#state')?.textContent ?? '';
const clickPin = async () => {
  await act(async () => {
    container.querySelector('#pin').click();
  });
};

/* -------------------------------------------------------------------------- */
console.log('\nThe tick is on screen before the server has been asked:');
{
  await act(async () => {
    tree.render(React.createElement(Page, null));
  });
  await settle();

  check('it starts as it was', state() === 'First note:loose Second note:pinned', state());

  await clickPin();
  /*
   * No settle, no resolution — the request is sitting open. This is the entire feature: what the
   * reader is looking at while the round trip happens.
   */
  check(
    'the row is pinned while the write is still in flight',
    state() === 'First note:pinned Second note:pinned',
    state()
  );
  check('  and nothing else moved', state().includes('Second note:pinned'), state());
  check('  and no reload has happened yet', reloads === 0, String(reloads));

  await act(async () => {
    land({ ok: true });
  });
  await settle();

  check('it stays pinned once the write lands', state().startsWith('First note:pinned'), state());
  /*
   * The quiet reload matters: the optimistic value is a prediction about one field, and the server
   * may have touched more. Nobody waits for it, which is the difference from where this started.
   */
  check('  and the truth is fetched quietly behind it', reloads === 1, String(reloads));
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd it goes back if the server refuses:');
{
  await act(async () => {
    tree.unmount();
  });
  tree = ReactDOMClient.createRoot(container);
  reloads = 0;

  let reported = null;
  await act(async () => {
    tree.render(React.createElement(Page, { onError: (error) => (reported = error) }));
  });
  await settle();

  await clickPin();
  check('the row is pinned optimistically', state().startsWith('First note:pinned'), state());

  await act(async () => {
    refuse(new Error('Nope'));
  });
  await settle();

  /*
   * The half that makes the other half safe. Without it the screen keeps a value the server
   * rejected, with nothing coming along to correct it — a lie with no expiry.
   */
  check('and the refusal puts it back', state() === 'First note:loose Second note:pinned', state());
  check('  nothing is refetched over a failed write', reloads === 0, String(reloads));
  /*
   * And the error still reaches the page. Every call site already had a `catch` that knows what to
   * say about it — which row, and whether a conflict wants the conflict dialog rather than a
   * toast — so swallowing it here would silently disarm all of that.
   */
  check('  and the error still reaches the caller', reported?.message === 'Nope', String(reported));
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd `replacing` touches one row, by string:');
{
  const rows = [{ _id: 'a', n: 1 }, { _id: 'b', n: 2 }];
  const out = replacing(rows, 'b', { n: 9 });
  check('the named row changed', out[1].n === 9, JSON.stringify(out));
  check('  the others did not', out[0].n === 1, JSON.stringify(out));
  check('  and none of them is the original object', out[1] !== rows[1], 'it mutated in place');
  /* Ids arrive as an ObjectId from one endpoint and a string from the next. */
  check(
    '  an id that is not a string still matches',
    replacing([{ _id: { toString: () => 'x' }, n: 1 }], 'x', { n: 5 })[0].n === 5,
    'strict equality crept back in'
  );
  check('  and nothing at all is handled', replacing(undefined, 'a', {}).length === 0, 'threw');
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd no toggle has gone back to waiting for the round trip:');
{
  const fs = await import('node:fs');
  const walk = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.name.endsWith('.jsx') ? [full] : [];
    });

  /*
   * The shape this replaced, written out: a one-field boolean flip, awaited, then a refetch. It
   * is the natural thing to write and it will be written again — this is here so that when it is,
   * somebody is told there is a helper for it rather than finding out from a user.
   */
  const pessimistic = /await api\.(put|post)\(`[^`]*`, \{ \w+: !/;
  const offenders = walk(path.join(root, 'src')).filter((file) =>
    pessimistic.test(fs.readFileSync(file, 'utf8'))
  );
  check(
    'no single-field toggle waits for the server before drawing',
    offenders.length === 0,
    offenders.map((file) => path.relative(root, file)).join(', ')
  );
}

await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
