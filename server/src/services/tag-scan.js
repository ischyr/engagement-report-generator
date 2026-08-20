/**
 * Finding placeholders in text, and tracking which loops they sit inside.
 *
 * Two things want this: the lint, which needs a flat list of every tag with its scope, and the
 * playground, which needs the same tags with their positions so it can show them in place. They
 * have to agree — the playground looks a tag up in the lint's results by scope and name, so a
 * disagreement about where a loop opens is a tag the playground cannot explain.
 *
 * Hence one definition of "what a placeholder looks like" and one of "what it does to the stack",
 * consumed by both. This is deliberately a *diagnostic* scanner and not the parser: it tolerates a
 * mismatched closing tag, it ignores filters, and it has no opinion about whether a tag resolves.
 * The renderer's own parser is the authority on all of that.
 */

/** `{{ anything }}`, non-greedy so two tags on a line stay two tags. */
export const TAG_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

/**
 * Every placeholder in a string, in order, with where it starts and ends.
 *
 * `name` is the path with the marker and any leading dot stripped, and with filters dropped:
 * `{{ .category | default:'—' }}` is `category`, because the filter is not part of what has to
 * exist in the data.
 */
export function* eachTag(text) {
  for (const match of String(text ?? '').matchAll(TAG_RE)) {
    const raw = match[1].trim();
    const body = raw.split('|')[0].trim();
    const marker = body[0];
    const name = body.replace(/^[#^/@]+/, '').replace(/^\./, '').trim();
    yield {
      raw,
      body,
      marker,
      name,
      /** The whole `{{ … }}`, so a caller can slice the surrounding text around it. */
      source: match[0],
      start: match.index,
      end: match.index + match[0].length,
    };
  }
}

/**
 * Applies one placeholder to the loop stack, and says what it is.
 *
 * Mutates `stack`, because that is the point: the caller walks a document once and asks this about
 * each tag in turn. Returns null for something with no name at all (`{{ }}`), and `kind: 'close'`
 * for a closing tag — which is not a tag anybody needs to resolve, but is the reason the next one
 * is in an outer scope.
 */
export function stepScope(stack, { marker, name }) {
  if (!name) return null;

  if (marker === '/') {
    // Tolerant of a mismatched close: a half-written template is the normal state of one.
    const at = stack.lastIndexOf(name);
    if (at !== -1) stack.length = at;
    else stack.pop();
    return { kind: 'close', tag: name, scope: [...stack] };
  }
  if (marker === '#') {
    const opened = { kind: 'loop', tag: name, scope: [...stack] };
    stack.push(name);
    return opened;
  }
  if (marker === '^') return { kind: 'inverted', tag: name, scope: [...stack] };
  return { kind: marker === '@' ? 'rich' : 'value', tag: name, scope: [...stack] };
}

export default { TAG_RE, eachTag, stepScope };
