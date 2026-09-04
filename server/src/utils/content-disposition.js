/**
 * Builds a `Content-Disposition` value that survives a non-ASCII filename.
 *
 * HTTP header values are latin1 at best, and Node refuses outright to set one
 * containing anything outside that range — so an engagement called
 * "Northwind — Portal Assessment" (em dash) or a client named "Société Générale"
 * made report generation fail with `ERR_INVALID_CHAR` *after* the document had been
 * rendered. The work was done; only the delivery broke.
 *
 * RFC 6266 is the fix: an ASCII `filename` for anything old, plus `filename*` with
 * the real name percent-encoded as UTF-8, which every current browser prefers.
 */

/**
 * Characters no filesystem wants, plus the control characters that would let a
 * filename inject a second header. Spaces are kept deliberately — they are legal
 * inside a quoted filename, and stripping them makes names harder to read.
 */
const UNSAFE = /[\\/:*?"<>|\x00-\x1f\x7f]+/g;

/**
 * Combining marks left behind by NFKD decomposition. Written as escapes rather
 * than literal characters, which are invisible in an editor and easy to mangle.
 */
const COMBINING = /[\u0300-\u036f]/g;

/**
 * @param {string} filename the name as it should ideally appear
 * @param {{type?: 'attachment'|'inline'}} [options]
 * @returns {string} a complete header value
 */
export function contentDisposition(filename, { type = 'attachment' } = {}) {
  const name =
    String(filename ?? '')
      .replace(UNSAFE, '-')
      .replace(/\s+/g, ' ')
      .trim() || 'download';

  /*
   * The fallback. Accents are decomposed first so "Société" degrades to "Societe"
   * rather than "Soci-t-" — a reader who only sees this version still gets a name
   * that means something. Anything left outside printable ASCII becomes a dash.
   */
  const ascii =
    name
      .normalize('NFKD')
      .replace(COMBINING, '')
      .replace(/[^\x20-\x7e]/g, '-')
      .replace(/-{2,}/g, '-')
      .trim() || 'download';

  // encodeURIComponent leaves ! ' ( ) * alone; RFC 5987 wants them encoded too.
  const encoded = encodeURIComponent(name).replace(
    /['()!*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );

  return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

export default contentDisposition;
