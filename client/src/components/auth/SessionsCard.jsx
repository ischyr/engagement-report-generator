import { Chrome, Laptop, LogOut, MonitorSmartphone, ShieldAlert, Smartphone } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import { useState } from 'react';

/**
 * Which icon suits a user agent, and a label if the server did not send one.
 *
 * The words now come from the server, which derives them for the "signed in from a new device"
 * notice — two implementations of the same sentence would eventually disagree, and the one
 * place that must not is a security notice next to the list it refers to. The icon stays here
 * because it is presentation.
 *
 * Coarse on purpose either way. The full string is kept and shown underneath, because a wrong
 * guess about somebody's browser is worse than the honest text when the question is
 * "do I recognise this session".
 */
function describe(userAgent) {
  const ua = String(userAgent ?? '');
  if (!ua) return { label: 'Unknown device', icon: MonitorSmartphone };

  const mobile = /Android|iPhone|iPad|Mobile/i.test(ua);
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    // Chrome's string contains Safari's, so this order matters.
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';

  const platform =
    /Windows NT/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS'
    : /Android/.test(ua) ? 'Android'
    : /(iPhone|iPad|iPod)/.test(ua) ? 'iOS'
    : /Linux/.test(ua) ? 'Linux'
    : '';

  return {
    label: [browser, platform].filter(Boolean).join(' on '),
    icon: mobile ? Smartphone : browser === 'Chrome' ? Chrome : Laptop,
  };
}

/**
 * Where this account is signed in, and what has been refused lately.
 *
 * `tokenVersion` could already end every session at once — on a password change — but
 * that is all-or-nothing and invisible: nobody could see a session they did not
 * recognise, or end one without ending their own.
 */
export default function SessionsCard() {
  const toast = useToast();
  const { logout } = useAuth();
  const { data, loading, reload } = useResource('/auth/sessions', { initial: null });
  const [busy, setBusy] = useState(null);
  const [confirmOthers, setConfirmOthers] = useState(false);

  const sessions = data?.sessions ?? [];
  const failed = data?.failedLogins ?? [];
  const others = sessions.filter((session) => !session.current).length;

  const revoke = async (session) => {
    setBusy(session.id);
    try {
      await api.del(`/auth/sessions/${session.id}`);
      // Ending your own session is a sign-out: the cookies are already gone, and the
      // access token in memory would otherwise keep this tab looking signed in until
      // it expired.
      if (session.current) {
        await logout();
        return;
      }
      toast.success('Signed that session out');
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const revokeOthers = async () => {
    setBusy('others');
    try {
      const result = await api.post('/auth/sessions/revoke-others', {});
      setConfirmOthers(false);
      toast.success(
        result.revoked === 1 ? 'One other session signed out' : `${result.revoked} sessions signed out`
      );
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(null);
    }
  };

  const clearFailed = async () => {
    try {
      await api.del('/auth/failed-logins');
      await reload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          icon={MonitorSmartphone}
          title="Where you are signed in"
          description={
            sessions.length > 1
              ? `${sessions.length} sessions. Signing one out stops it refreshing; the page it has open keeps working for up to ${data?.accessTtl ?? '30m'}.`
              : 'Each browser you sign in from appears here until it is signed out or expires.'
          }
          actions={
            others ? (
              <Button
                variant="ghost"
                size="sm"
                icon={LogOut}
                loading={busy === 'others'}
                onClick={() => setConfirmOthers(true)}
              >
                Sign out the others
              </Button>
            ) : null
          }
        />
        <CardBody className="flex flex-col gap-1.5">
          {loading && !data ? (
            <p className="text-xs text-fg-subtle">Loading…</p>
          ) : sessions.length === 0 ? (
            // Only possible on a session that predates this feature: it has no id to
            // list, and saying so is better than an empty box.
            <p className="text-xs text-fg-subtle">
              Nothing recorded yet. Sign out and back in and this session will appear.
            </p>
          ) : (
            sessions.map((session) => {
              const { label: guessed, icon: Icon } = describe(session.userAgent);
              // The server's wording when it has one, so this list and the notice agree.
              const label = session.device || guessed;
              return (
                <div
                  key={session.id}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5',
                    session.current
                      ? 'border-brand-500/30 bg-brand-500/[0.06]'
                      : 'border-line-soft bg-canvas/40'
                  )}
                >
                  <Icon size={15} className="shrink-0 text-fg-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 text-xs text-fg">
                      {label}
                      {session.current ? <Badge tone="brand">this browser</Badge> : null}
                    </p>
                    <p className="mt-0.5 truncate text-[0.625rem] text-fg-subtle">
                      {[
                        session.ip || 'address unknown',
                        `signed in ${timeAgo(session.signedInAt)}`,
                        `active ${timeAgo(session.lastSeenAt)}`,
                      ].join(' · ')}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={LogOut}
                    loading={busy === session.id}
                    onClick={() => revoke(session)}
                    title={session.current ? 'This signs you out here' : 'Sign this session out'}
                  >
                    {session.current ? 'Sign out' : 'End'}
                  </Button>
                </div>
              );
            })
          )}

          <p className="mt-1 text-[0.625rem] leading-relaxed text-fg-subtle">
            Changing your password ends every session, including this one, and issues a
            fresh one. The browser and address are what the client reported — they
            identify a session to you, and are not used to authenticate anything.
          </p>
        </CardBody>
      </Card>

      {failed.length ? (
        <Card>
          <CardHeader
            icon={ShieldAlert}
            title="Refused sign-ins"
            description="Attempts on your account that did not get in. The rate limiter stops repeats; this is so you know somebody tried."
            actions={
              <Button variant="ghost" size="sm" onClick={clearFailed}>
                Clear
              </Button>
            }
          />
          <CardBody className="flex flex-col gap-1">
            {failed.map((attempt, index) => (
              <div
                key={`${attempt.at}-${index}`}
                className="flex flex-wrap items-center gap-x-3 gap-y-0.5 rounded-lg px-2 py-1.5 odd:bg-white/[0.02]"
              >
                <span className="text-xs text-fg">{formatDateTime(attempt.at)}</span>
                <Badge tone={attempt.reason === 'code' ? 'danger' : 'warning'}>
                  {attempt.reason === 'code' ? 'wrong two-factor code' : 'wrong password'}
                </Badge>
                <span className="min-w-0 flex-1 truncate text-[0.625rem] text-fg-subtle">
                  {[attempt.ip, describe(attempt.userAgent).label].filter(Boolean).join(' · ')}
                </span>
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <ConfirmDialog
        open={confirmOthers}
        onClose={() => setConfirmOthers(false)}
        onConfirm={revokeOthers}
        title="Sign out every other session?"
        message={`${others} other session${others === 1 ? '' : 's'} will be signed out. This browser stays signed in.`}
        confirmLabel="Sign them out"
        loading={busy === 'others'}
      />
    </>
  );
}
