/**
 * Everything a signed-in browser asks for on a timer, in one place.
 *
 * The client used to run four independent loops on every page: a presence heartbeat every 25
 * seconds, a presence roster every 20, a notification list every 30, and — while any record was
 * open — a further roster read every 8, once per mounted component. Four timers, three endpoints,
 * all of them firing at unrelated offsets, none of them aware that the others existed.
 *
 * The heartbeat is the one request that cannot be removed: something has to tell the server this
 * browser is still here. So it became the one request that answers everything. The others were not
 * asking for anything it did not already have to look up.
 *
 * Both readers live here rather than in the routes because two implementations of "who is online"
 * would eventually disagree about the window, and the roster in the sidebar and the roster behind
 * "somebody else is in this finding" have to be the same roster or the second one is a lie.
 */
import { Notification } from '../models/notification.model.js';
import { User } from '../models/user.model.js';

/**
 * How long after their last heartbeat someone still counts as online. Comfortably more than the
 * client's interval so a slow request does not blink them out.
 */
export const ONLINE_WINDOW_MS = 75_000;
/** Shorter window for the "active right now" dot versus merely "recently here". */
const ACTIVE_WINDOW_MS = 35_000;

/** How many notifications ride along. The bar shows this many; the badge counts all of them. */
const NOTIFICATION_LIMIT = 40;

/** Everybody who has beaten recently, as the sidebar and the "who else is here" banner see them. */
export async function presenceRoster(reader) {
  const since = new Date(Date.now() - ONLINE_WINDOW_MS);
  const users = await User.find({
    lastSeenAt: { $gte: since },
    enabled: true,
    approvedAt: { $ne: null },
  })
    .select('username firstname lastname email roles lastSeenAt activity location')
    .sort({ lastSeenAt: -1 })
    .limit(100);

  const now = Date.now();
  return users.map((user) => ({
    id: user._id.toString(),
    username: user.username,
    firstname: user.firstname,
    lastname: user.lastname,
    fullname: [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username,
    role: user.role,
    activity: user.activity ?? '',
    /** What they have open, for "somebody else is in this finding too". */
    location: user.location ?? '',
    lastSeenAt: user.lastSeenAt,
    /** False when they are inside the window but have gone quiet. */
    active: now - new Date(user.lastSeenAt).getTime() <= ACTIVE_WINDOW_MS,
    isSelf: user._id.equals(reader._id),
  }));
}

/**
 * The notification bar's contents and its badge.
 *
 * The items travel with the heartbeat rather than only the count, which looks like more data than
 * necessary and is not: the client was already fetching this exact list every thirty seconds. The
 * bytes are the same bytes. What has gone is a request, a round trip and a Mongo connection every
 * half minute, on every open tab, for the life of the session.
 */
export async function notificationSummary(reader) {
  const [items, unread] = await Promise.all([
    Notification.find({ user: reader._id })
      .populate('actor', 'username firstname lastname')
      .sort({ createdAt: -1 })
      .limit(NOTIFICATION_LIMIT),
    Notification.countDocuments({ user: reader._id, read: false }),
  ]);
  return { items, unread };
}

/**
 * One answer for one timer.
 *
 * The two reads run together — they touch different collections and neither depends on the other —
 * so the merged request costs about what the slower of the two used to cost on its own.
 */
export async function liveSnapshot(reader) {
  const [users, notifications] = await Promise.all([
    presenceRoster(reader),
    notificationSummary(reader),
  ]);
  return { onlineWindowMs: ONLINE_WINDOW_MS, users, notifications };
}
