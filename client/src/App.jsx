import { Suspense, lazy } from 'react';
import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './context/AuthContext.jsx';
import { PresenceProvider } from './context/PresenceContext.jsx';
import { CapabilitiesProvider } from './context/CapabilitiesContext.jsx';
import { NotificationsProvider } from './context/NotificationsContext.jsx';
import { BootScreen, LoadingBlock } from './components/ui/Feedback.jsx';
import { AppShell } from './components/layout/AppShell.jsx';

/*
 * The sign-in screens are the only pages loaded eagerly.
 *
 * Everything in this file used to be a static import, which meant one chunk of 1.81 MB — and the
 * first thing it was asked to do was draw a password box. Somebody signing in downloaded the
 * collaborative editor, ProseMirror, Yjs, the CVSS calculator and the chart renderer before they
 * could type. The build had been saying so, in yellow, on every single run.
 *
 * So every page below is a dynamic import, and the shape of the app decides what arrives: the
 * login screen is the login screen, the dashboard is the dashboard, and the editor's dependencies
 * are fetched by the person who opens the editor. Rollup hoists what several pages share into
 * chunks of its own, so a shared dependency is still downloaded once.
 *
 * Auth stays eager because it is the first paint for anybody who is not already signed in, and a
 * spinner in front of a password box to save bytes nobody has yet spent is a bad trade.
 */
import { LoginPage, RegisterPage } from './pages/AuthPage.jsx';

/*
 * `lazy` needs a module with a default export, which every page here has except AuthPage — hence
 * its static import above, and hence no `.then(m => m.Named)` unwrapping anywhere below.
 */
const SetPasswordPage = lazy(() => import('./pages/SetPasswordPage.jsx'));
const SharedFindingsPage = lazy(() => import('./pages/SharedFindingsPage.jsx'));
const IntakePage = lazy(() => import('./pages/IntakePage.jsx'));

const DashboardPage = lazy(() => import('./pages/DashboardPage.jsx'));
const InboxPage = lazy(() => import('./pages/InboxPage.jsx'));
const InsightsPage = lazy(() => import('./pages/InsightsPage.jsx'));
const SchedulePage = lazy(() => import('./pages/SchedulePage.jsx'));
const SkillsPage = lazy(() => import('./pages/SkillsPage.jsx'));
const ClientPage = lazy(() => import('./pages/ClientPage.jsx'));
const ProgrammePage = lazy(() => import('./pages/ProgrammePage.jsx'));
const ChecklistsPage = lazy(() => import('./pages/ChecklistsPage.jsx'));
const EngagementsPage = lazy(() => import('./pages/EngagementsPage.jsx'));
const DeliverablesPage = lazy(() => import('./pages/DeliverablesPage.jsx'));
const ArchivePage = lazy(() => import('./pages/ArchivePage.jsx'));
const EngagementEditorPage = lazy(() => import('./pages/EngagementEditorPage.jsx'));
const EnumerationPage = lazy(() => import('./pages/EnumerationPage.jsx'));
const ScratchpadPage = lazy(() => import('./pages/ScratchpadPage.jsx'));
const FloorPage = lazy(() => import('./pages/FloorPage.jsx'));
const LibraryPage = lazy(() => import('./pages/LibraryPage.jsx'));
const TemplatesPage = lazy(() => import('./pages/TemplatesPage.jsx'));
const HtmlTemplateEditorPage = lazy(() => import('./pages/HtmlTemplateEditorPage.jsx'));
const TemplatePlaygroundPage = lazy(() => import('./pages/TemplatePlaygroundPage.jsx'));
const ReportPrintPage = lazy(() => import('./pages/ReportPrintPage.jsx'));
const DataPage = lazy(() => import('./pages/DataPage.jsx'));
const UsersPage = lazy(() => import('./pages/UsersPage.jsx'));
const TeamPage = lazy(() => import('./pages/TeamPage.jsx'));
const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));
const SalesPage = lazy(() => import('./pages/SalesPage.jsx'));
const SalesClientsPage = lazy(() => import('./pages/SalesClientsPage.jsx'));
const SalesProposalsPage = lazy(() => import('./pages/SalesProposalsPage.jsx'));
const SalesInvoicingPage = lazy(() => import('./pages/SalesInvoicingPage.jsx'));
const ProposalsPage = lazy(() => import('./pages/ProposalsPage.jsx'));
const SalesActivityPage = lazy(() => import('./pages/SalesActivityPage.jsx'));
const ProfilePage = lazy(() => import('./pages/ProfilePage.jsx'));
const NotFoundPage = lazy(() => import('./pages/NotFoundPage.jsx'));

/** Blocks a route until a session exists, remembering where the user was headed. */
function RequireAuth({ children }) {
  const { user, booting } = useAuth();
  const location = useLocation();

  if (booting) return <BootScreen />;
  if (!user) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return children;
}

function RequireAdmin({ children }) {
  const { isAdmin } = useAuth();
  return isAdmin ? children : <Navigate to="/" replace />;
}

/**
 * The Sales section: sales accounts, and admins.
 *
 * Admins are in because an admin who cannot open the section cannot tell whether it works,
 * and on this instance keeping them out would be a pretence — whoever administers the app
 * can grant themselves the role, or read the database. The API agrees with this; see
 * sales.routes.js.
 */
function RequireSales({ children }) {
  const { isAdmin, isSales } = useAuth();
  return isAdmin || isSales ? children : <Navigate to="/" replace />;
}

/**
 * Everything that is about the work, which a sales account has no access to.
 *
 * A layout route around the existing pages rather than a guard repeated on each of the
 * twenty: one rule, and a page added tomorrow inherits it instead of being forgotten. The
 * API refuses these accounts anyway — this exists so they meet a section they can use
 * rather than a screen of failed requests.
 */
function WorkOnly() {
  const { isSales } = useAuth();
  return isSales ? <Navigate to="/sales" replace /> : <Outlet />;
}

/** Keeps signed-in users off the login and register screens. */
function RedirectIfAuthenticated({ children }) {
  const { user, booting } = useAuth();
  if (booting) return <BootScreen />;
  return user ? <Navigate to="/" replace /> : children;
}

/**
 * What a page's chunk arriving looks like.
 *
 * Deliberately the same `LoadingBlock` a page shows while its own data loads, rather than a
 * distinct "loading the application" screen: on a normal connection the chunk is there in
 * milliseconds and is followed immediately by the page's own fetch, so two different spinners in
 * sequence would read as two separate waits for one navigation.
 *
 * Used inside the shell — see `AppShell` — so the sidebar and header stay put while the content
 * area waits. A boundary above the shell would blank the whole frame on every navigation, which
 * would make a fast app feel slower than the one large chunk did.
 */
const PageFallback = <LoadingBlock className="py-16" />;

export default function App() {
  return (
    <Routes>
      <Route
        path="/login"
        element={
          <RedirectIfAuthenticated>
            <LoginPage />
          </RedirectIfAuthenticated>
        }
      />
      <Route
        path="/register"
        element={
          <RedirectIfAuthenticated>
            <RegisterPage />
          </RedirectIfAuthenticated>
        }
      />

      {/*
        Setting a password from a one-time link.

        Not wrapped in `RedirectIfAuthenticated`: somebody already signed in on this browser may
        legitimately be opening a link for a *different* account — a colleague's laptop, a shared
        machine — and bouncing them to the dashboard would make the link look broken.
      */}
      <Route
        path="/set-password/:token"
        element={
          <Suspense fallback={PageFallback}>
            <SetPasswordPage />
          </Suspense>
        }
      />

      {/*
        The client's own view of their findings. Outside the shell and outside the gate: whoever
        opens it has no account, and every other route in this app assumes one.

        Its own Suspense rather than the shell's, for the same reason — there is no shell here.
      */}
      <Route
        path="/shared/:token"
        element={
          <Suspense fallback={PageFallback}>
            <SharedFindingsPage />
          </Suspense>
        }
      />
      {/* Public, behind a token, and outside every guard: the person filling it in has no
          account and never will. */}
      <Route
        path="/intake/:token"
        element={
          <Suspense fallback={PageFallback}>
            <IntakePage />
          </Suspense>
        }
      />

      {/* Presence only exists behind the auth gate — the sign-in screens have
          nobody to report as online. */}
      <Route
        element={
          <RequireAuth>
            <CapabilitiesProvider>
              <PresenceProvider>
                <NotificationsProvider>
                  <AppShell />
                </NotificationsProvider>
              </PresenceProvider>
            </CapabilitiesProvider>
          </RequireAuth>
        }
      >
        <Route element={<WorkOnly />}>
          <Route index element={<DashboardPage />} />
          <Route path="inbox" element={<InboxPage />} />
          <Route path="insights" element={<InsightsPage />} />
          <Route path="schedule" element={<SchedulePage />} />
          <Route path="skills" element={<SkillsPage />} />
          <Route path="clients/:id" element={<ClientPage />} />
          {/* The same client read as a programme: what changed between engagements. */}
          <Route path="clients/:id/programme" element={<ProgrammePage />} />
          <Route path="engagements" element={<EngagementsPage />} />
          <Route path="deliverables" element={<DeliverablesPage />} />
          {/* Its own page rather than a filter, because it answers a different question. */}
          <Route path="archive" element={<ArchivePage />} />
          <Route path="engagements/:id" element={<EngagementEditorPage />} />
          {/* A finding is a thing people link to — in a ticket, in Slack, from the
              notification that told them they were mentioned in it. */}
          <Route path="engagements/:id/findings/:findingId" element={<EngagementEditorPage />} />
          {/*
            The enumeration workbench: the same component as the tab, in a room the right shape for a
            tree of sixty rows. A route of its own so it can be linked to and left open.
          */}
          <Route path="engagements/:id/enumeration" element={<EnumerationPage />} />
          {/* Yours alone, and belonging to no engagement — see the page for why. */}
          <Route path="scratchpad" element={<ScratchpadPage />} />
          {/* Presence, aggregated: who is where, and what nobody is looking at. */}
          <Route path="now" element={<FloorPage />} />
          <Route path="engagements/:id/print" element={<ReportPrintPage />} />
          <Route path="library" element={<LibraryPage />} />
          <Route path="checklists" element={<ChecklistsPage />} />
          <Route path="templates" element={<TemplatesPage />} />
          <Route path="templates/html/:id" element={<HtmlTemplateEditorPage />} />
          {/* Where a template is diagnosed: every placeholder in place, with what it resolves to. */}
          <Route path="templates/:id/playground" element={<TemplatePlaygroundPage />} />
          <Route path="data" element={<DataPage />} />
          {/* The work side of the pipeline: what needs an estimate or a contract checked, and
              what has been won and is not yet a job. */}
          <Route path="proposals" element={<ProposalsPage view="queue" />} />
          <Route path="inquiries" element={<ProposalsPage view="inquiries" />} />
        </Route>

        {/* Outside the wall: changing your own password is not work, and every role needs
            it. The page hides the parts a sales account has no use for. */}
        <Route path="profile" element={<ProfilePage />} />
        <Route
          path="sales"
          element={
            <RequireSales>
              <SalesPage />
            </RequireSales>
          }
        />
        <Route
          path="sales/proposals"
          element={
            <RequireSales>
              <SalesProposalsPage />
            </RequireSales>
          }
        />
        <Route
          path="sales/clients"
          element={
            <RequireSales>
              <SalesClientsPage />
            </RequireSales>
          }
        />
        {/* RequireSales rather than admin-only: raising the invoices is the selling side's job,
            and the endpoint behind it is on /proposals, which both audiences reach. */}
        <Route
          path="sales/invoicing"
          element={
            <RequireSales>
              <SalesInvoicingPage />
            </RequireSales>
          }
        />
        {/* The Sales log is a managerial view of who did what, so it is admin-only rather than
            RequireSales — the API agrees; see the route in sales.routes.js. */}
        <Route
          path="sales/activity"
          element={
            <RequireAdmin>
              <SalesActivityPage />
            </RequireAdmin>
          }
        />
        {/* This section was called Financial for one commit. A bookmark or an open tab from
            that window is worth a redirect rather than a 404. */}
        <Route path="finance" element={<Navigate to="/sales" replace />} />
        <Route
          path="team"
          element={
            <RequireAdmin>
              <TeamPage />
            </RequireAdmin>
          }
        />
        <Route
          path="users"
          element={
            <RequireAdmin>
              <UsersPage />
            </RequireAdmin>
          }
        />
        <Route
          path="settings"
          element={
            <RequireAdmin>
              <SettingsPage />
            </RequireAdmin>
          }
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
