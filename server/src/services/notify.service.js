/**
 * The one door every notification goes through.
 *
 * There are twenty-one places in this codebase that tell somebody something, and until now each
 * of them wrote to the collection itself. That was fine while the only question was "does this
 * person need to know" — and stopped being fine the moment the answer became "yes, unless they
 * asked not to be told about this kind", because a preference is only a preference if *every*
 * sender honours it. One that twenty of them honour is a setting that does nothing on the
 * twenty-first, and the twenty-first is whichever one somebody adds next.
 *
 * So the rule lives here, and `Notification.create` is not called anywhere else.
 *
 * ## Silent by preference is not silent by accident
 *
 * A muted notification is dropped rather than stored-and-hidden. Keeping it would mean the unread
 * count and the list disagree with each other the first time somebody turns a type back on, and
 * "you have four unread" pointing at nothing is worse than never having been told.
 *
 * ## What cannot be muted
 *
 * Two kinds. `new-sign-in` is a security notice — the whole value of it is that it arrives when
 * you were not expecting it, and an attacker who can set your preferences could otherwise turn
 * off the thing that tells you they are there. `account-approved` is the message that says your
 * account now works, and somebody who has never signed in has not had the chance to mute anything
 * anyway. Everything else is somebody's choice.
 */

import { Notification, NOTIFICATION_TYPES } from '../models/notification.model.js';
import { User } from '../models/user.model.js';
import { log } from '../utils/logger.js';

/**
 * Types a preference cannot switch off.
 *
 * Deliberately short. A list of things "too important to mute" grows until it is the whole list
 * and the setting is decoration; these two are here because muting them would defeat what they
 * are for rather than because somebody would regret it.
 */
export const ALWAYS_ON = new Set(['new-sign-in', 'account-approved']);

/** Whether this type is something a person may turn off at all. */
export const isMutable = (type) => NOTIFICATION_TYPES.includes(type) && !ALWAYS_ON.has(type);

/**
 * Whether this person wants this kind of notification.
 *
 * Absent means yes. Every account that existed before preferences did has none, and a default of
 * "off" would have silently stopped telling the whole firm anything — so the shape of the stored
 * value is "the ones you turned off", not "the ones you want".
 */
export function wants(user, type) {
  if (!isMutable(type)) return true;
  const muted = user?.notificationsOff;
  if (!muted) return true;
  /* A Map on a hydrated document, a plain object on a `.lean()` one. Both arrive here. */
  const off = typeof muted.get === 'function' ? muted.get(type) : muted[type];
  return off !== true;
}

/**
 * Sends one notification, or several.
 *
 * Takes what `Notification.create` took, so the call sites read the same as they did — the only
 * difference is that this one asks first. Several at once are filtered in a single query rather
 * than one per recipient: an engagement with nine people on it is one read, not nine.
 *
 * Returns how many were actually sent, which several callers already reported to the page as
 * "told 3 people" and which is now the truth rather than the length of the list they passed.
 */
export async function notify(input) {
  const docs = (Array.isArray(input) ? input : [input]).filter(Boolean);
  if (!docs.length) return 0;

  const recipients = [...new Set(docs.map((doc) => String(doc.user ?? '')).filter(Boolean))];
  if (!recipients.length) return 0;

  /*
   * Only the field the rule needs. This runs on paths that are already doing real work — saving an
   * engagement, finishing a render — and a notification must never be the reason one of them is
   * slow.
   */
  let people = [];
  try {
    people = await User.find({ _id: { $in: recipients } })
      .select('notificationsOff')
      .lean();
  } catch (error) {
    /*
     * Fail open, and say so in the log.
     *
     * The alternative is that a database hiccup while reading preferences silently swallows a
     * review request. Being told something you had muted is a mild annoyance; not being told
     * something you wanted is the failure this whole file is about.
     */
    log.warn(`Could not read notification preferences, sending anyway: ${error.message}`);
    await Notification.insertMany(docs);
    return docs.length;
  }

  const byId = new Map(people.map((person) => [String(person._id), person]));
  const wanted = docs.filter((doc) => wants(byId.get(String(doc.user)), doc.type));

  if (!wanted.length) return 0;
  await Notification.insertMany(wanted);
  return wanted.length;
}

export default notify;
