/**
 * A click goes somewhere without the screen going blank, and says so if it takes a moment.
 *
 *   npm run test:navigation --workspace client
 *
 * Every page in this app is loaded on demand, which used to mean the same three frames on every
 * navigation: the click did nothing visible, the content area emptied, a spinner appeared. The
 * wait is unchanged — the chunk takes what it takes — but a reader looking at an empty room has
 * no evidence the click registered, and the usual response to that is to click again.
 *
 * Navigation now happens inside a transition, so React keeps the outgoing page on screen until the
 * incoming one is ready, and falls back to the spinner only when there is nothing to keep. A thin
 * bar appears along the top if the wait runs past what reads as instant.
 *
 * None of that is visible to the render smoke, which draws each page on its own and never
 * navigates. And all of it is the kind of behaviour that survives being deleted: take the
 * transition away and the app still works, it just feels the way it used to. So this drives a real
 * router at a deliberately slow lazy route and watches what is on screen at each step.
 *
 * The suspending route is held open by hand rather than being slow: a test that waited for a real
 * import would be asserting a race. `release()` is the only thing that lets the page arrive.
 */
import { JSDOM } from 'jsdom';
import path from 'node:path';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost:5173/here',
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
const { Suspense, lazy, useState } = React;
const ReactDOMClient = await import('react-dom/client');
const { act } = await import('react');

const { MemoryRouter, Routes, Route, useNavigate } = await load('react-router-dom');
const { NavigationProvider, useSmoothNavigate, useNavigationPending } = await load(
  '/src/context/NavigationContext.jsx'
);
const { NavigationProgress, APPEAR_AFTER_MS, LINGER_MS } = await load(
  '/src/components/layout/NavigationProgress.jsx'
);

const settle = (ms = 0) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });

/* -------------------------------------------------------------------------- */
/* A page that arrives only when this test says so                            */
/* -------------------------------------------------------------------------- */

let release = null;
const Slow = lazy(
  () =>
    new Promise((resolve) => {
      release = () => resolve({ default: () => React.createElement('p', null, 'The slow page') });
    })
);

/**
 * The two ways of going somewhere, side by side in one tree.
 *
 * `smooth` is the app's; `plain` is `useNavigate` straight, which is what every one of these call
 * sites used to be. Having both here is what makes the assertions mean anything: "the old page is
 * still visible" is only interesting next to a control that shows it would not have been.
 */
function Here() {
  const smooth = useSmoothNavigate();
  const plain = useNavigate();
  return React.createElement(
    'div',
    null,
    React.createElement('p', null, 'The page you were on'),
    React.createElement('button', { id: 'smooth', onClick: () => smooth('/slow') }, 'Smoothly'),
    React.createElement('button', { id: 'plain', onClick: () => plain('/slow') }, 'Plainly')
  );
}

/** What `NavigationProgress` reads, surfaced so the pending state itself can be asserted. */
function Pending() {
  return React.createElement('span', { id: 'pending' }, useNavigationPending() ? 'yes' : 'no');
}

/**
 * The app's configuration, not a simplified one.
 *
 * `v7_startTransition` is what makes the router mark its own state updates as transitions, and it
 * is the half of this that reaches the navigations nothing intercepts — every `<Link>` in the app
 * and every `navigate()` written before any of this existed. The provider is the other half: it
 * is what knows a navigation is *pending*, which is what draws the bar.
 */
const FUTURE = { v7_startTransition: true };

function Tree({ start = '/here' }) {
  return React.createElement(
    MemoryRouter,
    { initialEntries: [start], future: FUTURE },
    React.createElement(
      NavigationProvider,
      null,
      React.createElement(Pending, null),
      React.createElement(NavigationProgress, null),
      React.createElement(
        Suspense,
        { fallback: React.createElement('p', null, 'Loading…') },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '/here', element: React.createElement(Here, null) }),
          React.createElement(Route, { path: '/slow', element: React.createElement(Slow, null) })
        )
      )
    )
  );
}

const container = dom.window.document.createElement('div');
dom.window.document.body.appendChild(container);
let tree = ReactDOMClient.createRoot(container);

/**
 * What is actually on screen, which is not what `textContent` says.
 *
 * A boundary that suspends does not unmount what it was showing — React hides it, so it can be
 * put back untouched if the wait ends. `display: none` is invisible to `textContent`, so the
 * first version of the control below read "the old page and the spinner are both here" and
 * called that a pass. The distinction this whole file is about is exactly the one that string
 * cannot see.
 */
const visible = (node = container) => {
  let out = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out += child.textContent;
      continue;
    }
    if (child.nodeType !== 1) continue;
    if (child.style?.display === 'none' || child.hasAttribute?.('hidden')) continue;
    out += visible(child);
  }
  return out;
};

const text = () => visible();
const pendingSays = () => container.querySelector('#pending')?.textContent;
/** The bar is always mounted; what changes is whether it is drawn. */
const barShowing = () =>
  (container.querySelector('[aria-hidden="true"]')?.className ?? '').includes('opacity-100');
const click = async (id) => {
  const button = container.querySelector(`#${id}`);
  await act(async () => {
    button.click();
  });
};

await act(async () => {
  tree.render(React.createElement(Tree, null));
});
await settle();

/* -------------------------------------------------------------------------- */
console.log('\nThe page you are leaving stays until the next one is ready:');
{
  check('it starts where it was asked to', text().includes('The page you were on'), text());
  check('  and nothing is pending', pendingSays() === 'no', pendingSays());
  check('  and no bar is drawn', !barShowing(), 'the bar is up before anything happened');

  await click('smooth');
  await settle(20);

  /*
   * The whole feature, in one assertion. The route has changed and its component has not arrived,
   * so React has a suspending tree and a choice: show the fallback, or keep what is on screen.
   * Inside a transition it keeps it.
   */
  check(
    'the old page is still on screen while the new one loads',
    text().includes('The page you were on'),
    text()
  );
  check('  and the fallback is not', !text().includes('Loading…'), text());
  check('  and the navigation reports itself pending', pendingSays() === 'yes', pendingSays());

  /* Nothing is drawn yet: an ordinary navigation is faster than this and would only flicker. */
  check('  the bar holds off at first', !barShowing(), 'the bar appeared immediately');

  await settle(APPEAR_AFTER_MS + 60);
  check('and the bar appears once the wait is long enough to notice', barShowing(), 'no bar');

  await act(async () => {
    release();
  });
  await settle(20);

  check('the new page arrives', text().includes('The slow page'), text());
  check('  and nothing is pending any more', pendingSays() === 'no', pendingSays());
  /* Still up: a bar that vanished in the same frame it was seen in is a flicker, not a signal. */
  check('  and the bar lingers rather than blinking out', barShowing(), 'it went at once');

  await settle(LINGER_MS + 60);
  check('  then goes', !barShowing(), 'the bar stayed up');
}

/* -------------------------------------------------------------------------- */
console.log('\nWithout any of it the page empties, which is the point:');
{
  /* A fresh tree, because the lazy component above has resolved and can never suspend again. */
  await act(async () => {
    tree.unmount();
  });

  release = null;
  const SlowAgain = lazy(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ default: () => React.createElement('p', null, 'The slow page') });
      })
  );

  /*
   * Configured the way this app was until this change: no future flag, and `useNavigate` called
   * straight. Kept as a control because "the old page is still visible" is worth nothing as an
   * assertion unless something here shows that it would not have been.
   */
  function Control() {
    const plain = useNavigate();
    return React.createElement(
      'div',
      null,
      React.createElement('p', null, 'The page you were on'),
      React.createElement('button', { id: 'plain', onClick: () => plain('/slow') }, 'Plainly')
    );
  }

  tree = ReactDOMClient.createRoot(container);
  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/here'] },
        React.createElement(
          NavigationProvider,
          null,
          React.createElement(
            Suspense,
            { fallback: React.createElement('p', null, 'Loading…') },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: '/here',
                element: React.createElement(Control, null),
              }),
              React.createElement(Route, {
                path: '/slow',
                element: React.createElement(SlowAgain, null),
              })
            )
          )
        )
      )
    );
  });
  await settle();

  await click('plain');
  await settle(20);

  /*
   * The control. This is what every navigation in the app did until now, and what one will do
   * again the moment somebody writes `useNavigate()` out of habit in a component that moves
   * between pages.
   */
  check('a plain navigate empties the page', !text().includes('The page you were on'), text());
  check('  and shows the fallback instead', text().includes('Loading…'), text());
  /*
   * Hidden, not gone — which is worth asserting rather than assuming, because it is the reason
   * the check above had to be written against what is visible rather than against the markup.
   */
  check(
    '  (the old page is hidden rather than thrown away)',
    (container.textContent ?? '').includes('The page you were on'),
    container.textContent
  );

  await act(async () => {
    release();
  });
  await settle(20);
  check('  it does get there in the end — the difference is what you look at on the way', text().includes('The slow page'), text());
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd the fix reaches the navigations nothing intercepts:');
{
  /*
   * The shell routes its own clicks through `useSmoothNavigate`, but most links in this app are
   * ordinary `<Link>`s inside pages, and nobody is going to remember to convert them. The future
   * flag is what covers those: with it on, a plain `navigate()` — the same call the control above
   * blanks on — keeps the page too.
   */
  await act(async () => {
    tree.unmount();
  });

  release = null;
  const SlowThird = lazy(
    () =>
      new Promise((resolve) => {
        release = () => resolve({ default: () => React.createElement('p', null, 'The slow page') });
      })
  );

  function Unintercepted() {
    const plain = useNavigate();
    return React.createElement(
      'div',
      null,
      React.createElement('p', null, 'The page you were on'),
      React.createElement('button', { id: 'plain', onClick: () => plain('/slow') }, 'Plainly')
    );
  }

  tree = ReactDOMClient.createRoot(container);
  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/here'], future: FUTURE },
        React.createElement(
          NavigationProvider,
          null,
          React.createElement(
            Suspense,
            { fallback: React.createElement('p', null, 'Loading…') },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: '/here',
                element: React.createElement(Unintercepted, null),
              }),
              React.createElement(Route, {
                path: '/slow',
                element: React.createElement(SlowThird, null),
              })
            )
          )
        )
      )
    );
  });
  await settle();

  await click('plain');
  await settle(20);

  check(
    'a plain navigate keeps the page as well, once the router marks its own updates',
    text().includes('The page you were on'),
    text()
  );
  check('  and still no fallback', !text().includes('Loading…'), text());

  await act(async () => {
    release();
  });
  await settle(20);
  check('  and it arrives', text().includes('The slow page'), text());
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd the app is actually configured that way:');
{
  /*
   * Asserted against the source, because this one is a prop on a component nothing else renders.
   * Every check above would go on passing with the flag removed from the app — they configure
   * their own routers — and the app would quietly go back to blanking on every link.
   */
  const fs = await import('node:fs');
  const main = fs.readFileSync(path.join(root, 'src/main.jsx'), 'utf8');
  check(
    'the router marks its own updates as transitions',
    /<BrowserRouter future=\{\{ v7_startTransition: true \}\}>/.test(main),
    (main.match(/<BrowserRouter[^>]*>/) ?? [])[0] ?? 'no BrowserRouter found'
  );
  check(
    '  and the provider is above the app',
    /<NavigationProvider>/.test(main),
    'NavigationProvider is not in main.jsx'
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd a navigation nobody waits for draws nothing at all:');
{
  await act(async () => {
    tree.unmount();
  });

  function Instant() {
    const smooth = useSmoothNavigate();
    const [, force] = useState(0);
    return React.createElement(
      'div',
      null,
      React.createElement('p', null, 'First'),
      React.createElement(
        'button',
        {
          id: 'smooth',
          onClick: () => {
            force((n) => n + 1);
            smooth('/there');
          },
        },
        'Go'
      )
    );
  }

  tree = ReactDOMClient.createRoot(container);
  await act(async () => {
    tree.render(
      React.createElement(
        MemoryRouter,
        { initialEntries: ['/here'] },
        React.createElement(
          NavigationProvider,
          null,
          React.createElement(NavigationProgress, null),
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: '/here',
              element: React.createElement(Instant, null),
            }),
            React.createElement(Route, {
              path: '/there',
              element: React.createElement('p', null, 'Second'),
            })
          )
        )
      )
    );
  });
  await settle();

  await click('smooth');
  await settle(APPEAR_AFTER_MS + 80);

  /*
   * Nothing lazy, nothing to wait for. Most navigations in the app are this one — a chunk already
   * fetched and an endpoint already answered — and a bar that flashed on every one of them would
   * be saying "slow" about the fastest thing here.
   */
  check('the page changed', text().includes('Second'), text());
  check('  and no bar was ever drawn', !barShowing(), 'a bar appeared for an instant navigation');
}

await act(async () => {
  tree.unmount();
});
await vite.close();

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
