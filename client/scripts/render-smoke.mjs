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
  ['EngagementsPage', '/src/pages/EngagementsPage.jsx', '/engagements'],
  ['EngagementEditorPage', '/src/pages/EngagementEditorPage.jsx', '/engagements/650000000000000000000009'],
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

await vite.close();
console.log(`\nRESULT: ${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
