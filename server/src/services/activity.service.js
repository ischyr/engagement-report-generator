/**
 * Writes the activity log and the notifications that come out of it.
 *
 * Logging is deliberately best-effort: an engagement edit must not fail because
 * its audit-trail entry could not be written. Every call is fire-and-forget with
 * its own error handling, and the caller never awaits a failure.
 */

import { Activity, ACTIONS } from '../models/activity.model.js';
import { Notification } from '../models/notification.model.js';
import { User, WORKING_ROLES } from '../models/user.model.js';
import { membershipExpired } from '../utils/audit-scope.js';
import { log } from '../utils/logger.js';

export { ACTIONS };

const nameOf = (user) =>
  user
    ? [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username || 'Someone'
    : 'Someone';

/**
 * Records one entry.
 *
 * @param {object} input
 * @param {object} input.audit the audit document (or its id)
 * @param {object} input.actor the acting user
 * @param {string} input.action one of ACTIONS
 * @param {string} [input.target] what it happened to, in words
 * @param {string[]} [input.fields] which fields changed
 * @param {object} [input.meta]
 * @param {string} [input.summary] override the generated sentence
 */
export async function recordActivity({ audit, actor, action, target, fields, meta, summary }) {
  try {
    const auditId = audit?._id ?? audit;
    if (!auditId) return null;

    return await Activity.create({
      audit: auditId,
      actor: actor?._id ?? actor ?? null,
      action,
      target: target ?? '',
      fields: fields ?? [],
      meta: meta ?? null,
      summary: summary ?? buildSummary({ actor, action, target, fields, meta }),
    });
  } catch (error) {
    // Never let the trail break the work it is describing.
    log.warn(`Could not record activity ${action}: ${error.message}`);
    return null;
  }
}

/** Turns an entry into the sentence the UI shows. */
function buildSummary({ actor, action, target, fields, meta }) {
  const who = nameOf(actor);
  const what = target ? `"${target}"` : '';
  const changed = fields?.length ? ` (${fields.join(', ')})` : '';

  const sentences = {
    [ACTIONS.AUDIT_CREATED]: `${who} created the engagement`,
    [ACTIONS.AUDIT_UPDATED]: `${who} updated the engagement details${changed}`,
    [ACTIONS.AUDIT_DELETED]: `${who} moved the engagement to the trash`,
    [ACTIONS.AUDIT_RESTORED]: `${who} restored the engagement from the trash`,
    [ACTIONS.AUDIT_DUPLICATED]: `${who} used this engagement as the starting point for ${what}`,
    [ACTIONS.STATE_CHANGED]: `${who} moved the engagement from ${meta?.from} to ${meta?.to}`,
    [ACTIONS.APPROVED]: `${who} approved the report`,
    [ACTIONS.APPROVAL_WITHDRAWN]: `${who} withdrew their approval`,
    [ACTIONS.APPROVALS_CLEARED]: `Approvals were cleared because ${what || 'content'} changed after sign-off`,
    [ACTIONS.REPORT_GENERATED]: `${who} generated the report${meta?.template ? ` from "${meta.template}"` : ''}`,
    [ACTIONS.MEDIA_REPLACED]: `${who} replaced ${what} in ${meta?.places ?? 0} place(s)`,
    [ACTIONS.FINDING_TRANSFERRED]: `${who} ${
      { out: 'moved', 'copied-from': 'copied', in: meta?.mode === 'move' ? 'moved in' : 'copied in' }[
        meta?.direction
      ] ?? 'transferred'
    } ${what} ${meta?.direction === 'in' ? 'from' : 'to'} ${meta?.other ?? 'another engagement'}`,
    [ACTIONS.FINDING_PROMOTED]: `${who} ${
      meta?.replaced ? 'updated the library entry for' : 'added to the library'
    } ${what}`,
    [ACTIONS.REPORT_DELIVERED]: `${who} recorded that ${what} was sent to ${
      meta?.recipients ?? 0
    } recipient(s)${meta?.channel ? ` by ${meta.channel}` : ''}`,
    [ACTIONS.REPORT_DELIVERY_REMOVED]: `${who} removed the delivery record for ${what}`,

    [ACTIONS.FINDING_CREATED]: `${who} added the finding ${what}`,
    [ACTIONS.FINDING_UPDATED]: `${who} edited the finding ${what}${changed}`,
    [ACTIONS.FINDING_DELETED]: `${who} deleted the finding ${what}`,
    [ACTIONS.FINDING_RESTORED]: `${who} restored ${what} from the trash${
      meta?.renumberedFrom ? `, renumbered from ${meta.renumberedFrom} to ${meta.to} because that number was taken` : ''
    }`,
    [ACTIONS.FINDING_PURGED]: `${who} deleted ${what} for good, before the trash expired`,
    [ACTIONS.FINDING_IMPORTED]: `${who} added ${what} from the library`,
    [ACTIONS.FINDINGS_REORDERED]: `${who} reordered the findings`,

    [ACTIONS.SECTION_CREATED]: `${who} added the section ${what}`,
    [ACTIONS.SECTION_UPDATED]: `${who} wrote in ${what}`,
    [ACTIONS.SECTIONS_REORDERED]: `${who} reordered the sections`,
    [ACTIONS.SECTION_DELETED]: `${who} removed the section ${what}`,

    [ACTIONS.NOTE_CREATED]: `${who} added the note ${what}`,
    [ACTIONS.NOTE_UPDATED]: `${who} edited the note ${what}`,
    [ACTIONS.NOTE_PROMOTED]: `${who} wrote up the note ${what} as a finding${
      meta?.finding ? ` — ${meta.finding}` : ''
    }`,
    [ACTIONS.NOTE_DELETED]: `${who} deleted the note ${what}`,

    [ACTIONS.ENUM_STEP_CREATED]: `${who} added the enumeration step ${what}`,
    [ACTIONS.ENUM_STEP_UPDATED]: `${who} edited the enumeration step ${what}`,
    [ACTIONS.ENUM_STEP_DELETED]: `${who} deleted the enumeration step ${what}`,
    [ACTIONS.ENUM_STEPS_REORDERED]: `${who} reordered the enumeration steps`,
    [ACTIONS.ENUM_STEP_PROMOTED]: `${who} wrote up the enumeration step ${what} as a finding${
      meta?.finding ? ` (${meta.finding})` : ''
    }`,
    [ACTIONS.ENUM_STEP_TO_SCOPE]: `${who} added hosts from ${what} to the scope${
      meta?.group ? ` group "${meta.group}"` : ''
    }`,

    [ACTIONS.CHECK_CREATED]: `${who} added the check ${what}`,
    [ACTIONS.CHECK_UPDATED]: `${who} edited the check ${what}`,
    [ACTIONS.CHECK_ASSIGNED]: `${who} ${
      meta?.assigned ? 'assigned' : 'unassigned'
    } the check ${what}`,
    [ACTIONS.CHECK_TICKED]: `${who} verified ${what}`,
    [ACTIONS.CHECK_UNTICKED]: `${who} un-verified ${what}`,
    [ACTIONS.CHECK_DELETED]: `${who} removed the check ${what}`,
    [ACTIONS.CHECKS_ADDED]: `${who} added ${meta?.added ?? 0} checks from the ${meta?.preset ?? ''} checklist`,
    [ACTIONS.CHECKS_CLEARED]: `${who} cleared the checklist (${meta?.removed ?? 0} items)`,
    // The reason is the point of the entry, so it is in the sentence rather than the metadata.
    [ACTIONS.CHECK_BLOCKED]: `${who} marked ${what} as blocked — ${meta?.reason ?? 'no reason given'}`,
    [ACTIONS.CHECK_UNBLOCKED]: `${who} unblocked ${what}`,

    [ACTIONS.COMMENT_ADDED]: `${who} commented on ${what}`,
    [ACTIONS.COMMENT_RESOLVED]: `${who} resolved a comment on ${what}`,
    [ACTIONS.COMMENT_REOPENED]: `${who} reopened a comment on ${what}`,

    [ACTIONS.SHARE_LINK_CREATED]: `${who} made a client link for ${what}`,
    [ACTIONS.SHARE_LINK_REVOKED]: `${who} revoked the client link ${what}`,
    /*
     * Never reached in practice: the route writes its own summary, because this one would have to
     * begin with a name, and the client has none. Here so the action is not an unlabelled code if
     * anything ever records it without one.
     */
    [ACTIONS.CLIENT_UPDATED_FINDING]: `The client updated ${what}`,
    [ACTIONS.QUESTION_ASKED]: `${who} noted a question for the client: ${what}`,
    [ACTIONS.QUESTION_SETTLED]: `${who} settled the question ${what}`,
    /* The undo of a delete, which reads better as its own line than as a gap in the log. */
    [ACTIONS.ITEM_RESTORED]: `${who} restored ${what}`,
    [ACTIONS.CREDENTIAL_ADDED]: `${who} added the credential ${what}`,
    // Named as plainly as possible: this is the line somebody reads when asking who
    // looked at a client's password.
    [ACTIONS.CREDENTIAL_REVEALED]: `${who} revealed the credential ${what}`,
    [ACTIONS.CREDENTIAL_UPDATED]: `${who} changed the credential ${what}`,
    [ACTIONS.CREDENTIAL_DELETED]: `${who} deleted the credential ${what}`,
    [ACTIONS.CREDENTIALS_PURGED]: `${who} purged ${meta?.removed ?? 0} credential(s)`,

    [ACTIONS.BOOKING_ADDED]: `${who} booked ${what} onto this engagement (${meta?.start} → ${meta?.end})`,
    [ACTIONS.BOOKING_REMOVED]: `${who} removed a booking (${meta?.start} → ${meta?.end})`,

    [ACTIONS.SCOPE_UPDATED]: `${who} updated the scope`,
    [ACTIONS.SCOPE_IMPORTED]: `${who} imported ${meta?.added ?? 0} host(s) from a scan`,
    [ACTIONS.SIGNATURE_ADDED]: `${who} signed the engagement as ${what}`,
    [ACTIONS.SIGNATURE_REMOVED]: `${who} removed ${
      meta?.mine ? 'their signature' : `the signature of ${what}`
    }`,
    [ACTIONS.SCOPE_CHANGE_RECORDED]: `${who} recorded a scope change agreed on ${meta?.agreedOn}: ${what}`,
    [ACTIONS.SCOPE_CHANGE_REMOVED]: `${who} removed the scope change ${what}`,

    // The outcome is in the sentence rather than the metadata, because "not detected"
    // is the interesting half and nobody expands a log line to find it.
    [ACTIONS.DETECTION_RECORDED]: `${who} logged the action ${what} — ${
      meta?.outcome ?? 'outcome not recorded'
    }`,
    [ACTIONS.DETECTION_UPDATED]: `${who} changed the logged action ${what} — ${
      meta?.outcome ?? 'outcome not recorded'
    }`,
    [ACTIONS.DETECTION_REMOVED]: `${who} removed the logged action ${what}`,

    // The reason is the whole point of the entry, so it is in the sentence rather than in
    // metadata somebody has to go looking for.
    [ACTIONS.HELD]: `${who} stopped work on this engagement — ${what}`,
    [ACTIONS.RESUMED]: `${who} restarted work${what ? ` — ${what}` : ''}`,

    [ACTIONS.KIT_ADDED]: `${who} added ${
      meta?.added === 1 ? `${what} to the kit list` : `${meta?.added ?? 0} items to the kit list`
    }`,
    [ACTIONS.KIT_MOVED]: `${who} marked ${what} as ${meta?.to === 'out' ? 'out with us' : 'back'}`,
    // Named plainly: this is the line somebody reads when a client asks where their badge went.
    [ACTIONS.KIT_MISSING]: `${who} recorded that ${what} has not come back`,

    [ACTIONS.PHISHING_TARGETS_ADDED]: `${who} added ${meta?.added ?? 0} recipient(s) to the sending list${
      meta?.updated ? ` and updated ${meta.updated}` : ''
    }`,
    [ACTIONS.PHISHING_RESULTS_IMPORTED]: `${who} imported campaign results — ${
      meta?.rows ?? 0
    } row(s) read, ${meta?.updated ?? 0} matched, ${meta?.added ?? 0} added`,
    [ACTIONS.PHISHING_LIST_CLEARED]: `${who} cleared the sending list (${meta?.removed ?? 0} recipients)`,

    [ACTIONS.ARCHIVED]: `${who} archived this engagement`,
    [ACTIONS.UNARCHIVED]: `${who} took this engagement back out of the archive`,
    [ACTIONS.DOCUMENT_ADDED]: `${who} added the client document ${what}`,
    [ACTIONS.DOCUMENT_REMOVED]: `${who} removed the client document ${what}`,

    [ACTIONS.RESTRICTED]: `${who} marked this engagement restricted${what ? ` — ${what}` : ''}`,
    [ACTIONS.UNRESTRICTED]: `${who} took the restricted marking off this engagement`,
  };

  return sentences[action] ?? `${who} changed something`;
}

/* -------------------------------------------------------------------------- */
/* Mentions                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Usernames written as @name.
 *
 * Matched against real accounts rather than trusted from the text, so a typo
 * silently mentions nobody instead of creating a notification for a user that
 * does not exist. An email address is not a mention: the character before the @
 * has to be something other than a word character, which `nadia@example.com` fails.
 */
const MENTION_RE = /(^|[^\w@])@([a-z0-9._-]{3,40})/gi;

export function extractMentionHandles(body) {
  const handles = new Set();
  // Tags are stripped first because most of these bodies are editor HTML, where a
  // handle could otherwise be read out of a URL or an attribute nobody can see.
  const text = String(body ?? '').replace(/<[^>]*>/g, ' ');
  for (const match of text.matchAll(MENTION_RE)) {
    handles.add(match[2].toLowerCase().replace(/[.\-_]+$/, ''));
  }
  return [...handles];
}

/**
 * Where a mention was written, so the notification can say so and link there.
 *
 * Mentions used to exist only in comments, which taught people the feature was
 * unreliable: `@nadia` in a note or a section notified nobody and looked identical
 * to one that worked.
 */
const MENTION_PLACES = {
  finding: { tab: 'findings', sentence: (who, what) => `${who} mentioned you on "${what}"` },
  note: { tab: 'notes', sentence: (who, what) => `${who} mentioned you in the note "${what}"` },
  section: {
    tab: 'sections',
    sentence: (who, what) => `${who} mentioned you in the "${what}" section`,
  },
  check: {
    tab: 'checks',
    sentence: (who, what) => `${who} mentioned you on the check "${what}"`,
  },
};

/**
 * Creates a notification per mentioned user.
 *
 * @returns {Promise<{notified: string[], unknown: string[]}>}
 */
export async function notifyMentions({
  body,
  previousBody,
  actor,
  audit,
  finding,
  where,
  title,
}) {
  const handles = extractMentionHandles(body);
  // On an edit, only handles that were not there before. Somebody rewording a note
  // five times must not send the same person five notifications, and a colleague
  // mentioned last week does not need telling again because a typo was fixed.
  const already = previousBody === undefined ? [] : extractMentionHandles(previousBody);
  const fresh = handles.filter((handle) => !already.includes(handle));
  if (fresh.length === 0) return { notified: [], unknown: [] };

  // A finding is the default because that is where mentions started, and every
  // existing caller means one.
  const place = MENTION_PLACES[where] ?? MENTION_PLACES.finding;
  const what = title ?? finding?.title ?? 'a finding';

  const users = await User.find({
    username: { $in: fresh },
    enabled: true,
    approvedAt: { $ne: null },
    // A mention is a notification with a link in it. Somebody who cannot open the link
    // is better told nothing than sent to a 403 with their own name on it.
    roles: { $in: WORKING_ROLES },
  }).select('username');
  const found = new Map(users.map((u) => [u.username, u]));
  const unknown = fresh.filter((h) => !found.has(h));

  const actorId = (actor?._id ?? actor)?.toString();
  const recipients = users.filter((u) => u._id.toString() !== actorId);

  if (recipients.length) {
    await Notification.insertMany(
      recipients.map((user) => ({
        user: user._id,
        type: 'mention',
        actor: actor?._id ?? actor ?? null,
        audit: audit?._id ?? audit ?? null,
        auditName: audit?.name ?? '',
        findingId: finding?._id ?? null,
        target: what,
        message: place.sentence(nameOf(actor), what),
        /*
         * Straight to the finding when there is one. A mention that opened the findings
         * list and left the reader to guess which of forty findings they had been tagged
         * in was the whole reason findings needed their own URL.
         */
        href: finding?._id
          ? `/engagements/${audit?._id ?? audit}/findings/${finding._id}`
          : `/engagements/${audit?._id ?? audit}?tab=${place.tab}`,
      })),
      { ordered: false }
    );
  }

  return { notified: recipients.map((u) => u.username), unknown };
}

/**
 * Tells reviewers an engagement is waiting on them.
 *
 * Skips anybody whose access to it has run out. Their notification would have linked to a page
 * that answers 403 — a request for work they can no longer see, which reads as a mistake by the
 * person who sent it. An expired reviewer is surfaced to the requester instead, where somebody
 * can actually do something about it.
 */
export async function notifyReviewRequested({ audit, actor }) {
  const ids = (audit.reviewers ?? [])
    .map((r) => r?._id ?? r)
    .filter((id) => id && id.toString() !== (actor?._id ?? actor)?.toString());
  if (ids.length === 0) return 0;

  /*
   * Roles are looked up rather than read off the audit: expiry never applies to an admin, most
   * callers load an engagement without selecting `role`, and reading it off an unpopulated id
   * would silently drop an admin reviewer's notification on the strength of a missing field.
   */
  // `roles`, not `role`: the latter is a virtual now and selecting it fetches nothing.
  const people = await User.find({ _id: { $in: ids } }).select('roles');
  const reviewers = people
    .filter((person) => !membershipExpired(audit, person))
    .map((person) => person._id);
  if (reviewers.length === 0) return 0;

  await Notification.insertMany(
    reviewers.map((id) => ({
      user: id,
      type: 'review-requested',
      actor: actor?._id ?? actor ?? null,
      audit: audit._id,
      auditName: audit.name ?? '',
      message: `${nameOf(actor)} moved "${audit.name}" into review`,
      href: `/engagements/${audit._id}`,
    })),
    { ordered: false }
  );
  return reviewers.length;
}

/**
 * Tells somebody a check is theirs.
 *
 * Being handed work is exactly what a notification is for, and until now only three things ever
 * reached the bell — a mention, a review request, and a comment on your own finding. Assigning
 * a check is the fourth, and the first that is a request rather than a remark.
 */
export async function notifyCheckAssigned({ user, actor, audit, title }) {
  const recipient = String(user?._id ?? user ?? '');
  if (!recipient) return false;
  // Taking a check yourself is not news; telling you what you just did is noise, and noise is
  // how a notification bell stops being read.
  if (recipient === String(actor?._id ?? actor ?? '')) return false;

  await Notification.create({
    user: recipient,
    type: 'check-assigned',
    actor: actor?._id ?? actor ?? null,
    audit: audit._id,
    auditName: audit.name ?? '',
    target: title,
    message: `${nameOf(actor)} gave you "${title}" on ${audit.name}`,
    href: `/engagements/${audit._id}?tab=checks`,
  });
  return true;
}

/**
 * Clears approvals when approved content changes, if the instance is configured
 * that way. A sign-off on text that has since been rewritten is worse than no
 * sign-off, because it looks like assurance.
 */
export async function clearApprovalsIfConfigured({ audit, actor, settings, target }) {
  if (!settings?.reviews?.enabled) return false;
  if (!settings.reviews?.private?.removeApprovalsUponUpdate) return false;
  if (!(audit.approvals ?? []).length) return false;

  const count = audit.approvals.length;
  audit.approvals = [];
  await recordActivity({
    audit,
    actor,
    action: ACTIONS.APPROVALS_CLEARED,
    target,
    meta: { cleared: count },
  });
  return true;
}

export default recordActivity;
