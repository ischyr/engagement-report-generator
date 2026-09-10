/**
 * Which engagements — and therefore which clients — a user is allowed to see.
 *
 * Extracted because it is now asked in half a dozen places, and a page that quietly
 * widened it would leak one team's client work into another's. One definition, used
 * by all of them.
 */

/**
 * The access clause on its own: creator, collaborator or reviewer.
 *
 * Separate from the filter below because client visibility deliberately *includes*
 * trashed engagements — the trash view shows their names, so hiding the client would
 * make a restorable engagement unreadable.
 *
 * @returns {object|null} null for an admin, who is not restricted
 */
export function auditAccessClause(user) {
  if (user.role === 'admin') return null;
  return {
    $and: [
      { $or: [{ creator: user._id }, { collaborators: user._id }, { reviewers: user._id }] },
      /*
       * Membership that has run out is not membership.
       *
       * Expressed in the query rather than checked afterwards, because this clause is what the
       * engagements list, the findings page, insights, the schedule, search and the inbox all
       * scope themselves by — a check in one of them would leave the others showing work
       * somebody can no longer open.
       *
       * `$nor` rather than a positive condition: most engagements have no entries at all, and
       * "there is no expired entry for me" is true for them without any date arithmetic.
       */
      {
        $nor: [
          { memberUntil: { $elemMatch: { user: user._id, until: { $lt: today() } } } },
        ],
      },
    ],
  };
}

/** Today as `yyyy-mm-dd`, the format every day in this app is stored and compared in. */
export function today() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Whether this person's access to this engagement has run out.
 *
 * The same rule as the query clause, for code holding a document rather than building a
 * filter. Kept beside it so the two cannot disagree about what "expired" means.
 *
 * `asOf` is the day to judge against, defaulting to today. A caller that has already
 * decided which day it is — the reminder sweep works a window out from one `now` — passes
 * it in, so one pass cannot use two notions of today and reach a self-contradictory answer.
 */
export function membershipExpired(audit, user, asOf = today()) {
  if (user.role === 'admin') return false;
  const uid = String(user._id);
  // The creator's access never expires, whatever a stray entry says.
  const creator = String(audit.creator?._id ?? audit.creator ?? '');
  if (creator === uid) return false;
  const entry = (audit.memberUntil ?? []).find(
    (row) => String(row.user?._id ?? row.user ?? '') === uid
  );
  return Boolean(entry?.until && entry.until < asOf);
}

/**
 * @param {{role: string, _id: any}} user
 * @param {object} [extra] additional top-level conditions, merged in
 * @returns {object} a Mongoose filter
 */
export function visibleAuditFilter(user, extra = {}) {
  // Trashed engagements are reachable only through the trash view.
  const base = { deletedAt: null, ...extra };
  const access = auditAccessClause(user);
  if (!access) return base;

  // Wrapped in `$and` so a caller's own `$or` cannot silently replace this one and
  // widen access.
  return { ...base, $and: [...(extra.$and ?? []), access] };
}

/* -------------------------------------------------------------------------- */
/* Clients                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The companies a user may see: those they have an engagement with, plus any they
 * created themselves.
 *
 * The second half matters — without it, adding a client and then creating their first
 * engagement would be impossible, because the client would vanish the moment it was
 * saved. Companies that predate this field have no creator, so a non-admin sees them
 * only through an engagement, which is the intended rule.
 *
 * @returns {Promise<object>} a Mongoose filter for the Company collection
 */
export async function visibleCompanyFilter(user) {
  if (user.role === 'admin') return {};

  const { Audit } = await import('../models/audit.model.js');
  const ids = await Audit.distinct('company', {
    ...auditAccessClause(user),
    company: { $ne: null },
  });

  return { $or: [{ _id: { $in: ids } }, { createdBy: user._id }] };
}

/**
 * The contacts a user may see: those at a company they can see, plus their own.
 *
 * A contact with no company is only visible to whoever created it — otherwise an
 * unassigned contact would be visible to everybody, which is the leak this closes.
 *
 * @returns {Promise<object>} a Mongoose filter for the Client collection
 */
export async function visibleClientFilter(user) {
  if (user.role === 'admin') return {};

  const { Company } = await import('../models/company.model.js');
  const companies = await Company.distinct('_id', await visibleCompanyFilter(user));

  return { $or: [{ company: { $in: companies } }, { createdBy: user._id }] };
}

export default visibleAuditFilter;
