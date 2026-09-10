/**
 * An engagement's delivery record, shaped for a report.
 *
 * Pentest reports carry a document-control page — version, date, who it went to — and it is
 * kept by hand, which is why it is so often a version behind the document it sits in. This
 * is the same table from the record the team actually maintains.
 *
 * A query, so it is passed into `buildReportData()` rather than read there, exactly like
 * finding history and effort.
 */

import { Delivery } from '../models/delivery.model.js';

/**
 * @param {import('mongoose').Types.ObjectId|string} auditId
 * @param {(value: any) => string} formatDate how the instance writes dates
 */
export async function deliveriesFor(auditId, formatDate = (value) => String(value ?? '')) {
  const rows = await Delivery.find({ audit: auditId }).sort({ sentAt: 1 });

  const list = rows.map((row) => ({
    version: row.version,
    /** Formatted with the instance's own date format, like every other date in a report. */
    date: formatDate(row.sentAt),
    /** The raw instant too, for a template that wants a time or its own formatting. */
    sentAt: row.sentAt,
    channel: row.channel,
    recipients: (row.recipients ?? []).map((entry) => ({
      name: entry.name,
      email: entry.email,
    })),
    /** "A. Turner, procurement@acme.example" — a table cell rather than a loop. */
    recipientList: (row.recipients ?? [])
      .map((entry) => entry.name || entry.email)
      .filter(Boolean)
      .join(', '),
    filename: row.filename,
    fileHash: row.fileHash,
    /** The first twelve characters, which is what a document-control table can fit. */
    fileHashShort: row.fileHash ? row.fileHash.slice(0, 12) : '',
    hashAlgorithm: row.hashAlgorithm,
    note: row.note,
  }));

  return {
    deliveries: list,
    /** The most recent one, for "Version 1.1, issued 6 August 2026". */
    lastDelivery: list.length ? list[list.length - 1] : null,
    recorded: list.length > 0,
  };
}

export default deliveriesFor;
