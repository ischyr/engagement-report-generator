/**
 * Screenshots of the running app, for the documentation and the presentation site.
 *
 *   npm run shots
 *
 * What it needs, and it says so rather than guessing: the app running (`npm run dev`), the demo
 * engagement loaded (`npm run seed:demo`), and Chrome installed. It signs in as the demo lead,
 * visits seven pages, and writes them into `docs/public/shots`, which is where the documentation
 * reads them from.
 *
 * The presentation site is published from its own repository and uses the same pictures. If that
 * checkout is next door, this refreshes its copy too, so one command still updates both.
 *
 * Why it drives Chrome over the DevTools protocol rather than using a browser automation library:
 * the only thing needed here is navigate, type, click, screenshot, and Chrome answers all four over
 * a socket it already speaks. A library for that would be a hundred and thirty megabytes of second
 * browser downloaded into a workspace whose entire job is one static page. Node 22 has a WebSocket
 * client built in, so this file adds no dependency at all.
 *
 * It only ever photographs the demo engagement. That is not a detail: every other engagement in a
 * developer's database is somebody's real client, and a landing page is the last place it should
 * turn up. If the demo seed is not there, this stops.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * The presentation site's copy of these, if it is checked out beside this repository.
 *
 * Two copies of two megabytes, which is the price of the site being its own repository: a build
 * that reaches into a sibling checkout is worse than a second copy of some pictures. Overridable,
 * and skipped in silence when it is not there.
 */
const SITE_SHOTS =
  process.env.SITE_SHOTS ??
  path.resolve(ROOT, '..', 'engagement-report-generator-presentation', 'public', 'shots');

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : args[at + 1];
};

const CONFIG = {
  /* localhost rather than 127.0.0.1: the API's allowed origin is the one Vite prints. */
  app: option('app', 'http://localhost:5173'),
  api: option('api', 'http://localhost:4000/api'),
  user: option('user', 'zz-demo-lead'),
  password: option('password', 'DemoPass123!'),
  /* The window the app is photographed in. Wide enough for the real layout, not a laptop crop. */
  width: Number(option('width', 1440)),
  height: Number(option('height', 900)),
  /* Twice the pixels, because these are displayed at about half this width on a retina screen. */
  scale: Number(option('scale', 2)),
  /*
   * JPEG rather than PNG. A screenshot of a dark interface is a photograph as far as a compressor
   * is concerned: the PNGs came out at three quarters of a megabyte each, which is not a thing to
   * put on a landing page five times over. At this quality and twice the display size there is
   * nothing visible to lose.
   */
  quality: Number(option('quality', 88)),
  out: option('out', path.join(ROOT, 'docs', 'public', 'shots')),
  only: option('only', ''),
  keep: args.includes('--keep-open'),
};

const die = (...lines) => {
  console.error(`\n${lines.join('\n')}\n`);
  process.exit(1);
};

/* -------------------------------------------------------------------------- */
/* What to photograph                                                         */
/* -------------------------------------------------------------------------- */
/**
 * Each shot names a route, something to wait for that proves the page has its data, and optionally
 * something to do before the shutter. `ready` is a demo-specific string on purpose: waiting for a
 * spinner to go away photographs an empty table often enough, and waiting for content that only
 * exists once the fetch landed cannot.
 *
 * `act` is for the pages whose interesting part is not at the top. A finding is a long form, and
 * photographing the first screen of it shows a title field: the scoring, which is what the page
 * beside this screenshot is about, is eight hundred pixels down.
 */

/** Scrolls the element whose text starts with `needle` to the middle of the window. */
const scrollTo = (needle) => `(() => {
  const wanted = ${JSON.stringify(needle)};
  const leaves = [...document.querySelectorAll('h2, h3, label, legend, button, span, div')].filter(
    (node) => node.children.length === 0 && node.textContent.trim().startsWith(wanted)
  );
  const target = leaves[0];
  if (!target) return false;
  (target.closest('section, fieldset, div') ?? target).scrollIntoView({ block: 'center' });
  return true;
})()`;

/**
 * Clicks the first control whose accessible name or text matches, and waits for whatever it opens.
 *
 * Two of these pages keep the thing worth photographing one click in: the annotator is opened from
 * an item in the evidence bin, and a step's command and output only appear once the step is
 * selected in the tree. A screenshot of the page you land on would be a screenshot of a list.
 */
const click = (needle) => `(() => {
  const wanted = ${JSON.stringify(needle)};
  const name = (node) =>
    \`\${node.getAttribute('aria-label') ?? ''} \${node.getAttribute('title') ?? ''} \${node.textContent ?? ''}\`;
  const matches = [
    ...document.querySelectorAll('button, a, [role="button"], [role="treeitem"], li, span, div'),
  ].filter((node) => name(node).includes(wanted) && node.offsetParent !== null);
  /*
   * The deepest match, which is the last of them in document order.
   *
   * The first attempt took the first match and clicked the list item wrapping the row, which has no
   * handler on it: the tree selects on a div inside. A click event bubbles, so aiming at the
   * innermost element that carries the text reaches whichever ancestor is actually listening.
   */
  const target = matches[matches.length - 1];
  if (!target) return false;
  target.click();
  return true;
})()`;

const SHOTS = [
  {
    name: 'findings',
    what: 'The findings list of the demo engagement',
    route: (id) => `/engagements/${id}?tab=findings`,
    ready: 'Shipment documents readable without authentication',
  },
  {
    name: 'finding',
    what: 'One finding, scrolled to the score',
    route: (id, findingId) => `/engagements/${id}/findings/${findingId}`,
    ready: 'CVSS',
    act: scrollTo('CVSS'),
  },
  {
    name: 'evidence',
    what: 'The annotator, opened on a capture in the bin',
    route: (id) => `/engagements/${id}?tab=evidence`,
    ready: 'Evidence bin',
    act: click('Annotate or redact'),
    crop: '[role="dialog"]',
    /* The dialog fades in and the canvas draws the bitmap on the frame after that. */
    after: 900,
  },
  {
    name: 'delivery',
    what: 'Rendering, protecting and recording the deliverable',
    route: (id) => `/engagements/${id}?tab=delivery`,
    ready: 'Delivery record',
  },
  {
    name: 'enumeration',
    what: 'The enumeration workbench, on the step that became a finding',
    route: (id) => `/engagements/${id}/enumeration`,
    ready: 'Passive subdomain sweep',
    act: click('The document endpoint'),
  },
  {
    name: 'lock',
    what: 'The soft lock on a finding nobody has taken',
    route: (id, findingId) => `/engagements/${id}/findings/${findingId}`,
    ready: 'Lock it while you rewrite',
    crop: 'text:Anyone can edit this finding',
  },
  {
    name: 'checks',
    what: 'A part-worked methodology',
    route: (id) => `/engagements/${id}?tab=checks`,
    ready: 'Reconnaissance',
  },
];

/* -------------------------------------------------------------------------- */
/* Finding Chrome                                                             */
/* -------------------------------------------------------------------------- */
const chromePath = () => {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA ?? '';
  const candidates =
    process.platform === 'win32'
      ? [
          'C:/Program Files/Google/Chrome/Application/chrome.exe',
          'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
          path.join(local, 'Google/Chrome/Application/chrome.exe'),
          'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
          'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
          ]
        : [
            '/usr/bin/google-chrome',
            '/usr/bin/chromium',
            '/usr/bin/chromium-browser',
            '/snap/bin/chromium',
          ];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    die(
      'No Chrome found.',
      'Set CHROME_PATH to the browser to use, or install Chrome or Chromium.',
      `Looked in:\n  ${candidates.join('\n  ')}`
    );
  }
  return found;
};

/* -------------------------------------------------------------------------- */
/* A very small DevTools protocol client                                      */
/* -------------------------------------------------------------------------- */
const openSocket = async (url) => {
  const Impl =
    globalThis.WebSocket ??
    (await import('ws').then((module) => module.default).catch(() => null));
  if (!Impl) {
    die(
      'This needs a WebSocket client.',
      'Node 22 has one built in; on Node 20 run node with --experimental-websocket.'
    );
  }
  const socket = new Impl(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = (event) => reject(new Error(event?.message ?? 'the socket refused to open'));
  });
  return socket;
};

class Devtools {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.waiting = new Map();
    socket.onmessage = (event) => {
      const message = JSON.parse(
        typeof event.data === 'string' ? event.data : String(event.data)
      );
      const pending = this.waiting.get(message.id);
      if (!pending) return;
      this.waiting.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    };
  }

  send(method, params = {}, sessionId) {
    const id = (this.next += 1);
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params, sessionId }));
      setTimeout(() => {
        if (this.waiting.delete(id)) reject(new Error(`${method} never answered`));
      }, 30000);
    });
  }
}

/* -------------------------------------------------------------------------- */
/* Preflight: is any of this running?                                         */
/* -------------------------------------------------------------------------- */
const reach = async (url, what) => {
  try {
    return await fetch(url, { redirect: 'manual' });
  } catch (error) {
    return die(`${what} is not answering at ${url} (${error.cause?.code ?? error.message}).`, '', 'Start it with:  npm run dev');
  }
};

console.log('\nLooking for the app:');
await reach(CONFIG.app, 'The app');
console.log(`  the app is up on ${CONFIG.app}`);

/*
 * With a few goes at it. The API in development restarts itself whenever a file is saved, so a
 * script that gives up on one refused connection fails for a reason that has nothing to do with it.
 */
const login = await (async () => {
  let last = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await fetch(`${CONFIG.api}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: CONFIG.user, password: CONFIG.password }),
    }).catch((error) => {
      last = error.cause?.code ?? error.message;
      return null;
    });
    if (response) return response;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return die(`The API is not answering at ${CONFIG.api} (${last}).`, '', 'Start it with:  npm run dev');
})();

if (!login.ok) {
  die(
    `Cannot sign in as ${CONFIG.user} (${login.status}).`,
    '',
    'These shots are taken of the demo engagement and nothing else. Load it with:',
    '  npm run seed:demo'
  );
}
const session = await login.json();
console.log(`  signed in as ${CONFIG.user}`);

/*
 * The engagement to photograph, found by name rather than by an id pasted into this file. Only the
 * demo one is allowed: a screenshot of anybody else's engagement does not belong on a public page,
 * and that is worth enforcing here rather than remembering.
 */
const audits = await fetch(`${CONFIG.api}/audits`, {
  headers: { Authorization: `Bearer ${session.accessToken ?? session.token}` },
}).then((response) => (response.ok ? response.json() : []));

const list = Array.isArray(audits) ? audits : (audits.items ?? audits.data ?? []);
const demo = list.find((audit) => /northwind/i.test(audit.name ?? ''));
if (!demo) {
  die(
    'The demo engagement is not in this database.',
    '',
    'This script photographs the demo engagement and refuses to photograph any other, because',
    'every other one in a working database belongs to somebody real. Load it with:',
    '  npm run seed:demo'
  );
}
const engagementId = demo._id ?? demo.id;
console.log(`  photographing "${demo.name}"`);

const detail = await fetch(`${CONFIG.api}/audits/${engagementId}`, {
  headers: { Authorization: `Bearer ${session.accessToken ?? session.token}` },
}).then((response) => (response.ok ? response.json() : null));

/* The finding to open: the worst one, because that is the one with a score worth showing. */
const findings = detail?.findings ?? [];
const ORDER = ['critical', 'high', 'medium', 'low', 'informative', 'none'];
const worst = [...findings].sort(
  (a, b) =>
    ORDER.indexOf(String(a.severity ?? a.cvssSeverity ?? '').toLowerCase()) -
    ORDER.indexOf(String(b.severity ?? b.cvssSeverity ?? '').toLowerCase())
)[0];
const findingId = worst?._id ?? findings[0]?._id;
if (!findingId) die('The demo engagement has no findings, which should not be possible.');

/* -------------------------------------------------------------------------- */
/* Drive the browser                                                          */
/* -------------------------------------------------------------------------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'engy-shots-'));
const port = 9500 + Math.floor(Math.random() * 400);
const browser = chromePath();

console.log('\nStarting the browser:');
const chrome = spawn(
  browser,
  [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    `--window-size=${CONFIG.width},${CONFIG.height}`,
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    /* The app is dark-only, and a white flash between navigations lands in a screenshot. */
    '--force-dark-mode',
    'about:blank',
  ],
  { stdio: 'ignore', detached: false }
);
chrome.on('error', (error) => die(`Could not start ${browser}: ${error.message}`));

/* Chrome writes the socket address to its own HTTP endpoint once it is listening. */
let version = null;
for (let attempt = 0; attempt < 60 && !version; attempt += 1) {
  version = await fetch(`http://127.0.0.1:${port}/json/version`)
    .then((response) => response.json())
    .catch(() => null);
  if (!version) await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!version) die(`${browser} started but never opened a debugging port on ${port}.`);
console.log(`  ${version.Browser}`);

const devtools = new Devtools(await openSocket(version.webSocketDebuggerUrl));

const { targetId } = await devtools.send('Target.createTarget', { url: 'about:blank' });
const { sessionId } = await devtools.send('Target.attachToTarget', { targetId, flatten: true });
const page = (method, params) => devtools.send(method, params, sessionId);

await page('Page.enable');
await page('Runtime.enable');
await page('Emulation.setDeviceMetricsOverride', {
  width: CONFIG.width,
  height: CONFIG.height,
  deviceScaleFactor: CONFIG.scale,
  mobile: false,
});

const evaluate = async (expression) => {
  const result = await page('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? 'evaluation failed');
  }
  return result.result?.value;
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (expression, what, timeout = 25000) => {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await evaluate(expression).catch(() => false)) return true;
    await settle(200);
  }
  throw new Error(`gave up waiting for ${what}`);
};

const go = async (url) => {
  await page('Page.navigate', { url });
  await waitFor("document.readyState === 'complete'", 'the document');
};

/* ------------------------------------------------------------------ sign in */
console.log('\nSigning in:');
await go(`${CONFIG.app}/login`);
await waitFor(
  `Boolean(document.querySelector('input[autocomplete="username"]'))`,
  'the sign-in form'
);

/*
 * Typed rather than assigned. The fields are React-controlled, so setting `.value` updates the DOM
 * and nothing else: the component's own state stays empty and the form submits two blank strings.
 * `Input.insertText` is a real text input event, which is exactly what a keyboard would send.
 */
const type = async (selector, text) => {
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
  await page('Input.insertText', { text });
};
await type('input[autocomplete="username"]', CONFIG.user);
await type('input[autocomplete="current-password"]', CONFIG.password);
await evaluate(`document.querySelector('form button[type="submit"]').click()`);
await waitFor("!location.pathname.startsWith('/login')", 'the app to let us in');
console.log('  in');

/* ---------------------------------------------------------------- the shots */
fs.mkdirSync(CONFIG.out, { recursive: true });
const wanted = CONFIG.only ? CONFIG.only.split(',').map((name) => name.trim()) : null;

console.log('\nTaking them:');
const taken = [];
for (const shot of SHOTS) {
  if (wanted && !wanted.includes(shot.name)) continue;
  const url = `${CONFIG.app}${shot.route(engagementId, findingId)}`;
  try {
    await go(url);
    if (shot.ready) {
      await waitFor(
        `document.body.innerText.includes(${JSON.stringify(shot.ready)})`,
        `"${shot.ready}" on ${shot.name}`
      );
    }
    if (shot.act) {
      /*
       * Polled rather than tried once. `ready` can only wait for text, and on a tab whose panel
       * heading renders before its own fetch resolves the heading is there a beat before the rows
       * are, so the first attempt to click a row found a page that had not finished arriving.
       */
      await waitFor(shot.act, `something to act on for ${shot.name}`, 10000);
      await settle(shot.after ?? 400);
    }

    /*
     * A pause after the content arrives. Charts draw on a frame of their own, images decode, and a
     * transition caught halfway through is the difference between a screenshot and a smear.
     */
    await settle(1200);

    /*
     * Cropped to one element, where the whole window would be mostly dimmed background. A dialog is
     * 800 pixels of content in the middle of a 1440 pixel window, and at the size these are shown
     * on the page that would be a postage stamp inside a dark rectangle.
     */
    let clip;
    if (shot.crop) {
      /*
       * Either a selector or `text:something`. The second is for the elements the app gives no
       * handle on: a banner is identified by the sentence in it, and adding a test id to the
       * application so that a landing page can crop a screenshot would be the wrong way round.
       */
      const needle = shot.crop.startsWith('text:') ? shot.crop.slice(5) : null;
      const find = needle
        ? `[...document.querySelectorAll('div, section, p, aside')]
             .filter((node) => (node.textContent ?? '').includes(${JSON.stringify(needle)}))
             .filter((node) => node.offsetParent !== null)
             .sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]`
        : `document.querySelector(${JSON.stringify(shot.crop)})`;

      const rect = await evaluate(`(() => {
        const el = ${find};
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const pad = 18;
        return {
          x: Math.max(0, r.x - pad),
          y: Math.max(0, r.y - pad),
          width: Math.min(window.innerWidth, r.width + pad * 2),
          height: Math.min(window.innerHeight, r.height + pad * 2),
        };
      })()`);
      if (!rect) throw new Error(`nothing matched ${shot.crop} to crop to`);
      /*
       * Scale 1, not the configured 2.
       *
       * `clip.scale` multiplies with the emulated device scale factor rather than replacing it,
       * which is not what the protocol documentation led me to expect: passing 2 here produced a
       * 4240 pixel wide image of a 1060 pixel dialog. Measured, not assumed.
       */
      clip = { ...rect, scale: 1 };
    }

    const { data } = await page('Page.captureScreenshot', {
      format: 'jpeg',
      quality: CONFIG.quality,
      captureBeyondViewport: false,
      ...(clip ? { clip } : {}),
    });
    const file = path.join(CONFIG.out, `${shot.name}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    const kb = Math.round(fs.statSync(file).size / 1024);
    taken.push({ ...shot, file, kb });
    console.log(`  ${shot.name.padEnd(12)} ${String(kb).padStart(4)} kB  ${shot.what}`);
  } catch (error) {
    console.log(`  ${shot.name.padEnd(12)}    -   ${error.message}`);
  }
}

/* ------------------------------------------------------------------ tidy up */
if (!CONFIG.keep) {
  await devtools.send('Browser.close').catch(() => {});
  await settle(300);
  if (chrome.exitCode === null) chrome.kill();
  fs.rmSync(profile, { recursive: true, force: true });
}

/*
 * And the site's copy, if it is there. Copied rather than captured twice: the same bytes in both
 * places is the point, and a second run of the browser would produce two slightly different files.
 */
let copied = 0;
if (taken.length && fs.existsSync(path.dirname(SITE_SHOTS))) {
  fs.mkdirSync(SITE_SHOTS, { recursive: true });
  for (const shot of taken) {
    fs.copyFileSync(shot.file, path.join(SITE_SHOTS, path.basename(shot.file)));
    copied += 1;
  }
}

console.log(
  `\n${taken.length} of ${wanted ? wanted.length : SHOTS.length} written to ${path.relative(ROOT, CONFIG.out)}`
);
console.log(
  copied
    ? `and copied to ${SITE_SHOTS}\n`
    : `the presentation site's copy was left alone (nothing at ${SITE_SHOTS})\n`
);
process.exit(taken.length ? 0 : 1);
