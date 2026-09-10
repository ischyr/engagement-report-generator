/**
 * Checks that one URL means one request.
 *
 *   npm run test:resource
 *
 * The sharing layer under `useResource` is invisible when it works: pages look exactly as they did,
 * there is simply less traffic. That is precisely why it needs checking — a dedupe that quietly
 * stops deduping costs nothing visible, and a cache that quietly stops revalidating costs
 * correctness. So each rule it claims gets a line here.
 *
 * No vite and no jsdom: the module has no imports and no DOM, which is what makes it testable at
 * all. It is exercised through its own interface with a fake sender, so what is measured is how
 * many times that sender was called.
 */
const module = await import('../src/lib/resource-cache.js');
const { cachedValue, fetchShared, clearResourceCache, resourceCacheState, FRESH_MS } = module;

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`);
  }
};

/** A sender that counts its calls and settles when told to. */
function sender(value, { fails = false } = {}) {
  const state = { calls: 0, settle: null, signals: [] };
  state.send = (signal) => {
    state.calls += 1;
    state.signals.push(signal);
    return new Promise((resolve, reject) => {
      state.settle = () => (fails ? reject(value) : resolve(value));
    });
  };
  return state;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/* ------------------------------------------------------------------ sharing */
console.log('\nTwo readers, one request:');
{
  const source = sender({ ok: 1 });
  const first = fetchShared('/one', source.send);
  const second = fetchShared('/one', source.send);

  check('a second caller does not start a second request', source.calls === 1, `${source.calls} calls`);
  check('and both hold the same promise', first.promise === second.promise);

  source.settle();
  const [a, b] = await Promise.all([first.promise, second.promise]);
  check('both are given the same answer', a === b && a.ok === 1, JSON.stringify({ a, b }));
  check(
    'and the request is no longer in flight once it has settled',
    resourceCacheState().inFlight === 0,
    JSON.stringify(resourceCacheState())
  );
}

console.log('\nAnd afterwards:');
{
  check('the answer is remembered', cachedValue('/one')?.data?.ok === 1);
  check('a URL nobody asked for is not', cachedValue('/never') === null);

  const again = sender({ ok: 2 });
  const handle = fetchShared('/one', again.send);
  check(
    'asking again still asks — memory paints, it does not answer',
    again.calls === 1,
    `${again.calls} calls`
  );
  again.settle();
  await handle.promise;
  check('and the newer answer replaces the older one', cachedValue('/one')?.data?.ok === 2);
  handle.detach();
}

/* ------------------------------------------------------------------ leaving */
console.log('\nWhen the last reader leaves:');
{
  const source = sender({ ok: 3 });
  const one = fetchShared('/two', source.send);
  const two = fetchShared('/two', source.send);

  one.detach();
  await tick();
  check(
    'one of two leaving does not stop the request',
    source.signals[0].aborted === false && resourceCacheState().inFlight === 1,
    JSON.stringify({ aborted: source.signals[0].aborted, ...resourceCacheState() })
  );

  two.detach();
  await tick();
  check('the last one leaving stops it', source.signals[0].aborted === true);
  check('and it is dropped from the map', resourceCacheState().inFlight === 0);
}

console.log('\nAnd when the last reader leaves and comes straight back:');
{
  const source = sender({ ok: 4 });
  const before = fetchShared('/three', source.send);
  /*
   * An unmount and a mount in the same tick, which is what strict mode does to every effect and
   * what a changed `key` does to a subtree. This is the case the deferred abort exists for.
   */
  before.detach();
  const after = fetchShared('/three', source.send);
  await tick();

  check('the request is kept rather than restarted', source.calls === 1, `${source.calls} calls`);
  check('and it was never aborted', source.signals[0].aborted === false);

  source.settle();
  const value = await after.promise;
  check('so the one that came back is answered', value.ok === 4, JSON.stringify(value));
}

/* ------------------------------------------------------------------ failing */
console.log('\nWhen it fails:');
{
  const source = sender(new Error('no'), { fails: true });
  const one = fetchShared('/four', source.send);
  const two = fetchShared('/four', source.send);
  source.settle();

  const results = await Promise.allSettled([one.promise, two.promise]);
  check(
    'every caller is told, not just the first',
    results.every((entry) => entry.status === 'rejected' && entry.reason.message === 'no'),
    JSON.stringify(results.map((entry) => entry.status))
  );
  check('nothing is remembered from a failure', cachedValue('/four') === null);
  check('and it is dropped from the map', resourceCacheState().inFlight === 0);
}

console.log('\nA failure nobody is waiting for:');
{
  /*
   * The rejection must be handled inside the module too. Without that this line is an
   * `unhandledRejection` — which in Node is a crash, and in a browser is a red console entry that
   * says nothing to anybody.
   */
  let crashed = null;
  process.once('unhandledRejection', (error) => {
    crashed = error;
  });

  const source = sender(new Error('nobody cares'), { fails: true });
  const handle = fetchShared('/five', source.send);
  handle.detach();
  source.settle();
  await tick();
  await tick();

  check('does not become an unhandled rejection', crashed === null, String(crashed));
}

/* -------------------------------------------------------------------- writes */
console.log('\nAfter something is written:');
{
  const source = sender({ ok: 5 });
  const handle = fetchShared('/six', source.send);
  source.settle();
  await handle.promise;
  check('the answer starts out remembered', cachedValue('/six')?.data?.ok === 5);

  const running = sender({ ok: 6 });
  const inFlight = fetchShared('/seven', running.send);

  clearResourceCache();

  check('a write forgets what was remembered', cachedValue('/six') === null);
  check(
    'but leaves a request somebody is waiting on alone',
    resourceCacheState().inFlight === 1 && running.signals[0].aborted === false,
    JSON.stringify(resourceCacheState())
  );

  running.settle();
  const value = await inFlight.promise;
  check('so that read still answers', value.ok === 6, JSON.stringify(value));
  inFlight.detach();
}

/* --------------------------------------------------------------------- stale */
console.log('\nAnd how long memory lasts:');
{
  check(
    'the window is short enough to be a paint and not an answer',
    FRESH_MS > 0 && FRESH_MS <= 60_000,
    `${FRESH_MS}ms`
  );

  const source = sender({ ok: 7 });
  const handle = fetchShared('/eight', source.send);
  source.settle();
  await handle.promise;

  const held = resourceCacheState().values;

  /* Reaching into Date rather than waiting half a minute for a clock to prove a comparison. */
  const realNow = Date.now;
  Date.now = () => realNow() + FRESH_MS + 1;
  const afterwards = cachedValue('/eight');
  Date.now = realNow;

  check('anything older than the window is not painted', afterwards === null, JSON.stringify(afterwards));
  /*
   * One fewer than a moment ago — measured as a drop rather than as a total, because other URLs
   * from the blocks above are legitimately still remembered and counting them all would make this
   * pass or fail depending on what was tested before it.
   */
  check(
    'and reading a stale one forgets it rather than keeping it for ever',
    resourceCacheState().values === held - 1,
    JSON.stringify({ before: held, after: resourceCacheState().values })
  );
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
