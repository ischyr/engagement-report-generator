/**
 * Fills in the snippet on library entries written before there was one.
 *
 * The same shape as the other boot migrations here: a schema change describes new documents and
 * says nothing about the ones already stored. Without this, every entry in an existing library
 * would list with no description line under its title — not broken, but quietly worse, and
 * indistinguishable from an entry whose description is genuinely empty.
 *
 * Not an aggregation pipeline, unlike the others: turning HTML into a line of text is a parse, and
 * Mongo cannot do it. So the entries that need one are read, summarised in Node and written back
 * in a single bulk write. Only those: the filter matches nothing once it has run, and an entry
 * whose description is empty gets `snippet: ''` on its first pass and is not looked at again.
 */

import { Vulnerability } from '../models/vulnerability.model.js';
import { log } from '../utils/logger.js';
import { snippetOf } from './library-payload.service.js';

export async function backfillLibrarySnippets() {
  const pending = await Vulnerability.find({ 'details.snippet': { $exists: false } })
    .select('details.description details.snippet')
    .lean();
  if (!pending.length) return 0;

  const writes = pending.map((entry) => ({
    updateOne: {
      filter: { _id: entry._id },
      update: {
        $set: Object.fromEntries(
          (entry.details ?? []).map((detail, index) => [
            `details.${index}.snippet`,
            detail.snippet ?? snippetOf(detail.description),
          ])
        ),
      },
    },
  }));

  /* An entry with no details at all has nothing to set, and an empty `$set` is an error. */
  const real = writes.filter((write) => Object.keys(write.updateOne.update.$set).length > 0);
  if (real.length) await Vulnerability.bulkWrite(real, { ordered: false });

  log.info(`Summarised ${pending.length} library entr${pending.length === 1 ? 'y' : 'ies'}`);
  return pending.length;
}

export default backfillLibrarySnippets;
