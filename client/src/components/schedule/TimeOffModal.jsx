import { useMemo, useState } from 'react';
import { CalendarOff, Info, Users } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { displayName } from '../../lib/utils.js';

import { Button } from '../ui/Button.jsx';
import { Input, Select, Checkbox } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';
import { LEAVE_TYPE_OPTIONS, isWeekend } from './leave-meta.js';

/** Working days a range costs, so the form can say it before anybody commits to it. */
function workingDaysBetween(start, end, portion) {
  if (!start || !end || end < start) return 0;
  let count = 0;
  for (
    let at = new Date(`${start}T00:00:00Z`);
    at.toISOString().slice(0, 10) <= end;
    at = new Date(at.getTime() + 86_400_000)
  ) {
    if (!isWeekend(at.toISOString().slice(0, 10))) count += 1;
  }
  return portion === 'full' ? count : count * 0.5;
}

/**
 * Asking for time off, or — if you are an admin — recording it.
 *
 * The same form for both, because they differ by one sentence: an admin recording leave is
 * recording a decision, not asking for one. Saying which it is *before* the button is
 * pressed is the difference between a calendar people trust and one they check twice.
 */
export default function TimeOffModal({ open, onClose, onSaved, people = [], requireApproval = true, defaultDay }) {
  const { user, isAdmin } = useAuth();
  const toast = useToast();
  const me = String(user?.id ?? user?._id ?? '');

  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);

  // Re-seeded whenever the modal opens, so yesterday's half-day tick does not linger.
  const state = useMemo(() => {
    if (!open) return null;
    return (
      form ?? {
        user: me,
        type: 'holiday',
        start: defaultDay ?? new Date().toISOString().slice(0, 10),
        end: defaultDay ?? new Date().toISOString().slice(0, 10),
        portion: 'full',
        note: '',
        everyone: false,
      }
    );
  }, [open, form, me, defaultDay]);

  const close = () => {
    setForm(null);
    onClose();
  };

  const singleDay = state?.start && state.start === state.end;
  const days = workingDaysBetween(state?.start, state?.end, state?.portion ?? 'full');
  const forSomebodyElse = state && state.user !== me && !state.everyone;
  /** An admin's own record needs no approving; anybody else's request waits. */
  const willBeApproved = isAdmin || !requireApproval;

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        start: state.start,
        end: state.end,
        note: state.note,
        portion: singleDay ? state.portion : 'full',
        ...(state.everyone
          ? { type: 'public-holiday' }
          : { type: state.type, ...(state.user !== me ? { user: state.user } : {}) }),
      };
      const saved = await api.post('/leave', body);
      close();
      await onSaved?.(saved);
      toast.success(
        state.everyone
          ? 'Public holiday added'
          : saved.status === 'approved'
            ? 'Time off recorded'
            : 'Request sent',
        state.everyone
          ? 'It comes off everybody’s available days.'
          : saved.status === 'approved'
            ? 'It shows on the calendar and comes out of your available days.'
            : 'An admin will see it in their notifications.'
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title={state?.everyone ? 'Add a public holiday' : forSomebodyElse ? 'Record somebody’s time off' : 'Book time off'}
      description={
        state?.everyone
          ? 'A day the whole firm is closed. It applies to everybody, including people who join later.'
          : willBeApproved
            ? 'Recorded straight away, and visible to anybody about to book your week.'
            : 'Sent to the admins to approve. It shows on the calendar as requested until they do.'
      }
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={CalendarOff}
            loading={saving}
            disabled={!state?.start || !state?.end || state.end < state.start || days === 0}
            onClick={save}
          >
            {state?.everyone ? 'Add it' : willBeApproved ? 'Record it' : 'Ask for it'}
          </Button>
        </>
      }
    >
      {state ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {!state.everyone ? (
            <Select
              label="Why"
              wrapperClassName={isAdmin ? '' : 'sm:col-span-2'}
              value={state.type}
              onChange={(event) => setForm({ ...state, type: event.target.value })}
              options={LEAVE_TYPE_OPTIONS}
            />
          ) : null}

          {/* Recording somebody else's, or the whole firm's, is an admin's job — the server
              enforces both, so the controls only exist where they can be used. */}
          {isAdmin && !state.everyone ? (
            <Select
              label="Whose"
              hint="Only an admin can record somebody else’s."
              value={state.user}
              onChange={(event) => setForm({ ...state, user: event.target.value })}
              options={[
                { value: me, label: 'Mine' },
                ...people
                  .filter((person) => String(person.id ?? person._id) !== me)
                  .map((person) => ({
                    value: String(person.id ?? person._id),
                    label: displayName(person),
                  })),
              ]}
            />
          ) : null}

          <Input
            label="From"
            type="date"
            required
            value={state.start}
            onChange={(event) => {
              const start = event.target.value;
              // A start that overtakes the end is a typo, not an intention.
              setForm({ ...state, start, end: state.end && state.end < start ? start : state.end });
            }}
          />
          <Input
            label="To"
            type="date"
            required
            hint={
              days
                ? `${days} working day${days === 1 ? '' : 's'} — weekends do not count`
                : 'Weekends only, so it costs nothing'
            }
            error={state.end && state.end < state.start ? 'Before the start date' : undefined}
            value={state.end}
            onChange={(event) => setForm({ ...state, end: event.target.value })}
          />

          {/* Half days only make sense on one day; a half-day fortnight is a full one with
              extra steps, and the server refuses it. */}
          {singleDay && !state.everyone ? (
            <Select
              label="How much of the day"
              value={state.portion}
              onChange={(event) => setForm({ ...state, portion: event.target.value })}
              options={[
                { value: 'full', label: 'All day' },
                { value: 'am', label: 'Morning only' },
                { value: 'pm', label: 'Afternoon only' },
              ]}
            />
          ) : null}

          <Input
            label={state.everyone ? 'What it is' : 'Note'}
            placeholder={state.everyone ? 'Christmas Day' : 'Optional — annual leave, conference…'}
            wrapperClassName="sm:col-span-2"
            hint={
              state.everyone
                ? 'Shown on the calendar to everybody.'
                : 'Only you and the admins can read this.'
            }
            value={state.note}
            onChange={(event) => setForm({ ...state, note: event.target.value })}
          />

          {isAdmin ? (
            <div className="sm:col-span-2">
              <Checkbox
                checked={state.everyone}
                onChange={(checked) => setForm({ ...state, everyone: checked, portion: 'full' })}
                label="This is a public holiday — everybody gets it"
              />
            </div>
          ) : null}

          <p className="sm:col-span-2 flex items-start gap-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
            {state.everyone ? <Users size={12} className="mt-0.5 shrink-0" /> : <Info size={12} className="mt-0.5 shrink-0" />}
            <span>
              {state.everyone
                ? 'A public holiday comes off everybody’s available days, so nobody looks underworked for a week that was three days long.'
                : 'Time off does not block a booking — the calendar shows the clash rather than refusing it, because a retest half-day inside somebody’s holiday is occasionally the truth.'}
            </span>
          </p>
        </div>
      ) : null}
    </Modal>
  );
}
