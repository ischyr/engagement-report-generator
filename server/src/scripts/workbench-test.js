/**
 * The enumeration workbench, in a browser, at a real width.
 *
 *   npm run test:workbench
 *
 * Written for one bug and kept for the class of it. Hiding the tree rendered the editor two pixels
 * wide: the pane was laid out as `grid-template-columns: 0 0 1fr` with the tree and the handle
 * hidden, and a grid does not place boxes for `display: none` children — so the editor auto-placed
 * into the *first* column, the zero, and the 1fr sat empty beside it. Every word wrapped onto its
 * own line.
 *
 * Nothing without layout could have found it. jsdom reports every width as zero, so a collapsed
 * pane and a healthy one look identical there; the SSR smoke renders the page once with no
 * interaction at all. This is the screen in the app with the most moving parts — a resizable
 * split, a tree that folds, an editor that saves on its own — and it had no browser coverage.
 *
 * Skips rather than fails when Chrome is not where it expects it, like `test:chunks`.
 */
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import mongoose from 'mongoose';

import { Audit } from '../models/audit.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { User } from '../models/user.model.js';

process.env.VAULT_KEY = process.env.VAULT_KEY || crypto.randomBytes(32).toString('hex');

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

const PASSWORD = 'TreePass123!';
const PORT = 4127;
const APP = `http://127.0.0.1:${PORT}`;

/*
 * Said before the app is built, not after.
 *
 * `createApp()` reads the allow-list once at construction, and a browser sends an Origin header on
 * every request it makes back to its own page. Set afterwards — or left to the `.env` default of
 * port 5173 — every call is refused and the failure reads as the sign-in never completing, which
 * is a long way from "CORS".
 *
 * Hence the dynamic import: a static one at the top of the file would have run first.
 */
process.env.CORS_ORIGIN = APP;
const { default: createApp } = await import('../app.js');

await mongoose.connect(`mongodb://127.0.0.1:27017/engy-workbench-${Date.now()}`);
const server = http.createServer(createApp());
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'engy-tree-'));
let chrome = null;
let socket = null;

try {
  await Settings.getSettings();
  const ines = await User.create({
    username: 'zz-tree',
    firstname: 'Ines',
    lastname: 'Adeyemi',
    email: 'zz-tree@example.invalid',
    password: PASSWORD,
    role: 'user',
    roles: ['user'],
    enabled: true,
    approvedAt: new Date(),
  });
  const company = await Company.create({ name: 'Northwind Logistics', createdBy: ines._id });

  const audit = await Audit.create({
    name: 'zz Shipment Portal Assessment',
    reference: 'ZZ-ENUM',
    company: company._id,
    creator: ines._id,
    state: 'EDIT',
    enumeration: [
      { title: 'Top level', kind: 'section', depth: 0 },
      { title: 'Subdomain sweep', tool: 'amass', target: 'northwind.example', depth: 1 },
      { title: 'Port scan', tool: 'nmap', target: '10.0.5.0/24', depth: 1 },
    ],
  });

  const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  if (!fs.existsSync(CHROME)) {
    console.log('\nSkipping: Chrome is not where this expects it.');
    console.log('\n0 passed, 0 failed\n');
    await mongoose.connection.dropDatabase().catch(() => {});
    await mongoose.disconnect().catch(() => {});
    server.close();
    process.exit(0);
  }

  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--remote-debugging-port=9789',
      `--user-data-dir=${profile}`,
      '--window-size=1560,950',
      '--hide-scrollbars',
      '--no-first-run',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );

  let version = null;
  for (let i = 0; i < 80 && !version; i += 1) {
    version = await fetch('http://127.0.0.1:9789/json/version')
      .then((r) => r.json())
      .catch(() => null);
    if (!version) await new Promise((r) => setTimeout(r, 250));
  }
  socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve) => (socket.onopen = resolve));
  let id = 0;
  const waiting = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id) {
      waiting.get(message.id)?.(message.result ?? message.error);
      waiting.delete(message.id);
    }
  };
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });

  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  const page = (m, p) => send(m, p, sessionId);
  await page('Page.enable');
  await page('Runtime.enable');

  const evaluate = async (expression) => {
    const r = await page('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? 'evaluate threw');
    return r.result?.value;
  };
  const settle = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (expression, what, timeout = 30000) => {
    const until = Date.now() + timeout;
    while (Date.now() < until) {
      if (await evaluate(expression).catch(() => false)) return true;
      await settle(150);
    }
    throw new Error(`gave up waiting for ${what}`);
  };
  const type = async (selector, text) => {
    await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await page('Input.insertText', { text });
  };

  /** The grid, its declared columns, and how wide the editor beside the tree actually is. */
  const layout = () =>
    evaluate(
      `(() => {
         const grid = [...document.querySelectorAll('div')].find(
           (el) => getComputedStyle(el).display === 'grid' && el.children.length >= 2 &&
                   el.querySelector('[aria-label="Resize the tree"]')
         );
         if (!grid) return JSON.stringify({ found: false });
         const style = getComputedStyle(grid);
         const shown = [...grid.children].filter((el) => getComputedStyle(el).display !== 'none');
         const editor = shown[shown.length - 1];
         return JSON.stringify({
           found: true,
           columns: style.gridTemplateColumns,
           childrenShown: shown.length,
           editorWidth: Math.round(editor.getBoundingClientRect().width),
           editorColumn: getComputedStyle(editor).gridColumnStart,
           gridWidth: Math.round(grid.getBoundingClientRect().width),
         });
       })()`
    ).then(JSON.parse);

  await page('Page.navigate', { url: `${APP}/login` });
  await waitFor(`Boolean(document.querySelector('input[autocomplete="username"]'))`, 'the form');
  await type('input[autocomplete="username"]', 'zz-tree');
  await type('input[autocomplete="current-password"]', PASSWORD);
  await evaluate(`document.querySelector('form button[type="submit"]').click()`);
  await waitFor("!location.pathname.startsWith('/login')", 'the app');
  await settle(1200);

  await page('Page.navigate', { url: `${APP}/engagements/${audit._id}/enumeration` });
  await waitFor(`document.body.innerText.includes('Top level')`, 'the workbench');
  await settle(2000);

  console.log('\nWith the tree showing:');
  const withTree = await layout();
  check('the split grid is there', withTree.found === true, JSON.stringify(withTree));
  check(
    `the editor has room (${withTree.editorWidth}px of ${withTree.gridWidth}px)`,
    withTree.editorWidth > 400,
    JSON.stringify(withTree)
  );
  console.log(`        columns: ${withTree.columns}`);

  console.log('\nAfter pressing Hide tree:');
  const clicked = await evaluate(
    `(() => { const b = [...document.querySelectorAll('button')].find(x => /hide tree|show tree/i.test(x.innerText||''));
       if (!b) return 'no toggle found'; const was = b.innerText.trim(); b.click(); return was; })()`
  );
  await settle(900);
  const hidden = await layout();
  console.log(`        the button said "${clicked}"`);
  console.log(`        columns: ${hidden.columns}`);
  console.log(`        the editor is in grid column ${hidden.editorColumn}`);

  check(
    `the editor still has room (${hidden.editorWidth}px of ${hidden.gridWidth}px)`,
    hidden.editorWidth > 400,
    JSON.stringify(hidden)
  );
  check(
    '  and is at least as wide as it was with the tree open',
    hidden.editorWidth >= withTree.editorWidth,
    `${hidden.editorWidth}px hidden vs ${withTree.editorWidth}px shown`
  );

  console.log('\nAnd pressing Show tree puts it back:');
  {
    const label = await evaluate(
      `(() => { const b = [...document.querySelectorAll('button')].find(x => /show tree/i.test(x.innerText||''));
         if (!b) return 'no Show tree button'; b.click(); return 'clicked'; })()`
    );
    check('the toggle offers the tree back', label === 'clicked', label);
    await settle(900);

    const back = await layout();
    check(
      'the split returns',
      back.childrenShown === 3,
      `${back.childrenShown} of 3 showing — ${back.columns}`
    );
    check(
      '  at the width it was left at, not a default',
      back.columns.startsWith(withTree.columns.split(' ')[0]),
      `${back.columns} vs ${withTree.columns}`
    );
    check(
      '  and the editor is its old size again',
      Math.abs(back.editorWidth - withTree.editorWidth) <= 2,
      `${back.editorWidth}px vs ${withTree.editorWidth}px`
    );
  }

} catch (error) {
  failed += 1;
  console.log(`\n  FAIL  the check itself stopped — ${error.stack}`);
} finally {
  try {
    if (socket) socket.close();
  } catch {}
  chrome?.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {}
  await mongoose.connection.dropDatabase().catch(() => {});
  await mongoose.disconnect().catch(() => {});
  server.close();
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
