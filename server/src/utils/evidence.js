/**
 * How much evidence a finding carries.
 *
 * Its own module because three very different places need the same answer and must not
 * disagree about it: the report (where `evidenceCount` is a tag), the engagement list (which
 * flags findings with no screenshots), and the model that stores the count so neither of the
 * first two has to read a finding's rich text to know it.
 *
 * Counting `<img>` rather than parsing: a data URI, a stored `/api/media/<id>` and a remote
 * URL are all a picture as far as "is there any evidence here" is concerned.
 */

/** Rich-text fields that can hold evidence. PoC first, since that is where it usually is. */
export const EVIDENCE_FIELDS = ['poc', 'description', 'observation', 'remediation', 'scope'];

export function countImages(source) {
  let count = 0;
  for (const field of EVIDENCE_FIELDS) {
    const html = source?.[field];
    if (typeof html !== 'string') continue;
    count += (html.match(/<img[\s>/]/gi) ?? []).length;
  }
  return count;
}

export default countImages;
