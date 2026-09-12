/**
 * Renders every page component through Vite's SSR pipeline with a stubbed
 * session and no network. This exercises the loading/empty branches — where
 * crashes from undefined data usually hide — and surfaces bad hook usage,
 * undefined components and prop-type mistakes that bundling cannot detect.
 */
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';

import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');

const vite = await createServer({
  root,
  configFile: path.join(root, 'vite.config.js'),
  server: { middlewareMode: true, hmr: false },
  appType: 'custom',
  logLevel: 'error',
});

const load = (p) => vite.ssrLoadModule(p);

const { MemoryRouter, Routes, Route } = await load('react-router-dom');
const { ToastProvider } = await load('/src/context/ToastContext.jsx');
const AuthContextModule = await load('/src/context/AuthContext.jsx');
const AuthContext = AuthContextModule.default;

const ADMIN = {
  id: '650000000000000000000001',
  username: 'admin',
  email: 'admin@engy.local',
  firstname: 'Engy',
  lastname: 'Administrator',
  fullname: 'Engy Administrator',
  role: 'admin',
  enabled: true,
  lastLoginAt: new Date('2026-08-01T09:00:00Z').toISOString(),
};

const authValue = {
  user: ADMIN,
  booting: false,
  status: { registrationOpen: true, needsBootstrap: false },
  login: async () => ADMIN,
  register: async () => ADMIN,
  logout: async () => {},
  updateProfile: async () => ADMIN,
  changePassword: async () => {},
  refreshStatus: async () => {},
  isAdmin: true,
  canWrite: true,
};

const PAGES = [
  ['DashboardPage', '/src/pages/DashboardPage.jsx', '/'],
  ['InboxPage', '/src/pages/InboxPage.jsx', '/inbox'],
  ['VerificationPage', '/src/pages/VerificationPage.jsx', '/verification'],
  ['InsightsPage', '/src/pages/InsightsPage.jsx', '/insights'],
  ['SchedulePage', '/src/pages/SchedulePage.jsx', '/schedule'],
  ['SkillsPage', '/src/pages/SkillsPage.jsx', '/skills'],
  ['ClientPage', '/src/pages/ClientPage.jsx', '/clients/650000000000000000000009'],
  /* The same client read as a programme. Renders with no history and must not throw for it. */
  ['ProgrammePage', '/src/pages/ProgrammePage.jsx', '/clients/650000000000000000000009/programme'],
  ['EngagementsPage', '/src/pages/EngagementsPage.jsx', '/engagements'],
  ['EngagementEditorPage', '/src/pages/EngagementEditorPage.jsx', '/engagements/650000000000000000000009'],
  /* The enumeration workbench, which renders with no engagement loaded and must not throw for it. */
  [
    'EnumerationPage',
    '/src/pages/EnumerationPage.jsx',
    '/engagements/650000000000000000000009/enumeration',
  ],
  /* Yours alone, and the one page in the app that holds nothing belonging to the firm. */
  ['ScratchpadPage', '/src/pages/ScratchpadPage.jsx', '/scratchpad'],
  /* Presence, aggregated. Renders with nobody online and must not throw for it. */
  ['FloorPage', '/src/pages/FloorPage.jsx', '/now'],
  ['LibraryPage', '/src/pages/LibraryPage.jsx', '/library'],
  ['ChecklistsPage', '/src/pages/ChecklistsPage.jsx', '/checklists'],
  ['TemplatesPage', '/src/pages/TemplatesPage.jsx', '/templates'],
  ['DataPage', '/src/pages/DataPage.jsx', '/data'],
  ['TemplatePlaygroundPage', '/src/pages/TemplatePlaygroundPage.jsx', '/templates/x/playground'],
  /*
   * The Sales section, which was missing from this list entirely.
   *
   * Every page in it has been built and changed since — the pipeline, the client book, the
   * invoicing list, the dashboard's six cards — and none of them was covered by the one check that
   * catches a page which cannot render at all. A section walled off from the rest of the app is
   * exactly the one nobody opens by accident, so a crash in it survives longest.
   */
  ['SalesPage', '/src/pages/SalesPage.jsx', '/sales'],
  ['SalesProposalsPage', '/src/pages/SalesProposalsPage.jsx', '/sales/proposals'],
  ['SalesClientsPage', '/src/pages/SalesClientsPage.jsx', '/sales/clients'],
  ['SalesInvoicingPage', '/src/pages/SalesInvoicingPage.jsx', '/sales/invoicing'],
  ['SalesActivityPage', '/src/pages/SalesActivityPage.jsx', '/sales/activity'],
  ['ProposalsPage', '/src/pages/ProposalsPage.jsx', '/proposals'],
  ['UsersPage', '/src/pages/UsersPage.jsx', '/users'],
  ['TeamPage', '/src/pages/TeamPage.jsx', '/team'],
  ['SettingsPage', '/src/pages/SettingsPage.jsx', '/settings'],
  ['ProfilePage', '/src/pages/ProfilePage.jsx', '/profile'],
  ['NotFoundPage', '/src/pages/NotFoundPage.jsx', '/nope'],
];

/* The client's link: no session, no shell, and it must not throw on a token that is not valid. */
const PUBLIC_PAGES = [
  ['SharedFindingsPage', '/src/pages/SharedFindingsPage.jsx', '/shared/not-a-real-token'],
];

const AUTH_PAGES = [
  ['LoginPage', '/src/pages/AuthPage.jsx', 'LoginPage'],
  ['RegisterPage', '/src/pages/AuthPage.jsx', 'RegisterPage'],
];

const SHELL = [['AppShell', '/src/components/layout/AppShell.jsx', '/']];

let failures = 0;
let passes = 0;

// Anything reaching the network during render would be a bug; make it loud.
globalThis.fetch = async (url) => {
  throw new Error(`unexpected fetch during render: ${url}`);
};

function attempt(label, fn) {
  try {
    const html = fn();
    const length = html?.length ?? 0;
    if (length < 20) {
      failures += 1;
      console.log(`  FAIL  ${label} — rendered almost nothing (${length} chars)`);
    } else {
      passes += 1;
      console.log(`  PASS  ${label} (${length} chars)`);
    }
  } catch (error) {
    failures += 1;
    const first = String(error.stack ?? error.message).split('\n').slice(0, 3).join('\n         ');
    console.log(`  FAIL  ${label}\n         ${first}`);
  }
}

const wrap = (path, element) =>
  React.createElement(
    ToastProvider,
    null,
    React.createElement(
      AuthContext.Provider,
      { value: authValue },
      React.createElement(
        MemoryRouter,
        { initialEntries: [path] },
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: '*', element })
        )
      )
    )
  );

console.log('Authenticated pages (empty data, no network):');
for (const [name, modulePath, route] of PAGES) {
  const mod = await load(modulePath);
  const Component = mod.default;
  attempt(name, () => renderToString(wrap(route, React.createElement(Component))));
}

console.log('\nPublic pages:');
for (const [name, modulePath, route] of PUBLIC_PAGES) {
  const mod = await load(modulePath);
  const Component = mod.default;
  attempt(name, () => renderToString(wrap(route, React.createElement(Component))));
}

console.log('\nAuth screens:');
for (const [name, modulePath, exportName] of AUTH_PAGES) {
  const mod = await load(modulePath);
  const Component = mod[exportName];
  attempt(name, () =>
    renderToString(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(
          AuthContext.Provider,
          { value: { ...authValue, user: null } },
          React.createElement(
            MemoryRouter,
            { initialEntries: ['/login'] },
            React.createElement(Component)
          )
        )
      )
    )
  );
}

console.log('\nLayout:');
for (const [name, modulePath, route] of SHELL) {
  const mod = await load(modulePath);
  const Component = mod.default ?? mod.AppShell;
  attempt(name, () => renderToString(wrap(route, React.createElement(Component))));
}

console.log('\nRich text editor (needs a DOM, expected to fall back to its placeholder):');
{
  const mod = await load('/src/components/editor/RichTextEditor.jsx');
  const Editor = mod.RichTextEditor;
  attempt('RichTextEditor', () =>
    renderToString(
      React.createElement(
        ToastProvider,
        null,
        React.createElement(Editor, { value: '<p>hello</p>', onChange: () => {} })
      )
    )
  );
}

console.log('\nCVSS editor:');
{
  const mod = await load('/src/components/cvss/CvssEditor.jsx');
  attempt('CvssEditor', () =>
    renderToString(
      React.createElement(mod.CvssEditor, {
        value: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
        onChange: () => {},
      })
    )
  );
  attempt('SeverityBar + legend', () =>
    renderToString(
      React.createElement(
        'div',
        null,
        React.createElement(mod.SeverityBar, { counts: { critical: 1, high: 2, medium: 3 } }),
        React.createElement(mod.SeverityLegend, { counts: { critical: 1, high: 2, medium: 3 } })
      )
    )
  );
}

/* ------------------------------- the engagement tabs, with data in them ---- */
/*
 * The pages above render with *no* data, which is the point of them — a page that throws on an
 * empty state throws on a slow network. It is also their blind spot: a tab that only mounts once
 * an engagement has loaded is never mounted at all, so a crash inside one is invisible here.
 *
 * That is not hypothetical. A dependency array reading a `const` declared further down the
 * component threw "Cannot access 'findings' before initialization" on every mount of the Findings
 * tab, and passed the build, the linter and this file, because nothing here had ever rendered it
 * with an engagement.
 *
 * So: one representative engagement, shaped exactly as the API now sends one — findings without
 * their prose, a snippet and the `has*` flags instead — through every tab that takes it.
 */
const ENGAGEMENT = {
  _id: '650000000000000000000009',
  name: 'Smoke Engagement',
  reference: 'PT-2026-001',
  auditType: 'Web Application Penetration Test',
  state: 'EDIT',
  language: 'en',
  sortFindings: true,
  enumerationCount: 2,
  phishingCount: 0,
  date: '2026-03-01',
  date_start: '2026-02-24',
  date_end: '2026-03-01',
  company: { _id: '650000000000000000000008', name: 'Northwind' },
  creator: ADMIN,
  /*
   * A second person on the engagement, deliberately. Half a dozen controls appear only when
   * there is somebody to hand work to — whose finding this is, whose check that is, the split
   * control on a checklist — so an engagement with a team of one left all of them unrendered.
   */
  collaborators: [
    {
      _id: '650000000000000000000002',
      username: 'bram',
      firstname: 'Bram',
      lastname: 'Tester',
      fullname: 'Bram Tester',
    },
  ],
  customFields: [],
  scope: [],
  sections: [{ _id: '1', field: 'executive_summary', name: 'Executive summary', text: '<p>Hi.</p>' }],
  notes: [{ _id: '2', title: 'A note', snippet: 'Something', searchText: 'Something', hasContent: true }],
  testChecks: [],
  handovers: [],
  questions: [],
  findings: [
    {
      _id: '650000000000000000000101',
      identifier: 'VULN-01',
      title: 'SQL injection in the reporting endpoint',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
      remediationStatus: 'open',
      /*
       * A claim nobody has checked, which is the state the Retest tab exists for. Without it the
       * tab renders its empty case and the check proves only that the file parses.
       */
      clientClaim: { status: 'fixed', at: '2026-03-02T09:00:00.000Z', by: 'Dana at Northwind' },
      statusHistory: [
        { status: 'open', at: '2026-03-01T10:00:00.000Z', by: { firstname: 'Engy', lastname: 'Administrator' } },
      ],
      references: [],
      snippet: 'The id parameter is concatenated into the query.',
      searchText: 'The id parameter is concatenated into the query.',
      hasDescription: true,
      hasObservation: false,
      hasRemediation: false,
      hasPoc: true,
      evidenceCount: 1,
      updatedAt: '2026-03-01T10:00:00.000Z',
    },
  ],
};

const TABS = [
  ['FindingsTab', '/src/components/engagement/FindingsTab.jsx'],
  ['OverviewTab', '/src/components/engagement/OverviewTab.jsx'],
  ['SectionsTab', '/src/components/engagement/SectionsTab.jsx'],
  ['ScopeTab', '/src/components/engagement/ScopeTab.jsx'],
  ['NotesTab', '/src/components/engagement/NotesTab.jsx'],
  ['QuestionsTab', '/src/components/engagement/QuestionsTab.jsx'],
  ['EvidenceBin', '/src/components/engagement/EvidenceBin.jsx'],
  ['DeliveryTab', '/src/components/engagement/DeliveryTab.jsx'],
  ['TestChecksTab', '/src/components/engagement/TestChecksTab.jsx'],
  ['HandoverTab', '/src/components/engagement/HandoverTab.jsx'],
  ['RetestTab', '/src/components/engagement/RetestTab.jsx'],
];

console.log('\nEngagement tabs, with an engagement in them:');
for (const [name, modulePath] of TABS) {
  const mod = await load(modulePath);
  const Component = mod.default;
  attempt(name, () =>
    renderToString(
      wrap(
        '/engagements/650000000000000000000009',
        React.createElement(Component, {
          audit: ENGAGEMENT,
          auditId: ENGAGEMENT._id,
          editable: true,
          onReload: () => {},
          onPatch: () => {},
          onOpenFinding: () => {},
        })
      )
    )
  );
}

/*
 * The assistant's two promises, asserted rather than described.
 *
 * An instance with no assistant is the default and the common case, and what it must look like is
 * "as though the feature does not exist" — not a disabled button, not a tooltip explaining what
 * could be bought. Server rendering has no browser and answers no requests, which is exactly the
 * state of an instance that has not configured one, so the assertion is simply: it renders nothing.
 */
console.log('\nThe assistant, on an instance that has none:');
{
  const { default: AssistantAction } = await load('/src/components/assistant/AssistantAction.jsx');
  /* Bare, with no wrapper of its own to measure: the assertion is that it emits nothing. */
  const html = renderToString(
    React.createElement(AssistantAction, {
      job: 'summary',
      label: 'Draft it',
      request: async () => ({}),
      preview: () => null,
    })
  );
  if (html === '') {
    passes += 1;
    console.log('  PASS  AssistantAction renders nothing at all, rather than a disabled button');
  } else {
    failures += 1;
    console.log(`  FAIL  AssistantAction rendered ${html.length} chars with no assistant configured`);
  }

  const { default: AssistantCard } = await load('/src/components/settings/AssistantCard.jsx');
  attempt('AssistantCard (unconfigured)', () =>
    renderToString(
      wrap(
        '/settings',
        React.createElement(AssistantCard, {
          value: { enabled: false, provider: 'anthropic', wire: 'anthropic', jobs: {} },
          meta: { vaultAvailable: false, hasKey: false, keyFromEnvironment: false },
          onChange: () => {},
        })
      )
    )
  );
  attempt('AssistantCard (configured, key from the environment)', () =>
    renderToString(
      wrap(
        '/settings',
        React.createElement(AssistantCard, {
          value: {
            enabled: true,
            provider: 'ollama',
            wire: 'openai',
            endpoint: 'http://127.0.0.1:11434/v1',
            model: 'a-local-model',
            timeoutSeconds: 120,
            houseStyle: 'Third person throughout.',
            jobs: { summary: true, rewrite: false, enumeration: true, library: true },
            allowRestricted: true,
          },
          meta: { vaultAvailable: true, hasKey: true, keyFromEnvironment: true },
          onChange: () => {},
        })
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* The picker behind a slash command, which is nothing until it is opened      */
/* -------------------------------------------------------------------------- */

/*
 * `Modal` goes through `createPortal`, which has nowhere to go on a server, so an *open* dialog
 * cannot be rendered here — what is inside it is checked by the pure tests over `scope-hosts.js`
 * instead. What this catches is the other half, and the half that actually breaks: a module that
 * will not load, an import that moved, an export that was renamed. This one is reached only from
 * the slash menu, so a broken import in it would surface as a dead command in the app and as
 * nothing at all in a build that still succeeds.
 */
console.log('\nThe scope picker, before anybody opens it:');
{
  const { default: ScopeHostPicker } = await load('/src/components/editor/ScopeHostPicker.jsx');
  /* No wrapper: this one needs no router and no toasts, and the toast container is markup. */
  const html = renderToString(
    React.createElement(ScopeHostPicker, {
      open: false,
      scope: [
        {
          name: 'Production',
          hosts: [
            {
              hostname: 'api.acme.example',
              ip: '203.0.113.10',
              services: [{ port: 443, protocol: 'tcp' }],
            },
          ],
        },
      ],
      onClose: () => {},
      onInsert: () => {},
    })
  );
  if (html === '') {
    passes += 1;
    console.log('  PASS  ScopeHostPicker renders nothing until it is opened');
  } else {
    failures += 1;
    console.log(`  FAIL  ScopeHostPicker rendered ${html.length} chars while closed`);
  }
}

/**
 * Which key holds the signed-in account's id.
 *
 * `toPublic()` sends `id`. It has never sent `_id`, so `String(user?._id ?? '')` is the empty
 * string, and every comparison against it says *no* — which reads as a feature that does nothing
 * rather than as an error. It cost the shared fields their self-filter, so a field you were alone
 * in announced that it was shared with you; and the findings list its "just mine" filter, which
 * quietly matched nothing.
 *
 * A source scan rather than a rendered assertion, because the defect is a *name*: no amount of
 * rendering catches reading the wrong key off an object that has neither of them under test. The
 * pattern the whole app uses is `user?.id ?? user?._id`, which is right whichever shape arrives, so
 * that is what this insists on. `entry.user._id` and the like are a different object and are left
 * alone — hence the "not preceded by a dot" part.
 */
console.log('\nWhose account is this:');
{
  const { readdirSync, readFileSync, statSync } = await import('node:fs');
  const walk = (dir) =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  const offenders = [];
  for (const file of walk(path.join(root, 'src')).filter((name) => /\.jsx?$/.test(name))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, index) => {
        if (!/(^|[^.\w])user\??\._id/.test(line)) return;
        /* The established idiom, which reaches both shapes. */
        if (/user\??\.id\s*\?\?/.test(line)) return;
        offenders.push(`${path.relative(root, file)}:${index + 1}`);
      });
  }

  if (offenders.length === 0) {
    passes += 1;
    console.log('  PASS  nothing reads the signed-in account as `_id` without falling back to `id`');
  } else {
    failures += 1;
    console.log(`  FAIL  ${offenders.length} place(s) read the account as \`_id\`: ${offenders.join(', ')}`);
  }
}

/**
 * A button keeps its own width.
 *
 * "Post a test message" arrived on screen wrapped onto two lines inside a box narrower than its own
 * words, because a button in a flex row beside a paragraph is a shrinkable item and text can break.
 * Both halves of the fix are asserted, because either one alone leaves it broken: without
 * `whitespace-nowrap` the label breaks, and without `shrink-0` the box shrinks and clips it instead.
 */
console.log('\nButtons:');
{
  const { Button } = await load('/src/components/ui/Button.jsx');
  const html = renderToString(
    React.createElement(Button, { variant: 'secondary', size: 'sm' }, 'Post a test message')
  );

  for (const rule of ['whitespace-nowrap', 'shrink-0']) {
    if (html.includes(rule)) {
      passes += 1;
      console.log(`  PASS  a button carries ${rule}, so its label cannot be squeezed`);
    } else {
      failures += 1;
      console.log(`  FAIL  a button is missing ${rule} — a long label will wrap inside it`);
    }
  }
}

/**
 * The settings form is built the same way twice.
 *
 * ⌘S on that page works by comparing the form against what it was seeded as, so `formFor` has to be
 * a pure function of what the server sent. Anything in it that varies on its own — a `Date.now()`, a
 * random id — would make the page permanently look unsaved: the warning before leaving would never
 * go away and the shortcut would save on every keystroke.
 */
console.log('\nThe settings form:');
{
  const { formFor } = await load('/src/pages/SettingsPage.jsx');
  const sent = {
    branding: { appName: 'Acme Security' },
    email: { enabled: true, host: 'smtp.example', hasPassword: true },
    webhooks: { enabled: true, provider: 'discord', hasUrl: true, urlHost: 'discord.com' },
    pdf: { converter: 'libreoffice' },
  };

  const once = JSON.stringify(formFor(sent));
  const twice = JSON.stringify(formFor(sent));
  if (once === twice) {
    passes += 1;
    console.log('  PASS  seeding the same settings twice gives the same form');
  } else {
    failures += 1;
    console.log('  FAIL  the form is not a pure function of the settings — ⌘S would think it is always dirty');
  }

  /*
   * And the write-only credentials start blank, which is what makes "no change" the honest answer
   * for a page nobody has touched — an empty one means "leave what is stored alone".
   */
  const seeded = formFor(sent);
  if (seeded.webhooks?.url === '' && seeded.webhooks?.signingSecret === '') {
    passes += 1;
    console.log('  PASS  and the webhook credentials are blank rather than echoed back');
  } else {
    failures += 1;
    console.log(`  FAIL  the webhook credentials seeded as ${JSON.stringify(seeded.webhooks?.url)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Components that were never imported                                        */
/* -------------------------------------------------------------------------- */
console.log('\nEvery component a file renders is one it can see:');
{
  /*
   * The bug this exists for: `<Toggle>` used in a file whose import line lists Input, Select and
   * Textarea. The build is perfectly happy — an unknown capitalised name in JSX is just a variable
   * reference — and React throws at render time, on one tab, in front of somebody.
   *
   * Deliberately not a parser. The failure is never subtle: it is a missing line at the top of the
   * file. So this collects what each file renders, collects what it can see, and subtracts.
   */
  const roots = [
    'src/components',
    'src/pages',
  ];

  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name.endsWith('.jsx')) files.push(at);
    }
  };
  for (const folder of roots) {
    const at = path.resolve(root, folder);
    if (fs.existsSync(at)) walk(at);
  }

  /*
   * Names that are always available, or are not components at all.
   *
   * `Fragment` and the dotted forms (`Card.Body`) resolve through something already imported, and
   * a capitalised word in a comment or a string is not a render — the element pattern below only
   * matches an actual opening tag, so those never arrive here.
   */
  const ALWAYS = new Set(['Fragment', 'React', 'Suspense', 'StrictMode', 'Profiler']);

  const offenders = [];
  for (const at of files) {
    const text = fs.readFileSync(at, 'utf8');

    /* What it renders: `<Name` where Name starts with a capital and is not dotted. */
    const rendered = new Set(
      [...text.matchAll(/<([A-Z][A-Za-z0-9]*)(?=[\s/>])/g)].map((match) => match[1])
    );

    /*
     * What it can see: anything imported, declared, or destructured at the top level. One regex
     * per shape, and all of them deliberately generous — a false accusation here would be worse
     * than a miss, because it would be a failing test nobody trusts.
     */
    const visible = new Set(ALWAYS);
    for (const match of text.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]/g)) {
      for (const name of match[1].replace(/[{}]/g, ' ').split(/[\s,]+/)) {
        const clean = name.replace(/^\*\s*as\s*/, '').trim();
        if (clean) visible.add(clean.split(/\s+as\s+/).pop());
      }
    }
    for (const match of text.matchAll(/(?:function|const|let|class)\s+([A-Z][A-Za-z0-9]*)/g)) {
      visible.add(match[1]);
    }
    /*
     * Renames, which is how every polymorphic component in this tree gets its tag:
     * `{ icon: Icon }`, `{ as: Tag = 'button' }`, `{ component: Component }`. Missing this made
     * the check accuse eleven correct files, which is the failure mode that matters most here —
     * a test that cries wolf is one the next person assumes is wrong again.
     */
    for (const match of text.matchAll(/\b\w+\s*:\s*([A-Z][A-Za-z0-9]*)/g)) {
      visible.add(match[1]);
    }
    /* `const { Body } = Card` and `const X = something` inside the file. */
    for (const match of text.matchAll(/(?:const|let)\s*\{([^}]*)\}/g)) {
      for (const name of match[1].split(/[\s,:]+/)) if (name) visible.add(name.trim());
    }

    for (const name of rendered) {
      if (!visible.has(name)) {
        offenders.push(`${path.relative(root, at).replace(/\\/g, '/')} renders <${name}>`);
      }
    }
  }

  if (offenders.length === 0) {
    passes += 1;
    console.log(`  PASS  all ${files.length} components render only what they import`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${offenders.length} undefined component(s): ${offenders.join('; ')}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Calls into the API client that the API client cannot answer                */
/* -------------------------------------------------------------------------- */
console.log('\nEvery call into the API client names a method it has:');
{
  /*
   * The bug this exists for: `api.delete(...)`, which reads perfectly and does not exist. The
   * client exposes `del`, because `delete` is a reserved word and calling the property that
   * anyway was a step further than this codebase wanted to go. So `api.delete` is `undefined`,
   * the build says nothing, and the operator gets "(intermediate value).delete is not a function"
   * the first time they try to remove a row — an error message that does not even name the method.
   *
   * The render smoke could not catch it either: it lives in a click handler, and nothing renders a
   * click. Hence a static check, and the method names read out of the client rather than typed
   * here, so adding one to the client does not make this fail.
   */
  const clientPath = path.resolve(root, 'src/lib/api.js');
  const clientText = fs.readFileSync(clientPath, 'utf8');
  const literal = clientText.match(/export const api = \{([\s\S]*?)\n\};/);

  if (!literal) {
    failures += 1;
    console.log('  FAIL  could not find the `export const api = {...}` literal in src/lib/api.js');
  } else {
    const methods = new Set(
      [...literal[1].matchAll(/^\s*([a-zA-Z_$][\w$]*)\s*:/gm)].map((match) => match[1])
    );

    /*
     * Only files that actually import the client, so a hostname in a string — `api.acme.com` —
     * cannot be mistaken for a call. The call pattern requires a bracket after the name, which
     * rules those out on its own; this is the belt to that pair of braces.
     */
    const callers = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const at = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(at);
        else if (/\.jsx?$/.test(entry.name) && at !== clientPath) callers.push(at);
      }
    };
    walk(path.resolve(root, 'src'));

    const offenders = [];
    for (const at of callers) {
      const text = fs.readFileSync(at, 'utf8');
      if (!/from\s+['"][^'"]*lib\/api\.js['"]/.test(text)) continue;
      for (const match of text.matchAll(/\bapi\.([a-zA-Z_$][\w$]*)\s*\(/g)) {
        if (!methods.has(match[1])) {
          const line = text.slice(0, match.index).split('\n').length;
          offenders.push(
            `${path.relative(root, at).replace(/\\/g, '/')}:${line} calls api.${match[1]}()`
          );
        }
      }
    }

    if (offenders.length === 0) {
      passes += 1;
      console.log(
        `  PASS  every api.x() call names one of: ${[...methods].sort().join(', ')}`
      );
    } else {
      failures += 1;
      console.log(`  FAIL  ${offenders.length} call(s) the client cannot answer: ${offenders.join('; ')}`);
    }
  }
}

console.log('\nNo element is handed the same prop twice:');
{
  /*
   * The bug this exists for: `<PageHeader>` on the client page was given `actions` twice, ten
   * lines apart. JSX keeps the last one, so the first — the button to the whole cross-engagement
   * programme view — never rendered. Nothing warned, because nothing can: a duplicated prop is
   * legal JavaScript, the build is happy, and the page looks finished. It is only wrong if you
   * know the button is supposed to be there.
   *
   * Deliberately crude. It reads elements written in this codebase's own shape — an open tag on
   * its own line, props one indent in — rather than parsing JSX properly, because it does not
   * have to be right about arbitrary input, only about the code in this folder. A shape it does
   * not recognise is skipped, which is the safe direction: this finds duplicates or it finds
   * nothing, and it never invents one.
   */
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const at = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (/\.jsx$/.test(entry.name)) files.push(at);
    }
  };
  walk(path.resolve(root, 'src'));

  const duplicates = [];
  for (const at of files) {
    const lines = fs.readFileSync(at, 'utf8').split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const open = /^(\s*)<([A-Za-z][\w.]*)\s*$/.exec(lines[index]);
      if (!open) continue;
      const indent = open[1].length;
      const seen = new Map();

      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const line = lines[cursor];
        const at_ = line.search(/\S/);
        /* The element's own closing `>` or `/>`, back at its indentation, ends it. */
        if (at_ <= indent && /^\s*\/?>\s*$/.test(line)) break;
        if (at_ <= indent && line.trim()) break;
        /* A prop of *this* element is a `name={` or `name="` exactly one indent in. Anything
           deeper belongs to something nested and is none of this check's business. */
        const prop = /^\s*([a-zA-Z][\w]*)=[{"]/.exec(line);
        if (prop && at_ === indent + 2) {
          seen.set(prop[1], (seen.get(prop[1]) ?? 0) + 1);
        }
      }

      for (const [name, count] of seen) {
        if (count > 1) {
          duplicates.push(
            `${path.relative(root, at).replace(/\\/g, '/')}:${index + 1} <${open[2]}> passes "${name}" ${count} times`
          );
        }
      }
    }
  }

  if (duplicates.length === 0) {
    passes += 1;
    console.log(`  PASS  ${files.length} components, no element given a prop twice`);
  } else {
    failures += 1;
    console.log(`  FAIL  the earlier one is silently discarded: ${duplicates.join('; ')}`);
  }
}

await vite.close();
console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
