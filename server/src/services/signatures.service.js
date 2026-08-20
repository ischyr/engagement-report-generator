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

  /*
   * One ready-made block, so a template can print the whole sign-off page with a single raw
   * tag rather than building a loop of figures by hand.
   *
   * Plain `<img>` inside a `<p>`: the docx converter turns each into an embedded image sized
   * from its own pixels, and the HTML report sanitiser keeps data URIs. Nothing here relies on
   * a style the template might not define.
   */
  const html = list
    .map((entry) => {
      const lines = [
        entry.statement ? `<p>${escapeText(entry.statement)}</p>` : '',
        `<p><img src="${entry.image}" alt="Signature of ${escapeText(entry.name)}" width="220"/></p>`,
        `<p><strong>${escapeText(entry.name)}</strong>${
          entry.title ? ` — ${escapeText(entry.title)}` : ''
        }</p>`,
        `<p>${escapeText([entry.role, entry.date].filter(Boolean).join(' · '))}</p>`,
      ];
      return lines.filter(Boolean).join('');
    })
    .join('');

  return { signatures: list, html, recorded: list.length > 0 };
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
