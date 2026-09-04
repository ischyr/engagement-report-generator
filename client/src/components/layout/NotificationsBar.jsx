import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import {
  AtSign,
  Bell,
  CalendarCheck,
  CalendarClock,
  CalendarSync,
  CheckCheck,
  Eraser,
  Hourglass,
  ListChecks,
  MessageSquare,
  Palmtree,
  Pause,
  ScrollText,
  ShieldAlert,
  UserCheck,
  UserPlus,
  X,
} from 'lucide-react';

import { useNotifications } from '../../context/NotificationsContext.jsx';
import { cn, timeAgo } from '../../lib/utils.js';
import { Avatar } from '../ui/Misc.jsx';
import { Button } from '../ui/Button.jsx';

/**
 * One glyph per kind, so a full panel can be read without reading it.
 *
 * Every type in the model belongs here: an entry that is missing falls back to the same bell
 * as everything else, which is how four kinds of notice ended up looking identical.
 */
const TYPE_ICON = {
  mention: AtSign,
  'review-requested': ScrollText,
  'comment-on-your-finding': MessageSquare,
  'check-assigned': ListChecks,
  'new-sign-in': ShieldAlert,
  'booking-soon': CalendarClock,
  'booking-changed': CalendarSync,
  'leave-requested': Palmtree,
  'leave-decided': CalendarCheck,
  'engagement-due': Hourglass,
  'engagement-held': Pause,
  'account-awaiting-approval': UserPlus,
  'account-approved': UserCheck,
};

/**
 * The bell and the panel behind it.
 *
 * Lives in the sidebar next to search, and the panel portals out to the body for
 * the same reason search does — a fixed overlay nested in the sticky sidebar gets
 * painted under the main column no matter how high its z-index goes.
 */
export default function NotificationsBar() {
  const navigate = useNavigate();
  const { items, unread, markRead, markAllRead, clearRead, refresh } = useNotifications();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return undefined;
    refresh();
    const onKeyDown = (event) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, refresh]);

  const openItem = (item) => {
    if (!item.read) markRead(item._id);
    setOpen(false);
    if (item.href) navigate(item.href);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        className={cn(
          'relative flex shrink-0 items-center justify-center rounded-lg p-2 transition',
          unread ? 'text-brand-300 hover:bg-brand-500/10' : 'text-fg-subtle hover:bg-white/5 hover:text-fg'
        )}
      >
        <Bell size={15} />
        {unread ? (
          <span className="absolute -right-0.5 -top-0.5 grid min-w-4 place-items-center rounded-full bg-brand-500 px-1 text-[0.5625rem] font-bold leading-4 text-white ring-2 ring-surface">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
      </button>

      {open
        ? createPortal(
            <div className="fixed inset-0 z-100 flex justify-end">
              <button
                type="button"
                aria-label="Close notifications"
                tabIndex={-1}
                onClick={() => setOpen(false)}
                className="absolute inset-0 cursor-default bg-canvas/70 backdrop-blur-sm"
                style={{ animation: 'notif-fade 140ms ease-out' }}
              />

              <aside
                role="dialog"
                aria-modal="true"
                aria-label="Notifications"
                className="relative flex h-full w-full max-w-sm flex-col border-l border-line bg-overlay shadow-pop"
                style={{ animation: 'notif-in 200ms cubic-bezier(.16,1,.3,1)' }}
              >
                <header className="flex items-center gap-2 border-b border-line-soft px-4 py-3">
                  <Bell size={15} className="text-brand-300" />
                  <h2 className="flex-1 text-sm font-semibold text-fg">
                    Notifications
                    {unread ? <span className="ml-1.5 text-fg-subtle">({unread} new)</span> : null}
                  </h2>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={X}
                    aria-label="Close"
                    onClick={() => setOpen(false)}
                  />
                </header>

                <div className="min-h-0 flex-1 overflow-y-auto">
                  {items.length === 0 ? (
                    <p className="px-4 py-10 text-center text-xs text-fg-subtle">
                      Nothing yet. You will hear about it here when someone{' '}
                      <span className="font-mono text-fg-muted">@mentions</span> you in a comment,
                      sends an engagement for your review, or when time you are booked for is about
                      to start.
                    </p>
                  ) : (
                    <ul className="divide-y divide-line-soft">
                      {items.map((item) => {
                        const Icon = TYPE_ICON[item.type] ?? Bell;
                        return (
                          <li key={item._id}>
                            <button
                              type="button"
                              onClick={() => openItem(item)}
                              className={cn(
                                'flex w-full items-start gap-3 px-4 py-3 text-left transition hover:bg-white/[0.035]',
                                !item.read && 'bg-brand-500/[0.07]'
                              )}
                            >
                              <span className="relative mt-0.5 shrink-0">
                                <Avatar user={item.actor} size={26} />
                                <span className="absolute -bottom-1 -right-1 grid size-4 place-items-center rounded-full bg-surface ring-1 ring-line">
                                  <Icon size={9} className="text-brand-300" />
                                </span>
                              </span>

                              <span className="min-w-0 flex-1">
                                <span className="block text-xs leading-snug text-fg">
                                  {item.message}
                                </span>
                                <span className="mt-1 flex items-center gap-1.5 text-[0.625rem] text-fg-subtle">
                                  {item.auditName ? (
                                    <span className="truncate">{item.auditName}</span>
                                  ) : null}
                                  {item.auditName ? <span>·</span> : null}
                                  <span className="shrink-0">{timeAgo(item.createdAt)}</span>
                                </span>
                              </span>

                              {!item.read ? (
                                <span
                                  aria-hidden
                                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-400"
                                />
                              ) : null}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>

                <footer className="flex items-center gap-2 border-t border-line-soft px-3 py-2.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={CheckCheck}
                    onClick={markAllRead}
                    disabled={!unread}
                  >
                    Mark all read
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={Eraser}
                    onClick={clearRead}
                    disabled={!items.some((item) => item.read)}
                    className="ml-auto"
                  >
                    Clear read
                  </Button>
                </footer>
              </aside>

              <style>{`
                @keyframes notif-fade { from { opacity: 0 } to { opacity: 1 } }
                @keyframes notif-in {
                  from { opacity: 0; transform: translateX(16px) }
                  to   { opacity: 1; transform: none }
                }
              `}</style>
            </div>,
            document.body
          )
        : null}
    </>
  );
}
