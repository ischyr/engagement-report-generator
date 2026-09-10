/**
 * Writing the Sales log.
 *
 * One function, called from the routes that change something. Deliberately best-effort: a
 * proposal that moved but whose log entry failed to write is a worse outcome than a proposal
 * that did not move, so a logging failure is a warning in the server log rather than a 500 at
 * somebody who was only pressing "accepted".
 */

import { SalesActivity, SALES_ACTION_AREA } from '../models/sales-activity.model.js';
import { log } from '../utils/logger.js';

const nameOf = (user) =>
  [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || 'somebody';

/**
 * @param {object} args
 * @param {object} args.actor      the user who did it
 * @param {string} args.action     one of SALES_ACTIONS
 * @param {string} args.summary    a sentence, already written
 * @param {object} [args.proposal] the proposal, if it is about one
 * @param {string} [args.proposalRef] its reference, when the record itself has just been
 *   deleted and there is nothing left to derive it from — see the model on why the text is
 *   kept as well as the link
 * @param {*}      [args.company]  the client id, if it is about one
 * @param {string} [args.target]   what it happened to, in words
 * @param {object} [args.meta]
 */
export async function logSales({
  actor,
  action,
  summary,
  proposal,
  proposalRef,
  company,
  target,
  meta,
}) {
  try {
    await SalesActivity.create({
      actor: actor?._id ?? null,
      actorRole: actor?.role ?? '',
      action,
      summary,
      proposal: proposal?._id ?? proposal ?? null,
      proposalRef: proposalRef ?? proposal?.reference ?? '',
      company: company ?? proposal?.company?._id ?? proposal?.company ?? null,
      target: target ?? proposal?.title ?? '',
      meta: meta ?? null,
    });
  } catch (error) {
    log.warn(`Could not write the sales log entry for ${action}: ${error.message}`);
  }
}

/** The sentence a status move gets, so every caller writes it the same way. */
export const describeMove = (actor, proposal, from, to, note) =>
  `${nameOf(actor)} moved ${proposal.reference} from ${from} to ${to}${note ? ` — ${note}` : ''}`;

export { nameOf as actorName };

/**
 * The log, newest first.
 *
 * Paged rather than capped: an admin looking into "what happened to the Northwind proposal"
 * wants to be able to keep reading, and a hard limit would silently hide the answer.
 */
export async function salesActivity({ limit = 100, skip = 0, area = '', proposal = '' } = {}) {
  const filter = {};
  if (proposal) filter.proposal = proposal;
  if (area) {
    // Filtered by area rather than by action, because "show me the effort changes" is the
    // question, and it spans two actions.
    const actions = Object.entries(SALES_ACTION_AREA)
      .filter(([, value]) => value === area)
      .map(([key]) => key);
    filter.action = { $in: actions };
  }

  const [entries, total] = await Promise.all([
    SalesActivity.find(filter)
      .populate([
        { path: 'actor', select: 'username firstname lastname' },
        { path: 'company', select: 'name' },
        { path: 'proposal', select: 'reference title status' },
      ])
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Math.min(Math.max(Number(limit) || 100, 1), 300)),
    SalesActivity.countDocuments(filter),
  ]);

  return {
    entries: entries.map((entry) => ({
      id: entry._id.toString(),
      action: entry.action,
      area: SALES_ACTION_AREA[entry.action] ?? 'other',
      summary: entry.summary,
      actor: entry.actor
        ? {
            id: entry.actor._id.toString(),
            fullname: nameOf(entry.actor),
            username: entry.actor.username,
          }
        : null,
      actorRole: entry.actorRole,
      /** The live record when it still exists, and the text either way. */
      proposal: entry.proposal
        ? {
            id: entry.proposal._id.toString(),
            reference: entry.proposal.reference,
            title: entry.proposal.title,
            status: entry.proposal.status,
          }
        : null,
      proposalRef: entry.proposalRef,
      company: entry.company?.name ?? '',
      target: entry.target,
      meta: entry.meta ?? null,
      at: entry.createdAt,
    })),
    total,
  };
}

export default logSales;
