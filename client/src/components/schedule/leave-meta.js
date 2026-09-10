import { GraduationCap, Palmtree, Stethoscope, CalendarOff, Landmark } from 'lucide-react';

/**
 * How each kind of time off is drawn and named, in one place.
 *
 * The calendar, the table and the request form all show the same rows; three lists of
 * labels would have drifted the first time a type was added. Every entry carries an icon as
 * well as a colour, because a calendar that distinguishes sickness from holiday by hue alone
 * is unreadable to a tenth of the people looking at it — and this app checks its palette
 * against colour-vision simulations for exactly that reason.
 */
export const LEAVE_META = {
  holiday: { label: 'Holiday', icon: Palmtree, tone: 'info', hue: 'var(--color-info)' },
  sick: { label: 'Sick', icon: Stethoscope, tone: 'warning', hue: 'var(--color-med)' },
  training: { label: 'Training', icon: GraduationCap, tone: 'brand', hue: 'var(--color-brand-400)' },
  unpaid: { label: 'Unpaid', icon: CalendarOff, tone: 'neutral', hue: 'var(--color-fg-subtle)' },
  'public-holiday': { label: 'Public holiday', icon: Landmark, tone: 'success', hue: 'var(--color-low)' },
  other: { label: 'Other', icon: CalendarOff, tone: 'neutral', hue: 'var(--color-fg-muted)' },
};

export const leaveMeta = (type) => LEAVE_META[type] ?? LEAVE_META.other;

/** What the types are called in the picker, in the order people pick them. */
export const LEAVE_TYPE_OPTIONS = [
  { value: 'holiday', label: 'Holiday' },
  { value: 'sick', label: 'Sick leave' },
  { value: 'training', label: 'Training or conference' },
  { value: 'unpaid', label: 'Unpaid leave' },
  { value: 'other', label: 'Something else' },
];

/**
 * Approved leave, hatched; a request, outlined.
 *
 * A pending request has to be visible — it is the whole reason somebody would look before
 * booking — without looking like a decision that has been made. Hatching for approved and a
 * dashed outline for requested keeps the two apart in shape as well as in colour.
 */
export function leaveBarStyle(leave, { first = true, last = true } = {}) {
  const { hue } = leaveMeta(leave.type);
  if (leave.status === 'requested') {
    return {
      backgroundColor: 'color-mix(in oklab, var(--color-canvas) 80%, transparent)',
      /*
       * The outline is a run, not a box per day.
       *
       * Drawn on all four sides in every cell, a three-day request read as three separate
       * requests — the same mistake the booking bars were written to avoid, where repeating
       * the label on all five days turned one bar into a row of stamps.
       */
      borderTop: `1px dashed ${hue}`,
      borderBottom: `1px dashed ${hue}`,
      borderLeft: first ? `1px dashed ${hue}` : 'none',
      borderRight: last ? `1px dashed ${hue}` : 'none',
      color: hue,
    };
  }
  /*
   * Hatched in the hue over a dark tint of it, with the label *in* the hue.
   *
   * Not white on a solid fill like the engagement bars: those six colours were picked and
   * contrast-checked for white text, and these four were not — yellow for sickness would
   * have failed outright. A light hue on a dark tinted base is legible for all of them and
   * survives whatever the surface behind it is.
   */
  return {
    backgroundColor: `color-mix(in oklab, ${hue} 16%, var(--color-surface))`,
    backgroundImage: `repeating-linear-gradient(135deg, color-mix(in oklab, ${hue} 34%, transparent) 0 3px, transparent 3px 7px)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${hue} 34%, transparent)`,
    color: hue,
  };
}

/** Whether a `yyyy-mm-dd` is a Saturday or a Sunday, without touching a local timezone. */
export function isWeekend(day) {
  const at = new Date(`${day}T00:00:00Z`).getUTCDay();
  return at === 0 || at === 6;
}

/** Half a day says so; a full day does not need to. */
export const portionLabel = (portion) =>
  portion === 'am' ? 'morning' : portion === 'pm' ? 'afternoon' : '';
