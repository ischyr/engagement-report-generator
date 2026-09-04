/**
 * Renders every page component through Vite's SSR pipeline with a stubbed
 * session and no network. This exercises the loading/empty branches — where
 * crashes from undefined data usually hide — and surfaces bad hook usage,
 * undefined components and prop-type mistakes that bundling cannot detect.
 */
import { createServer } from 'vite';
import { renderToString } from 'react-dom/server';
import React from 'react';

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
  collaborators: [],
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

await vite.close();
console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
