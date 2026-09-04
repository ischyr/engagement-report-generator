/**
 * Letting somebody in.
 *
 * Registering an account and being allowed to use one are two different events. Anyone
 * who can reach the sign-in page can do the first; only an administrator can do the
 * second. Between them the new person does the one piece of setup that is theirs to do
 * — pairing an authenticator — so that by the time an admin looks at the queue the
 * account is already protected, and approving it is the last step rather than the first
 * of several.
 *
 * The gate is at the session, not at the password. An unapproved account can prove who
 * it is and can finish enrolment; what it cannot do is hold a token. That is the
 * narrowest place to put it: everything behind the API is reached with a session, so
 * one check covers the whole platform rather than every route remembering.
 */

import { User } from '../models/user.model.js';
import { Notification } from '../models/notification.model.js';
import { log } from '../utils/logger.js';

/** Fields the approval queue needs, and nothing that would leak a secret. */
// `roles`, not `role`: the latter is a virtual and selecting it fetches nothing.
const QUEUE_FIELDS =
  'username email firstname lastname title roles createdAt totpEnabled enabled';

const nameOf = (user) =>
  [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || 'somebody';

/**
 * Accounts that exist but have never been let in, oldest first.
 *
 * Oldest first because this is a queue and the person who has been waiting longest is
 * the one most likely to have given up and sent a message about it.
 */
export async function pendingAccounts() {
  const users = await User.find({ approvedAt: null }).select(QUEUE_FIELDS).sort({ createdAt: 1 });

  return users.map((user) => ({
    id: user._id.toString(),
    username: user.username,
    email: user.email,
    fullname: nameOf(user),
    /* Both halves as well as the joined name: the avatar derives its initials from these,
       and without them the same person shows one pair here and another in the table. */
    firstname: user.firstname ?? '',
    lastname: user.lastname ?? '',
    title: user.title ?? '',
    role: user.role,
    registeredAt: user.createdAt,
    /*
     * Whether they finished pairing an app. Shown rather than assumed: an account that
     * registered and walked away is a different thing from one that is genuinely ready,
     * and an admin approving the first has approved an account with no second factor.
     */
    twoFactorReady: Boolean(user.totpEnabled),
    enabled: user.enabled !== false,
  }));
}

/** How many are waiting. Cheap enough for an admin to poll. */
export function pendingCount() {
  return User.countDocuments({ approvedAt: null });
}

/**
 * Lets an account in, or takes that back.
 *
 * Revoking bumps `tokenVersion`, so somebody whose approval is withdrawn loses the
 * session they are holding at that moment rather than at the end of its lifetime. The
 * opposite would make "I have removed their access" true only eventually, which is not
 * what anybody means when they press it.
 */
export async function setApproval(user, approved, actor) {
  if (approved) {
    if (user.approvedAt) return { user, changed: false };
    user.approvedAt = new Date();
    user.approvedBy = actor?._id ?? null;
    await user.save({ validateBeforeSave: false });
    await noticeApproved(user, actor);
    return { user, changed: true };
  }

  if (!user.approvedAt) return { user, changed: false };
  user.approvedAt = null;
  user.approvedBy = null;
  user.tokenVersion += 1;
  await user.save({ validateBeforeSave: false });
  return { user, changed: true };
}

/**
 * Tells the admins somebody is waiting.
 *
 * Sent when enrolment finishes rather than when the form is submitted. A half-finished
 * registration is not yet a request for anything — it is somebody who closed the tab —
 * and putting it in front of an admin would train them to ignore the notification that
 * matters.
 *
 * Only approved, enabled admins are told, for the same reason a review is never
 * requested from somebody who cannot sign in: a notification nobody can open is worse
 * than none, because it looks handled.
 */
export async function notifyAdminsOfPendingAccount(user) {
  const admins = await User.find({
    roles: 'admin',
    enabled: true,
    approvedAt: { $ne: null },
    _id: { $ne: user._id },
  }).select('_id');

  if (!admins.length) {
    // Worth a line in the log: the queue has an entry and nobody will be told about it.
    log.warn(`No administrator can be notified that ${user.username} is waiting for approval`);
    return 0;
  }

  await Notification.create(
    admins.map((admin) => ({
      user: admin._id,
      type: 'account-awaiting-approval',
      actor: user._id,
      target: user.username,
      message: `${nameOf(user)} registered and is waiting to be let in`,
      href: '/users',
    }))
  );
  return admins.length;
}

/**
 * Tells the person they are in.
 *
 * They are not signed in when this is written, which is the point — it is waiting in
 * their bell the first time they get through, and answers "who let me in, and when"
 * without anybody having to ask.
 */
async function noticeApproved(user, actor) {
  if (!actor || String(actor._id) === String(user._id)) return;
  await Notification.create({
    user: user._id,
    type: 'account-approved',
    actor: actor._id,
    message: `${nameOf(actor)} approved your account — welcome aboard`,
    href: '/',
  });
}

/**
 * Marks every account that predates approval as already approved.
 *
 * Awaited at boot, next to the approvals migration, because the alternative is worse
 * than a migration: adding this field without it would lock every existing account —
 * including the only admin — out of an instance that was working a minute ago. Accounts
 * that were already in use were approved by whoever built the instance; recording that
 * as their creation date is the truthful answer, since that is when they were let in.
 *
 * The filter matches nothing once it has run, so running it on every boot costs one
 * indexed query.
 */
export async function backfillApprovals() {
  const result = await User.collection.updateMany({ approvedAt: { $exists: false } }, [
    { $set: { approvedAt: { $ifNull: ['$createdAt', '$$NOW'] }, approvedBy: null } },
  ]);
  const changed = result.modifiedCount ?? 0;
  if (changed) {
    log.info(`Marked ${changed} existing account${changed === 1 ? '' : 's'} as already approved`);
  }
  return changed;
}

export default { pendingAccounts, pendingCount, setApproval, backfillApprovals };
