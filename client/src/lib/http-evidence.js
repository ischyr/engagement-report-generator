/**
 * Turning a pasted HTTP exchange into evidence.
 *
 * The proof of concept for a web finding is nearly always a request and the response it got, and
 * until now the only way to put one in a report was a screenshot of a terminal or Burp — an image
 * of text, which cannot be copied, searched, or read at all in a printed report at anything under
 * full size. Pasted as text it fared no better: the editor took it as prose, so the headers
 * reflowed into a paragraph and the whole thing became unreadable.
 *
 * So a paste that looks like HTTP becomes two labelled code blocks instead. The text is kept
 * exactly as it was pasted — an exchange somebody has "tidied" is not evidence — and the labels
 * are ordinary bold paragraphs, which means this renders in Word and in the HTML report through
 * the paths that already exist, with no template change and nothing new to support.
 */

/** `GET /path HTTP/1.1` — the methods worth recognising, plus anything else all-caps and short. */
const REQUEST_LINE = /^([A-Z]{3,10})\s+(\S+)\s+HTTP\/\d(?:\.\d)?\s*$/m;
/** `HTTP/1.1 200 OK`, or HTTP/2's status line with no reason phrase. */
const STATUS_LINE = /^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s+.*)?$/m;

/** Whether a pasted string is worth treating as an exchange rather than as prose. */
export function looksLikeHttp(text) {
  const value = String(text ?? '');
  // Two lines minimum: a single "GET /" in a sentence is prose, not evidence.
  if (!value.includes('\n')) return false;
  return REQUEST_LINE.test(value) || STATUS_LINE.test(value);
}

/**
 * Splits a paste into its request and response halves.
 *
 * The split is the first status line that starts a line, because that is what every tool that
 * prints both — Burp, curl -i piped after the request, an intercepting proxy's log — puts between
 * them. A paste with only one half is normal and comes back with the other empty: half an exchange
 * is still better evidence than a picture of it.
 */
export function parseHttpExchange(text) {
  const value = String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  if (!value) return { request: '', response: '' };

  const lines = value.split('\n');
  const statusAt = lines.findIndex((line, index) => index > 0 && STATUS_LINE.test(line));

  if (statusAt > 0) {
    return {
      request: lines.slice(0, statusAt).join('\n').replace(/\s+$/, ''),
      response: lines.slice(statusAt).join('\n').replace(/\s+$/, ''),
    };
  }
  // No split found: whichever kind of line it opens with decides which half it is.
  if (STATUS_LINE.test(lines[0] ?? '')) return { request: '', response: value };
  return { request: value, response: '' };
}

const escapeHtml = (text) =>
  String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

/**
 * The markup one half becomes: a bold label, then a code block.
 *
 * A `<p><strong>` rather than a heading, because a proof of concept sits inside a finding and a
 * heading there would land in the report's contents list. `<pre>` carries a class the app styles
 * and the Word converter ignores — it renders the code block either way.
 */
function half(label, body, kind) {
  if (!body) return '';
  return (
    `<p class="http-label"><strong>${escapeHtml(label)}</strong></p>` +
    `<pre class="http-${kind}">${escapeHtml(body)}</pre>`
  );
}

/** `{ request, response }` as the HTML to insert. Empty halves are left out entirely. */
export function httpExchangeHtml({ request, response }) {
  return `${half('Request', request, 'request')}${half('Response', response, 'response')}`;
}

/** An empty pair, for writing one out by hand rather than pasting it. */
export function blankHttpExchange() {
  return httpExchangeHtml({
    request: 'GET /path HTTP/1.1\nHost: example.com',
    response: 'HTTP/1.1 200 OK\nContent-Type: application/json',
  });
}

export default { looksLikeHttp, parseHttpExchange, httpExchangeHtml, blankHttpExchange };
