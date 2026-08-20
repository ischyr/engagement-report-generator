import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  Banknote,
  Building2,
  CalendarDays,
  ChevronDown,
  ClipboardCheck,
  ClipboardList,
  FileSignature,
  FileText,
  Footprints,
  History,
  GraduationCap,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  PackageCheck,
  Receipt,
  ScrollText,
  Settings,
  ShieldAlert,
  Sliders,
  UserRound,
  TrendingUp,
  User,
  Users,
  X,
} from 'lucide-react';

import { useAuth, useBranding } from '../../context/AuthContext.jsx';
import { usePresence } from '../../context/PresenceContext.jsx';
import FollowBar, { routeForLocation } from './FollowBar.jsx';
import { useUnsaved } from '../../context/UnsavedContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, displayName } from '../../lib/utils.js';
import { Avatar } from '../ui/Misc.jsx';
import GlobalSearch from './GlobalSearch.jsx';
import NotificationsBar from './NotificationsBar.jsx';
import { Button } from '../ui/Button.jsx';

/** Kept in step with ROLE_LABELS on the server and the Users page. */
const ROLE_LABELS = {
  admin: 'Admin',
  manager: 'Manager',
  user: 'Consultant',
  readonly: 'Read only',
  sales: 'Sales',
};

const NAV = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard, end: true },
  // Second, because "what needs me" is the question people open the app with.
  { to: '/inbox', label: 'Inbox', icon: Inbox },
  { to: '/engagements', label: 'Engagements', icon: ScrollText },
  // After Engagements, and the same data read the other way round: not what is in this job,
  // but what has actually gone out.
  { to: '/deliverables', label: 'Deliverables', icon: PackageCheck },
  // Beside Engagements, because it answers a question about them: who is on what, when.
  { to: '/schedule', label: 'Schedule', icon: CalendarDays },
  // Next to the Schedule: who is free and who can do the work are the same question
  // asked twice.
  { to: '/skills', label: 'Skills', icon: GraduationCap },
  { to: '/insights', label: 'Insights', icon: TrendingUp },
  { to: '/library', label: 'Vulnerabilities', icon: ShieldAlert },
  /*
   * Beside Templates, because they are the same kind of thing: the libraries an engagement draws
   * from rather than anything belonging to one. A methodology here is what
   * `/audits/test-check-presets` offers in the engagement's Checks tab, the way a template here is
   * what the report generator offers — so whoever keeps one current keeps the other, and filing
   * this under Administration hid it from the testers who write them.
   *
   * Ahead of Templates rather than behind it: a methodology is chosen when the work is planned,
   * and the template only matters once there is something to report.
   */
  { to: '/checklists', label: 'Checklists', icon: ClipboardCheck },
  { to: '/templates', label: 'Templates', icon: FileText },
  { to: '/data', label: 'Clients & Data', icon: Building2 },
];

const ADMIN_NAV = [
  { to: '/users', label: 'Users', icon: Users },
  { to: '/team', label: 'Team', icon: UserRound },
  { to: '/settings', label: 'Settings', icon: Sliders },
];

/**
 * The commercial side of the work.
 *
 * Its own section rather than a page under Engagements, because its audience is different
 * from every other section's: a sales account sees this list and no other, so putting one
 * of its pages among the engagement pages would leave that person looking at a sidebar of
 * links that all answer 403.
 */
const SALES_NAV = [
  { to: '/sales', label: 'Dashboard', icon: Banknote, end: true },
  { to: '/sales/proposals', label: 'Proposals', icon: ScrollText },
  { to: '/sales/clients', label: 'Clients', icon: Building2 },
  { to: '/sales/invoicing', label: 'Invoicing', icon: Receipt },
];

/** Admins only. A log of who did what in this section, which is not a colleague's business. */
const SALES_LOG_NAV = { to: '/sales/activity', label: 'Sales activity', icon: History };

/**
 * Work on its way in, and not yet a job.
 *
 * Its own heading rather than two more entries in the flat list above, because they are a
 * different kind of thing: everything in that list is work you are doing, and these two are work
 * you have been asked to do and work you have won. Sitting them between Inbox and Engagements
 * read as though a proposal were another view of the same jobs, which is exactly what it is not.
 *
 * Shown to everybody who does the work — an estimate is asked of consultants, not only of leads.
 */
const INCOMING_NAV = [
  { to: '/proposals', label: 'Proposal queue', icon: FileSignature },
  { to: '/inquiries', label: 'Inquiries', icon: ClipboardList },
];

function Brand({ onNavigate }) {
  const { appName, tagline, logo } = useBranding();

  return (
    <Link
      to="/"
      onClick={onNavigate}
      className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-white/5"
    >
      {logo ? (
        <img
          src={logo}
          alt=""
          className="size-8 shrink-0 rounded-lg object-contain"
        />
      ) : (
        // The monogram is the fallback, taken from the name rather than hard-coded,
        // so an instance called something else does not show somebody else's initial.
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand-500 to-brand-700 text-sm font-bold text-white shadow-sm">
          {appName.trim().charAt(0).toUpperCase() || 'E'}
        </span>
      )}
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold leading-tight text-fg">{appName}</span>
        {tagline ? (
          <span className="block truncate text-[0.625rem] uppercase tracking-wider text-fg-subtle">
            {tagline}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function NavItem({ item, onNavigate }) {
  const navigate = useNavigate();
  const { guard } = useUnsaved();

  return (
    <NavLink
      to={item.to}
      end={item.end}
      // Leaving the page an editor is on is the commonest way to lose a draft, so the
      // click is intercepted and asked about rather than followed straight away.
      onClick={(event) => {
        event.preventDefault();
        guard(() => {
          navigate(item.to);
          onNavigate?.();
        });
      }}
      className={({ isActive }) =>
        cn(
          'group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors',
          isActive ? 'bg-brand-500/12 text-brand-300' : 'text-fg-muted hover:bg-white/5 hover:text-fg'
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              'absolute left-0 top-1/2 h-4.5 w-0.5 -translate-y-1/2 rounded-r bg-brand-400 transition-opacity',
              isActive ? 'opacity-100' : 'opacity-0'
            )}
          />
          <item.icon size={16} className="shrink-0" />
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

function UserMenu() {
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event) => {
      if (!ref.current?.contains(event.target)) setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition hover:bg-white/5"
      >
        <Avatar user={user} size={28} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-fg">{displayName(user)}</span>
          {/* Every role, in the words the Users page uses. The primary alone would hide that
              somebody is also a manager, which is the fact that decides what they can press. */}
          <span className="block truncate text-[0.625rem] text-fg-subtle">
            {(user?.roles?.length ? user.roles : [user?.role])
              .filter(Boolean)
              .map((role) => ROLE_LABELS[role] ?? role)
              .join(' · ')}
          </span>
        </span>
        <ChevronDown size={14} className={cn('shrink-0 text-fg-subtle transition', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-1.5 w-full min-w-48 overflow-hidden rounded-xl border border-line bg-overlay shadow-pop"
        >
          <Link
            to="/profile"
            role="menuitem"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 px-3 py-2.5 text-sm text-fg-muted transition hover:bg-white/5 hover:text-fg"
          >
            <User size={15} />
            Your profile
          </Link>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              logout();
            }}
            className="flex w-full items-center gap-2.5 border-t border-line-soft px-3 py-2.5 text-left text-sm text-fg-muted transition hover:bg-crit/10 hover:text-crit"
          >
            <LogOut size={15} />
            Sign out
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Who else is working right now, and on what. */
function OnlinePanel() {
  const { users, following, follow, unfollow } = usePresence();
  if (users.length === 0) return null;

  return (
    <div className="border-t border-line-soft pt-3">
      <p className="flex items-center gap-1.5 px-2.5 pb-2 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-low opacity-60" />
          <span className="relative inline-flex size-1.5 rounded-full bg-low" />
        </span>
        Online now
        <span className="ml-auto font-mono text-fg-muted">{users.length}</span>
      </p>

      <ul className="flex max-h-52 flex-col gap-0.5 overflow-y-auto">
        {users.map((person) => {
          /*
           * Only somebody who is actually somewhere. Offering to follow a person whose screen is not
           * on anything the app can navigate to is offering to do nothing.
           */
          const followable = !person.isSelf && Boolean(routeForLocation(person.location));
          const isFollowing = following?.id === person.id;
          return (
          <li key={person.id}>
            <div className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5">
              <span className="relative shrink-0">
                <Avatar user={person} size={24} />
                <span
                  title={person.active ? 'Active' : 'Idle'}
                  className={cn(
                    'absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full ring-2 ring-surface',
                    person.active ? 'bg-low' : 'bg-med'
                  )}
                />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs text-fg">
                  {person.fullname}
                  {person.isSelf ? <span className="text-fg-subtle"> (you)</span> : null}
                </span>
                {/* The activity label is what makes this useful: not just who is
                    here, but which engagement they are in. */}
                <span className="block truncate text-[0.625rem] text-fg-subtle">
                  {person.activity || (person.active ? 'Browsing' : 'Idle')}
                </span>
              </span>
              {followable || isFollowing ? (
                <button
                  type="button"
                  onClick={() => (isFollowing ? unfollow() : follow(person.id))}
                  title={
                    isFollowing
                      ? `Stop following ${person.fullname}`
                      : `Follow ${person.fullname} — your screen goes where theirs goes`
                  }
                  aria-pressed={isFollowing}
                  className={cn(
                    'shrink-0 rounded p-1 transition',
                    isFollowing
                      ? 'bg-brand-500/20 text-brand-300'
                      : 'text-fg-subtle opacity-0 hover:bg-white/10 hover:text-fg focus:opacity-100 group-hover:opacity-100'
                  )}
                >
                  <Footprints size={13} />
                </button>
              ) : null}
            </div>
          </li>
          );
        })}
      </ul>
    </div>
  );
}

/** A section heading in the sidebar. */
function NavSection({ label }) {
  return (
    <p className="mt-4 px-2.5 pb-1 text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
      {label}
    </p>
  );
}

function SidebarContent({ onNavigate }) {
  const { isAdmin, isSales } = useAuth();

  return (
    <div className="flex h-full flex-col gap-4 p-3">
      <Brand onNavigate={onNavigate} />

      <div className="flex items-center gap-1">
        {/* One box for everybody now. It searches a different endpoint for a sales account —
            clients, contacts and proposals — because the engagement search answers 403 for
            them and an empty box every time is worse than no box. */}
        <div className="min-w-0 flex-1">
          <GlobalSearch />
        </div>
        <NotificationsBar />
      </div>

      <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
        {isSales
          ? null
          : NAV.map((item) => <NavItem key={item.to} item={item} onNavigate={onNavigate} />)}

        {/* Work asked for and work won, kept apart from the jobs themselves. */}
        {isSales ? null : (
          <>
            <NavSection label="Incoming" />
            {INCOMING_NAV.map((item) => (
              <NavItem key={item.to} item={item} onNavigate={onNavigate} />
            ))}
          </>
        )}

        {/*
          Sales before Administration: it is where work comes from, so it belongs with the work
          rather than filed under the housekeeping an admin does once a month.
        */}
        {isAdmin || isSales ? (
          <>
            {/* No heading for a sales account: a single-section sidebar does not need a
                label telling somebody which section they are in. */}
            {isSales ? null : <NavSection label="Sales" />}
            {SALES_NAV.map((item) => (
              <NavItem key={item.to} item={item} onNavigate={onNavigate} />
            ))}
            {/* The sales log is an admin's view of who is doing what, so it is only ever
                offered to one of them — see the route in sales.routes.js. */}
            {isAdmin ? <NavItem item={SALES_LOG_NAV} onNavigate={onNavigate} /> : null}
          </>
        ) : null}

        {isAdmin ? (
          <>
            <NavSection label="Administration" />
            {ADMIN_NAV.map((item) => (
              <NavItem key={item.to} item={item} onNavigate={onNavigate} />
            ))}
          </>
        ) : null}
      </nav>

      {/* Who else is about is a question about the work. */}
      {isSales ? null : <OnlinePanel />}

      <div className="border-t border-line-soft pt-2">
        <UserMenu />
      </div>
    </div>
  );
}

export function AppShell() {
  const { appName } = useBranding();
  /*
   * Which build this is, fetched once per session.
   *
   * Never blocking and never loud: an instance that cannot answer shows nothing rather than an
   * error in a footer, which is the right trade for a label nobody needs until something is wrong.
   */
  const build = useResource('/version', { initial: null });
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();

  // Close the drawer whenever navigation happens.
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 border-r border-line-soft bg-surface/50 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close navigation"
            onClick={() => setMobileOpen(false)}
            className="absolute inset-0 cursor-default bg-black/65 backdrop-blur-sm"
          />
          <aside className="relative h-full w-64 border-r border-line bg-surface shadow-pop">
            <Button
              variant="ghost"
              size="icon-sm"
              icon={X}
              aria-label="Close navigation"
              onClick={() => setMobileOpen(false)}
              className="absolute right-2 top-2.5 z-10"
            />
            <SidebarContent onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-line-soft bg-canvas/85 px-4 backdrop-blur lg:hidden">
          <Button
            variant="ghost"
            size="icon-sm"
            icon={Menu}
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          />
          <Brand />
        </header>

        {/* Above the page rather than in the sidebar: it changes where you are, so it belongs
            where you are looking. */}
        <FollowBar />

        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <div className="mx-auto w-full max-w-[88rem]">
            <Outlet />
          </div>
        </main>

        <footer className="border-t border-line-soft px-4 py-3 text-center text-[0.6875rem] text-fg-subtle sm:px-6 lg:px-8">
          {appName} · reports are generated from your own .docx templates
          {/*
            Which build this is, where somebody reporting a problem will already be looking.
            Fetched once per session and never blocking: an instance that cannot answer simply
            shows nothing rather than an error in a footer.
          */}
          {build.data?.version ? (
            <span
              className="ml-1.5 font-mono before:mr-1.5 before:content-['·']"
              title={[
                `Version ${build.data.version}`,
                build.data.commit ? `commit ${build.data.commit}` : null,
                build.data.branch ? `branch ${build.data.branch}` : null,
                `Node ${build.data.node}`,
                `started ${new Date(build.data.startedAt).toLocaleString()}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            >
              v{build.data.version}
              {build.data.commit ? `+${build.data.commit}` : ''}
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export default AppShell;
