/**
 * An engagement's signatures, shaped for a report.
 *
 * A query, so it is handed to `buildReportData()` like finding history, effort, deliveries and
 * scope changes. The drawings come through as data URIs, which the OOXML converter embeds as
 * real images — the same path a pasted screenshot takes.
 */

import { Signature } from '../models/signature.model.js';

/**
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @param {(value: any) => string} formatDate how this client's reports write dates
 */
export async function signaturesFor(auditId, formatDate = (value) => String(value ?? '')) {
  const rows = await Signature.find({ audit: auditId })
    .populate({ path: 'user', select: 'username firstname lastname title' })
    .sort({ signedAt: 1 });

  const list = rows.map((row) => ({
    /** The name as it was captured, falling back to the account it belongs to. */
    name:
      row.name ||
      [row.user?.firstname, row.user?.lastname].filter(Boolean).join(' ') ||
      row.user?.username ||
      '',
    title: row.title || row.user?.title || '',
    role: row.role || '',
    statement: row.statement || '',
    date: formatDate(row.signedOn),
    signedOn: row.signedOn,
    /** A PNG data URI. Only useful inside a rich field, like `company.logo`. */
    image: row.image,
  }));

  return { signatures: list, html: signatureBlockHtml(list), recorded: list.length > 0 };
}

/**
 * The sign-off page as one block of HTML, so a template can print it with a single raw tag rather
 * than building a loop of figures by hand.
 *
 * Pure and exported, which is not tidiness: the sample engagement needs the same block and used to
 * carry its own copy of this markup. That copy drifted the day signatures gained
 * `data-figure="no"` — the real path stopped numbering them as figures and the fixture kept doing
 * it, so the test render proved the opposite of the truth. One builder, both callers.
 *
 * Plain `<img>` inside a `<p>`: the docx converter turns each into an embedded image sized from its
 * own pixels, and the HTML report sanitiser keeps data URIs. Nothing here relies on a style the
 * template might not define.
 */
export function signatureBlockHtml(list = []) {
  return list
    .map((entry) => {
      const lines = [
        entry.statement ? `<p>${escapeText(entry.statement)}</p>` : '',
        /*
         * `data-figure="no"`: a signature is not evidence.
         *
         * Screenshots are numbered automatically — "Figure 12" — which is what lets the prose
         * point at one. A signature carrying a figure number reads badly in the one document
         * somebody actually signs, and it would push every real figure along by two.
         */
        `<p><img src="${entry.image}" alt="Signature of ${escapeText(
          entry.name
        )}" width="220" data-figure="no"/></p>`,
        `<p><strong>${escapeText(entry.name)}</strong>${
          entry.title ? ` — ${escapeText(entry.title)}` : ''
        }</p>`,
        `<p>${escapeText([entry.role, entry.date].filter(Boolean).join(' · '))}</p>`,
      ];
      return lines.filter(Boolean).join('');
    })
    .join('');
}

/** The names and titles are plain text from a form, and land in HTML. */
function escapeText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export default signaturesFor;
