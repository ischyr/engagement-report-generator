import { Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';

import { useAuth } from './context/AuthContext.jsx';
import { PresenceProvider } from './context/PresenceContext.jsx';
import { NotificationsProvider } from './context/NotificationsContext.jsx';
import { BootScreen } from './components/ui/Feedback.jsx';
import { AppShell } from './components/layout/AppShell.jsx';

import { LoginPage, RegisterPage } from './pages/AuthPage.jsx';
import SetPasswordPage from './pages/SetPasswordPage.jsx';
import DashboardPage from './pages/DashboardPage.jsx';
import InboxPage from './pages/InboxPage.jsx';
import InsightsPage from './pages/InsightsPage.jsx';
import SchedulePage from './pages/SchedulePage.jsx';
import SkillsPage from './pages/SkillsPage.jsx';
import ClientPage from './pages/ClientPage.jsx';
import ChecklistsPage from './pages/ChecklistsPage.jsx';
import EngagementsPage from './pages/EngagementsPage.jsx';
import DeliverablesPage from './pages/DeliverablesPage.jsx';
import ArchivePage from './pages/ArchivePage.jsx';
import IntakePage from './pages/IntakePage.jsx';
import EngagementEditorPage from './pages/EngagementEditorPage.jsx';
import LibraryPage from './pages/LibraryPage.jsx';
import TemplatesPage from './pages/TemplatesPage.jsx';
import HtmlTemplateEditorPage from './pages/HtmlTemplateEditorPage.jsx';
import TemplatePlaygroundPage from './pages/TemplatePlaygroundPage.jsx';
import ReportPrintPage from './pages/ReportPrintPage.jsx';
import DataPage from './pages/DataPage.jsx';
import UsersPage from './pages/UsersPage.jsx';
import TeamPage from './pages/TeamPage.jsx';
import SettingsPage from './pages/SettingsPage.jsx';
import SalesPage from './pages/SalesPage.jsx';
import SalesClientsPage from './pages/SalesClientsPage.jsx';
import SalesProposalsPage from './pages/SalesProposalsPage.jsx';
import SalesInvoicingPage from './pages/SalesInvoicingPage.jsx';
import ProposalsPage from './pages/ProposalsPage.jsx';
import SalesActivityPage from './pages/SalesActivityPage.jsx';
import ProfilePage from './pages/ProfilePage.jsx';
import NotFoundPage from './pages/NotFoundPage.jsx';

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
      <Route path="/set-password/:token" element={<SetPasswordPage />} />
      {/* Public, behind a token, and outside every guard: the person filling it in has no
          account and never will. */}
      <Route path="/intake/:token" element={<IntakePage />} />

      {/* Presence only exists behind the auth gate — the sign-in screens have
          nobody to report as online. */}
      <Route
        element={
          <RequireAuth>
            <PresenceProvider>
              <NotificationsProvider>
                <AppShell />
              </NotificationsProvider>
            </PresenceProvider>
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
          <Route path="engagements" element={<EngagementsPage />} />
          <Route path="deliverables" element={<DeliverablesPage />} />
          {/* Its own page rather than a filter, because it answers a different question. */}
          <Route path="archive" element={<ArchivePage />} />
          <Route path="engagements/:id" element={<EngagementEditorPage />} />
          {/* A finding is a thing people link to — in a ticket, in Slack, from the
              notification that told them they were mentioned in it. */}
          <Route path="engagements/:id/findings/:findingId" element={<EngagementEditorPage />} />
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
