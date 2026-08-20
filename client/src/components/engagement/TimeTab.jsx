import { useMemo, useState } from 'react';
import { CalendarDays, Clock, Timer, Trash2, TriangleAlert } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDate } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Input, Select } from '../ui/Field.jsx';
import { Avatar } from '../ui/Misc.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../ui/Table.jsx';

/** A day, in the same `yyyy-mm-dd` the server stores — no timezone anywhere near it. */
const todayIso = () => {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`;
};

/** The amounts people actually log, so the common case is one click. */
const QUICK = [1, 2, 4, 6, 8];

const idOf = (value) => String(value?._id ?? value?.id ?? value ?? '');

/**
 * Who an entry belongs to.
 *
 * `userId` comes from the server and survives the account: a deleted colleague's `user` is
 * null, and keying off that would put every deleted person in one bucket.
 */
const entryUser = (entry) => String(entry.userId ?? entry.user?._id ?? '');

/**
 * What the job is taking, against what was planned for it.
 *
 * Bookings say who *will* be busy; this says what the work turned out to cost. Kept in the
 * engagement because that is where somebody is at the end of an afternoon, and rolled up on
 * the Team page and into the report from the same entries.
 */
export default function TimeTab({ audit, editable }) {
  const toast = useToast();
  const { user, isAdmin } = useAuth();
  const { data, loading, reload } = useResource(`/time/audit/${audit._id}`, { initial: null });

  const me = idOf(user);
  const [day, setDay] = useState(todayIso);
  const [hours, setHours] = useState('');
  const [note, setNote] = useState('');
  const [who, setWho] = useState(me);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);

  const entries = data?.entries ?? [];
  const people = data?.people ?? [];
  const totals = data?.totals ?? { hours: 0, days: 0, bookedDays: 0, entries: 0 };
  const hoursPerDay = data?.hoursPerDay ?? 8;

  /**
   * Everyone on the engagement, for the rare case of filling in somebody else's hours.
   *
   * Only the creator and admins may, which the server enforces; showing the picker to
   * everybody would be an invitation followed by a 403.
   */
  const team = useMemo(() => {
    const seen = new Map();
    for (const person of [audit.creator, ...(audit.collaborators ?? []), ...(audit.reviewers ?? [])]) {
      const id = idOf(person);
      if (id && !seen.has(id)) seen.set(id, person);
    }
    return [...seen.values()];
  }, [audit.creator, audit.collaborators, audit.reviewers]);

  const mayLogForOthers = isAdmin || idOf(audit.creator) === me;

  /** What is already logged for the day being typed, so re-logging never surprises. */
  const existing = entries.find(
    (entry) => entry.day === day && entryUser(entry) === (who || me)
  );

  const log = async (amount) => {
    const value = Number(amount ?? hours);
    if (!Number.isFinite(value) || value <= 0) return;
    setSaving(true);
    try {
      await api.post('/time', {
        audit: audit._id,
        ...(who && who !== me ? { user: who } : {}),
        day,
        hours: value,
        note,
      });
      setHours('');
      setNote('');
      await reload({ quiet: true });
      toast.success(
        existing ? `${day} corrected to ${value} h` : `${value} h logged for ${formatDate(day)}`
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    try {
      await api.del(`/time/${pendingDelete._id}`);
      setPendingDelete(null);
      await reload({ quiet: true });
      toast.success('Entry removed');
    } catch (error) {
      toast.fromError(error);
    }
  };

  if (loading && !data) return <LoadingBlock label="Adding up the hours…" />;

  const overPlan = totals.bookedDays > 0 && totals.days > totals.bookedDays;

  return (
    <div className="flex flex-col gap-4">
      {/* ------------------------------------------------------------- logging */}
      {editable ? (
        <Card>
          <CardHeader
            icon={Timer}
            title="Log time"
            description="Hours, a day at a time. Logging a day you have already logged corrects it rather than adding to it."
          />
          <CardBody className="flex flex-col gap-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Input
                label="Day"
                type="date"
                value={day}
                max={todayIso()}
                onChange={(event) => setDay(event.target.value)}
              />
              <Input
                label="Hours"
                type="number"
                min="0"
                max="24"
                step="0.25"
                placeholder="7.5"
                hint={
                  existing
                    ? `${existing.hours} h already logged for this day — saving replaces it`
                    : 'Quarter-hour steps'
                }
                value={hours}
                onChange={(event) => setHours(event.target.value)}
              />
              <Input
                label="Note"
                placeholder="Authenticated testing, report writing…"
                wrapperClassName={mayLogForOthers && team.length > 1 ? '' : 'lg:col-span-2'}
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
              {mayLogForOthers && team.length > 1 ? (
                <Select
                  label="Whose"
                  hint="You may fill in anybody's on an engagement you created."
                  value={who}
                  onChange={(event) => setWho(event.target.value)}
                  options={team.map((person) => ({
                    value: idOf(person),
                    label: idOf(person) === me ? 'Mine' : displayName(person) || 'Somebody',
                  }))}
                />
              ) : null}
            </div>

            {/* The whole point of the quick buttons: a full day is one click, not four. */}
            <div className="flex flex-wrap items-center gap-2">
              {QUICK.map((amount) => (
                <Button
                  key={amount}
                  variant="ghost"
                  size="sm"
                  disabled={saving}
                  onClick={() => log(amount)}
                >
                  {amount} h
                </Button>
              ))}
              <Button
                variant="primary"
                size="sm"
                icon={Clock}
                className="ml-auto"
                loading={saving}
                disabled={!day || !hours || Number(hours) <= 0}
                onClick={() => log()}
              >
                {existing ? 'Correct it' : 'Log it'}
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* ------------------------------------------------- planned vs actual */}
      <Card>
        <CardHeader
          icon={Clock}
          title="What it has taken"
          description="Hours logged against days booked. The gap between the two is the only figure worth having when the next job of this shape gets quoted."
        />
        {people.length === 0 ? (
          <EmptyState
            icon={Timer}
            title="No time logged yet"
            description="Nothing is inferred from bookings — a booking is what somebody expected to spend, and this is what it actually took. The report can print the total, and it stays blank until somebody logs something."
          />
        ) : (
          <>
            <CardBody className="grid gap-3 sm:grid-cols-3">
              <span className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5">
                <span className="block font-mono text-lg tabular-nums text-fg">{totals.hours} h</span>
                <span className="text-[0.6875rem] text-fg-subtle">
                  {totals.days} person-days at {hoursPerDay} hours to the day
                </span>
              </span>
              <span className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5">
                <span className="block font-mono text-lg tabular-nums text-fg">
                  {totals.bookedDays}
                </span>
                <span className="text-[0.6875rem] text-fg-subtle">
                  person-days booked on the schedule
                </span>
              </span>
              <span className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5">
                <span className="block font-mono text-lg tabular-nums text-fg">
                  {totals.entries}
                </span>
                <span className="text-[0.6875rem] text-fg-subtle">
                  {totals.firstDay
                    ? `entries, ${formatDate(totals.firstDay)} → ${formatDate(totals.lastDay)}`
                    : 'entries'}
                </span>
              </span>
            </CardBody>

            {overPlan ? (
              <CardBody className="pt-0">
                <p className="flex items-start gap-2 rounded-lg border border-med/25 bg-med/[0.06] px-3 py-2.5 text-xs leading-relaxed text-fg-muted">
                  <TriangleAlert size={14} className="mt-0.5 shrink-0 text-med" />
                  Time has been logged on {totals.days} person-days against {totals.bookedDays}{' '}
                  booked. Worth knowing before the same shape of job is quoted again — not
                  necessarily worth fixing.
                </p>
              </CardBody>
            ) : null}

            <Table>
              <THead>
                <TH>Who</TH>
                <TH align="right">Hours</TH>
                <TH align="right">Person-days</TH>
                <TH align="right">Days touched</TH>
                <TH align="right">Days booked</TH>
              </THead>
              <TBody>
                {people.map((person) => (
                  <TR key={person.id}>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Avatar user={person.user} size={22} />
                        <span className="truncate text-xs text-fg">
                          {displayName(person.user) || 'Removed account'}
                        </span>
                        {person.id === me ? <Badge tone="brand">you</Badge> : null}
                      </span>
                    </TD>
                    <TD align="right" className="font-mono text-xs tabular-nums text-fg">
                      {person.hours ? `${person.hours} h` : '—'}
                    </TD>
                    <TD align="right" className="font-mono text-xs tabular-nums text-fg-muted">
                      {Math.round((person.hours / hoursPerDay) * 100) / 100}
                    </TD>
                    <TD align="right" className="font-mono text-xs tabular-nums text-fg-muted">
                      {person.days}
                    </TD>
                    <TD align="right" className="font-mono text-xs tabular-nums text-fg-muted">
                      {person.bookedDays || '—'}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </>
        )}
      </Card>

      {/* ------------------------------------------------------------ entries */}
      {entries.length ? (
        <Card>
          <CardHeader
            icon={CalendarDays}
            title="Every entry"
            description="Most recent first. One row per person per day, which is why logging a day twice corrects it."
          />
          <Table>
            <THead>
              <TH>Day</TH>
              <TH>Who</TH>
              <TH align="right">Hours</TH>
              <TH>Note</TH>
              <TH width="3rem" />
            </THead>
            <TBody>
              {entries.map((entry) => {
                const mine = entryUser(entry) === me;
                return (
                  <TR key={entry._id}>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">
                      {formatDate(entry.day)}
                    </TD>
                    <TD>
                      <span className="flex items-center gap-2">
                        <Avatar user={entry.user} size={20} />
                        <span className="truncate text-xs text-fg-muted">
                          {displayName(entry.user) || 'Removed account'}
                        </span>
                      </span>
                    </TD>
                    <TD align="right" className="font-mono text-xs tabular-nums text-fg">
                      {entry.hours} h
                    </TD>
                    <TD className="max-w-xs truncate text-xs text-fg-subtle">{entry.note || '—'}</TD>
                    <TD align="right">
                      {editable && (mine || mayLogForOthers) ? (
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Remove this entry"
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(entry)}
                        />
                      ) : null}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </Card>
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={remove}
        title="Remove this entry?"
        message={`${pendingDelete?.hours} h on ${
          pendingDelete ? formatDate(pendingDelete.day) : ''
        }. The engagement's total drops by that much.`}
        confirmLabel="Remove"
      />
    </div>
  );
}
