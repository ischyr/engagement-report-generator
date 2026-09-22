import { useState } from 'react';
import { BellRing, Lock } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Toggle } from '../ui/Field.jsx';
import { Badge } from '../ui/Badge.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

/**
 * What you want to be told about.
 *
 * Nineteen kinds of notification and, until now, no way to turn any of them off — so on a busy
 * instance the bell filled with bookings being moved, and the review request somebody was actually
 * blocked on scrolled out of sight. A list you have learned to ignore is worse than no list.
 *
 * The switches and their words both come from the server. The catalogue lives beside
 * `NOTIFICATION_TYPES`, which is the list it describes, so a new kind of notification appears here
 * without anybody remembering to add it — and a label for a kind that no longer exists cannot
 * linger, because there is nowhere for it to linger.
 *
 * Saved one switch at a time rather than with a Save button. A preference is not a form: there is
 * nothing to review before committing, nothing that is only valid alongside something else, and a
 * page of switches with a button underneath is a page where half of somebody's changes are lost
 * to a closed tab.
 */
export default function NotificationPreferences() {
  const toast = useToast();
  const { data, loading, setData } = useResource('/notifications/preferences', { initial: null });
  const [busy, setBusy] = useState('');

  const flip = async (type, on) => {
    setBusy(type);
    /*
     * Moved before the request rather than after it.
     *
     * A switch that waits for a round trip before moving feels broken, and the failure case is
     * handled below by putting it back — which is both rarer and more informative than a
     * half-second of nothing.
     */
    const optimistic = {
      ...data,
      groups: data.groups.map((group) => ({
        ...group,
        types: group.types.map((row) => (row.type === type ? { ...row, on } : row)),
      })),
    };
    setData(optimistic);

    try {
      await api.put(`/notifications/preferences/${type}`, { on });
    } catch (error) {
      setData(data);
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  if (loading && !data) return <LoadingBlock label="Reading your preferences…" />;
  if (!data) return null;

  const off = data.groups.flatMap((group) => group.types).filter((row) => !row.on).length;

  return (
    <Card>
      <CardHeader
        icon={BellRing}
        title="What you are told about"
        description="Everything is on until you turn it off. Nothing here changes what happens — only whether it reaches your bell."
        actions={
          off ? (
            <Badge tone="neutral">
              {off} switched off
            </Badge>
          ) : null
        }
      />
      <CardBody className="flex flex-col gap-5">
        {data.groups.map((group) => (
          <div key={group.group} className="flex flex-col gap-2">
            <div>
              <p className="text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
                {group.group}
              </p>
              <p className="text-xs text-fg-muted">{group.hint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              {group.types.map((row) => (
                <div
                  key={row.type}
                  className={cn(
                    'flex items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2',
                    busy === row.type && 'opacity-60'
                  )}
                >
                  <span className="min-w-0 flex-1 text-xs text-fg">{row.label}</span>
                  {/*
                    Two of them cannot be switched off, and the lock says which rather than a
                    disabled switch saying nothing. One is how you find out somebody else signed in
                    as you; the other is how you find out your account works at all.
                  */}
                  {row.locked ? (
                    <span
                      title="This one cannot be switched off — it is how you find out about the others."
                      className="flex items-center gap-1 text-[0.625rem] text-fg-subtle"
                    >
                      <Lock size={11} />
                      always on
                    </span>
                  ) : (
                    <Toggle
                      checked={row.on}
                      disabled={Boolean(busy)}
                      onChange={(next) => flip(row.type, next)}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        {/*
          A kind of notification the catalogue above does not describe.
          Impossible today — the server checks — and shown rather than swallowed because the day it
          is possible is the day somebody added a notification nobody can turn off by accident.
        */}
        {data.unlisted?.length ? (
          <p className="text-xs text-med">
            {data.unlisted.length} kind(s) of notification are not listed here:{' '}
            {data.unlisted.join(', ')}
          </p>
        ) : null}
      </CardBody>
    </Card>
  );
}
