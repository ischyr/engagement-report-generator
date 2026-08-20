/**
 * Minimal, dependency-free HTML parser producing a lightweight tree.
 *
 * It only needs to cope with the markup our editor emits (a well-behaved
 * subset), so it favours predictability over full HTML5 error recovery: an
 * unmatched close tag is ignored rather than restructuring the tree.
 *
 * Node shapes:
 *   { type: 'element', tag, attrs: {}, children: [] }
 *   { type: 'text', value }
 */

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/**
 * Tags that implicitly close a still-open sibling of the same kind — and where to stop
 * looking for one.
 *
 * The scope is the whole point. HTML says an `<li>` closes an open `<li>`, but only one in
 * the *same list*: in `<ol><li>Step one<ul><li>a bullet</li></ul></li>` the inner `<li>`
 * belongs to the `<ul>` and must not reach past it to the outer item. Without that boundary
 * the search found the outer `<li>`, truncated the stack to it, and threw away the `<ul>` on
 * the way — so nested bullets came out as extra *numbered* items of the parent list, at the
 * parent's level, silently shifting every number after them. Word rendered exactly what it
 * was given: "1, 2, 3, 4, 5" where the document meant "1, (two bullets), 2".
 *
 * The same rule applies to cells and rows, where the enclosing row or table is the boundary,
 * and to paragraphs, which cannot escape the block they are in.
 */
const AUTO_CLOSE = {
  li: { closes: new Set(['li']), stopAt: new Set(['ul', 'ol', 'menu']) },
  p: {
    closes: new Set(['p']),
    stopAt: new Set([
      'li', 'td', 'th', 'blockquote', 'div', 'section', 'article', 'aside',
      'header', 'footer', 'main', 'figure', 'table', 'dd', 'dt',
    ]),
  },
  td: { closes: new Set(['td', 'th']), stopAt: new Set(['tr', 'table']) },
  th: { closes: new Set(['td', 'th']), stopAt: new Set(['tr', 'table']) },
  tr: { closes: new Set(['tr']), stopAt: new Set(['table', 'tbody', 'thead', 'tfoot']) },
};

/**
 * The index of the element this tag implicitly closes, or -1.
 *
 * Walks down from the top of the stack and gives up at the first scope boundary, so a tag
 * can only close a sibling it is genuinely a sibling of.
 */
function implicitCloseIndex(stack, rule) {
  for (let index = stack.length - 1; index > 0; index -= 1) {
    const node = stack[index];
    if (node.type !== 'element') continue;
    if (rule.closes.has(node.tag)) return index;
    if (rule.stopAt.has(node.tag)) return -1;
  }
  return -1;
}

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  hellip: '…', mdash: '—', ndash: '–', laquo: '«',
  raquo: '»', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', bull: '•', middot: '·', copy: '©',
  reg: '®', trade: '™', deg: '°', plusmn: '±',
  times: '×', divide: '÷', euro: '€', pound: '£',
  larr: '←', rarr: '→', harr: '↔', check: '✓',
};

export function decodeEntities(input) {
  if (!input || input.indexOf('&') === -1) return input ?? '';
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, body) => {
    if (body[0] === '#') {
      const code =
        body[1] === 'x' || body[1] === 'X'
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      if (Number.isFinite(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

function parseAttributes(source) {
  const attrs = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'`=<>]+)))?/g;
  let match = re.exec(source);
  while (match) {
    const name = match[1].toLowerCase();
    const raw = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeEntities(raw);
    match = re.exec(source);
  }
  return attrs;
}

/** Parses a `style="a:b;c:d"` attribute into a lower-cased property map. */
export function parseStyle(styleAttr) {
  const out = {};
  if (!styleAttr) return out;
  for (const decl of styleAttr.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const value = decl.slice(idx + 1).trim();
    if (prop) out[prop] = value;
  }
  return out;
}

export function parseHtml(html) {
  const root = { type: 'root', children: [] };
  if (typeof html !== 'string' || html.trim() === '') return root;

  const stack = [root];
  const top = () => stack[stack.length - 1];
  const pushText = (value) => {
    if (value === '') return;
    top().children.push({ type: 'text', value: decodeEntities(value) });
  };

  let i = 0;
  const len = html.length;

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) {
      pushText(html.slice(i));
      break;
    }
    if (lt > i) pushText(html.slice(i, lt));

    // Comment / CDATA / doctype — skipped wholesale.
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end === -1 ? len : end + 3;
      continue;
    }
    if (html.startsWith('<!', lt) || html.startsWith('<?', lt)) {
      const end = html.indexOf('>', lt);
      i = end === -1 ? len : end + 1;
      continue;
    }

    // Closing tag
    if (html.startsWith('</', lt)) {
      const end = html.indexOf('>', lt);
      if (end === -1) {
        pushText(html.slice(lt));
        break;
      }
      const tag = html.slice(lt + 2, end).trim().toLowerCase();
      const depth = stack.findLastIndex((n) => n.type === 'element' && n.tag === tag);
      if (depth > 0) stack.length = depth;
      i = end + 1;
      continue;
    }

    // Opening tag — find the '>' that is not inside a quoted attribute value.
    let cursor = lt + 1;
    let quote = null;
    let end = -1;
    while (cursor < len) {
      const ch = html[cursor];
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        end = cursor;
        break;
      }
      cursor += 1;
    }
    if (end === -1) {
      pushText(html.slice(lt));
      break;
    }

    let inner = html.slice(lt + 1, end);
    const selfClosing = inner.endsWith('/');
    if (selfClosing) inner = inner.slice(0, -1);

    const spaceIdx = inner.search(/\s/);
    const tag = (spaceIdx === -1 ? inner : inner.slice(0, spaceIdx)).toLowerCase();
    if (!/^[a-zA-Z][-a-zA-Z0-9:]*$/.test(tag)) {
      // Not a tag after all — e.g. prose containing "if (a < b)". Emit the "<"
      // as text and carry on from just after it, so the rest is re-examined
      // normally. Skipping to `end` here would silently swallow the sentence.
      pushText('<');
      i = lt + 1;
      continue;
    }
    const attrs = spaceIdx === -1 ? {} : parseAttributes(inner.slice(spaceIdx));

    const autoClose = AUTO_CLOSE[tag];
    if (autoClose) {
      const openIdx = implicitCloseIndex(stack, autoClose);
      if (openIdx > 0) stack.length = openIdx;
    }

    const node = { type: 'element', tag, attrs, children: [] };
    top().children.push(node);

    if (!selfClosing && !VOID_TAGS.has(tag)) {
      stack.push(node);
      // <script>/<style> bodies are raw text; drop them entirely.
      if (tag === 'script' || tag === 'style') {
        const closeIdx = html.toLowerCase().indexOf(`</${tag}`, end + 1);
        node.children = [];
        stack.pop();
        i = closeIdx === -1 ? len : html.indexOf('>', closeIdx) + 1;
        continue;
      }
    }

    i = end + 1;
  }

  return root;
}

/** Flattens a tree (or HTML string) to plain text, block tags becoming newlines. */
export function htmlToPlainText(input) {
  const tree = typeof input === 'string' ? parseHtml(input) : input;
  const BLOCK = new Set([
    'p', 'div', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'blockquote', 'pre', 'tr', 'ul', 'ol', 'table', 'section', 'header', 'footer',
  ]);
  let out = '';
  const walk = (node) => {
    if (node.type === 'text') {
      out += node.value;
      return;
    }
    if (node.type === 'element') {
      if (node.tag === 'br') {
        out += '\n';
        return;
      }
      if (node.tag === 'img') return;
      if (node.tag === 'td' || node.tag === 'th') {
        node.children.forEach(walk);
        out += '\t';
        return;
      }
    }
    const isBlock = node.type === 'element' && BLOCK.has(node.tag);
    if (isBlock && out !== '' && !out.endsWith('\n')) out += '\n';
    node.children?.forEach(walk);
    if (isBlock && !out.endsWith('\n')) out += '\n';
  };
  walk(tree);
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

export default { parseHtml, parseStyle, decodeEntities, htmlToPlainText };
