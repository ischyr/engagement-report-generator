/**
 * The vocabulary the Skills page is drawn in, in one place.
 *
 * Levels, expiry states and the shapes derived from them were previously inline in the page;
 * once the matrix, the profile pane and the certification wall all needed them, three copies
 * of "what does expiring mean" would have disagreed within a week.
 */

/** Four steps, not five stars. A scale with a middle invites everybody to sit in it. */
export const LEVELS = [
  { value: 'learning', label: 'Learning', short: 'L', pips: 1 },
  { value: 'working', label: 'Working knowledge', short: 'W', pips: 2 },
  { value: 'strong', label: 'Strong', short: 'S', pips: 3 },
  { value: 'expert', label: 'Expert', short: 'E', pips: 4 },
];

export const levelOf = (value) => LEVELS.find((level) => level.value === value) ?? LEVELS[1];

/** Could be given the work today, rather than taught it. Used for depth everywhere. */
export const isDeep = (level) => level === 'strong' || level === 'expert';

export const todayIso = () => new Date().toISOString().slice(0, 10);

/** Roughly how long arranging a re-sit takes, which is what makes an expiry actionable. */
export const RENEWAL_WINDOW_DAYS = 90;

/** How a certification's expiry reads: gone, going, fine, or never stated. */
export function expiryState(expiresAt) {
  if (!expiresAt) return { tone: 'neutral', label: 'no expiry', key: 'undated' };
  const today = todayIso();
  if (expiresAt < today) return { tone: 'danger', label: 'expired', key: 'expired' };
  const soon = new Date(Date.now() + RENEWAL_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  if (expiresAt <= soon) return { tone: 'warning', label: 'expires soon', key: 'expiring' };
  return { tone: 'success', label: 'valid', key: 'valid' };
}

/** Whole months from today, negative once it has passed. For sorting and for wording. */
export function monthsAway(day) {
  if (!day) return null;
  const [year, month] = day.split('-').map(Number);
  const now = new Date();
  return (year - now.getFullYear()) * 12 + (month - (now.getMonth() + 1));
}

/**
 * A person's skills, strongest first.
 *
 * The reason anybody reads a profile is to find who is best placed, never to read it
 * alphabetically — so alphabetical is only the tie-break.
 */
export const byStrength = (a, b) =>
  levelOf(b.level).pips - levelOf(a.level).pips || a.name.localeCompare(b.name);

/** Whether somebody has written anything down at all. A blank profile is a gap, not a person. */
export const hasProfile = (person) =>
  person.skills.length + person.certifications.length > 0 || Boolean(person.headline);
