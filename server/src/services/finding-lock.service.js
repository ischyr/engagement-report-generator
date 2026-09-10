/**
 * Taking a finding for editing, so nobody else can write to it.
 *
 * The presence banner tells you a colleague has this finding open. It is advisory, and advisory is
 * the right default — two people in one write-up on the last afternoon of a test is sometimes exactly
 * what should happen. But "sometimes" is not "always", and the case it does not cover is the one that
 * costs an hour: you are rewriting the impact, somebody opens the finding, types a sentence and saves,
 * and the merge dialog they clicked through was the only thing between your paragraph and nothing.
 *
 * So this is a real lock, enforced here rather than in the client, because a lock a browser could
 * decline to honour is a suggestion with extra steps.
 *
 * Three properties it has to have, all of them learned from locks that go wrong:
 *
 * **It expires.** A lock held by a laptop that closed is indistinguishable from a lock held by
 * somebody typing, unless you look at whether they are still around — which presence already knows.
 * Five minutes without a heartbeat and anybody may take it.
 *
 * **It can be broken.** Admins and managers can always force it, and it is written to the activity
 * log when they do. A team that cannot get past a lock invents a way around the tool.
 *
 * **It says who and since when.** "Locked" with no name is an error message; "Andrei took this at
 * 15:02" is something you can act on, usually by asking him.
 */

import { HttpError, forbidden, notFound } from '../utils/http-error.js';

/**
 * How long a holder can be away before their lock is anybody's.
 *
 * Measured against presence, not against when the lock was taken: somebody editing the same finding
 * for three hours still holds it, and somebody whose browser died two minutes after taking it does
 * not. The window is deliberately longer than the presence window itself (75 seconds), so a dropped
 * heartbeat or a tab in the background does not hand your finding to somebody else mid-sentence.
 */
export const LOCK_IDLE_MS = 5 * 60 * 1000;

/** Roles that can take a lock off somebody else. */
const CAN_FORCE = new Set(['admin', 'manager']);

const idOf = (value) => String(value?._id ?? value ?? '');

/**
 * Whether a lock has lapsed.
 *
 * The later of two things: when it was taken, and when its holder was last seen. Both are needed, and
 * the first version of this used only the second — which meant a lock taken by anyone who had not yet
 * sent a heartbeat was lapsed the instant it was created, so the lock silently did nothing. The test
 * suite caught it by locking as one user and successfully writing *and deleting* as another.
 *
 * With both, every case reads correctly: a browser beating every 25 seconds holds its lock all day; a
 * closed laptop gives it up five minutes after its last beat; and something taken over the API with no
 * presence at all still holds for five minutes, which is enough to be useful and short enough that it
 * cannot strand a finding.
 *
 * A holder we cannot find at all — a deleted account — counts as lapsed, because the alternative is a
 * finding nobody may ever edit again.
 */
export function lockIsStale(finding, holder) {
  if (!finding?.lockedBy) return true;
  if (!holder) return true;
  const takenAt = finding.lockedAt ? new Date(finding.lockedAt).getTime() : 0;
  const lastSeen = holder.lastSeenAt ? new Date(holder.lastSeenAt).getTime() : 0;
  const alive = Math.max(takenAt, lastSeen);
  if (!alive) return true;
  return Date.now() - alive > LOCK_IDLE_MS;
}

/**
 * The lock as the client needs to see it: who, since when, and what may be done about it.
 *
 * @param {object} finding
 * @param {object|null} holder The holder's user document, for presence and their name.
 * @param {object} user Whoever is asking.
 */
export function describeLock(finding, holder, user) {
  if (!finding?.lockedBy) return null;
  const mine = idOf(finding.lockedBy) === idOf(user?._id);
  const stale = lockIsStale(finding, holder);
  return {
    by: holder
      ? {
          id: idOf(holder),
          username: holder.username,
          firstname: holder.firstname,
          lastname: holder.lastname,
          fullname: [holder.firstname, holder.lastname].filter(Boolean).join(' ') || holder.username,
        }
      : { id: idOf(finding.lockedBy), fullname: 'somebody who no longer has an account' },
    at: finding.lockedAt,
    note: finding.lockNote ?? '',
    mine,
    stale,
    /** Anybody may take a lapsed lock; only a lead may take a live one. */
    mayTakeOver: mine || stale || CAN_FORCE.has(user?.role),
  };
}

/**
 * Refuses a write to a finding somebody else holds.
 *
 * 423 rather than 403: it is not that this person may never write here, it is that right now they may
 * not, and the client shows a different thing for each. The details carry the holder so the message on
 * screen can name them instead of saying "locked".
 *
 * @param {object} finding
 * @param {object} user
 * @param {object|null} holder The holder's user document, for the staleness check.
 */
export function assertUnlocked(finding, user, holder) {
  if (!finding?.lockedBy) return;
  if (idOf(finding.lockedBy) === idOf(user?._id)) return;
  if (lockIsStale(finding, holder)) return;

  const who = holder
    ? [holder.firstname, holder.lastname].filter(Boolean).join(' ') || holder.username
    : 'another operator';
  const when = finding.lockedAt ? new Date(finding.lockedAt).toISOString().slice(11, 16) : '';
  throw new HttpError(
    423,
    `${who} has locked this finding${when ? ` since ${when}` : ''}. It is read-only until they unlock it.`,
    {
      locked: true,
      by: who,
      at: finding.lockedAt,
      note: finding.lockNote ?? '',
      /** So a lead's client can offer the button and everybody else's cannot. */
      mayForce: CAN_FORCE.has(user?.role),
    }
  );
}

/**
 * Takes the lock.
 *
 * Refuses if somebody else holds a live one, unless this person may force it. Re-taking your own is a
 * no-op that refreshes the note, which is what pressing the button twice should do.
 */
export function takeLock(finding, user, holder, { note = '', force = false } = {}) {
  if (!finding) throw notFound('Finding not found');

  const held = Boolean(finding.lockedBy) && idOf(finding.lockedBy) !== idOf(user._id);
  if (held && !lockIsStale(finding, holder)) {
    if (!force) {
      assertUnlocked(finding, user, holder);
    } else if (!CAN_FORCE.has(user.role)) {
      throw forbidden('Only an admin or a manager can take a lock off somebody else');
    }
  }

  finding.lockedBy = user._id;
  finding.lockedAt = new Date();
  finding.lockNote = String(note ?? '').slice(0, 200);
  return finding;
}

/**
 * Gives it up.
 *
 * The holder always may. A lead may release somebody else's — the same override as forcing, and the
 * one that matters more, because the common case is a colleague who went home holding it.
 */
export function releaseLock(finding, user, holder) {
  if (!finding) throw notFound('Finding not found');
  if (!finding.lockedBy) return finding;

  const mine = idOf(finding.lockedBy) === idOf(user._id);
  if (!mine && !lockIsStale(finding, holder) && !CAN_FORCE.has(user.role)) {
    throw forbidden('Only the person holding a lock, or a lead, can release it');
  }

  finding.lockedBy = null;
  finding.lockedAt = null;
  finding.lockNote = '';
  return finding;
}

export default { assertUnlocked, takeLock, releaseLock, describeLock, lockIsStale, LOCK_IDLE_MS };
