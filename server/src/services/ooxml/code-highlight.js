/**
 * Colouring the code panes in a report, conservatively.
 *
 * A proof of concept is mostly a request, a response, a command and what it printed — and in the
 * document all of it arrives as one grey slab in one colour. Word colours per run, so this costs
 * nothing structural: the same text, in more than one colour, in the pane that already exists.
 *
 * ## Conservative, because a wrong highlight is worse than none
 *
 * Nothing here parses a language. These are the four shapes that actually appear in a penetration
 * test report, recognised by their first line and marked up with rules that either match plainly or
 * do not fire:
 *
 *   http   a request or a response — the method, the path, the status, the header names
 *   json   keys, strings, numbers, and the three literals
 *   shell  the prompt, the command, its flags, and quoted arguments
 *   sql    a small set of keywords and quoted strings
 *
 * Everything else is one colour, which is what it is today. A line that does not match a rule
 * passes through untouched rather than being guessed at: the failure mode of a highlighter in a
 * client deliverable is not "dull", it is "confidently wrong about somebody's evidence".
 *
 * ## Kinds, not colours
 *
 * A token names what it is and the theme decides what that looks like, so the terminal and light
 * panes stay each other's equals and a template can eventually carry its own palette. The kinds are
 * deliberately few: a highlighter with fourteen categories needs a legend.
 *
 * ## It never changes the text
 *
 * Every token's text concatenated is the input, byte for byte, including whitespace. That is
 * asserted rather than intended — see `test:highlight` — because evidence that has been silently
 * reflowed is evidence nobody can rely on.
 */

/** What a token can be. The theme maps each of these to a colour. */
export const KINDS = ['plain', 'keyword', 'string', 'number', 'comment', 'punct', 'key', 'accent'];

/**
 * Which language a block is, from the class the editor wrote or from the text itself.
 *
 * The class wins when there is one — somebody who said `language-json` meant it. The sniff is
 * deliberately shy: it looks at the first non-empty line only, and returns `'' `rather than a guess
 * when nothing is obvious, which leaves the block in one colour.
 *
 * @param {string} text
 * @param {string} [className] e.g. `language-http`
 * @returns {'http'|'json'|'shell'|'sql'|''}
 */
export function detectLanguage(text, className = '') {
  const named = /language-(\w+)/i.exec(String(className ?? ''));
  if (named) {
    const key = named[1].toLowerCase();
    if (['http', 'json', 'sql'].includes(key)) return key;
    if (['sh', 'bash', 'shell', 'zsh', 'console', 'powershell', 'ps1'].includes(key)) return 'shell';
    return '';
  }

  const first = String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  if (!first) return '';

  /* A request line or a status line. Both are unmistakable and both are everywhere in this trade. */
  if (/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\s+\S+\s+HTTP\/\d/i.test(first)) return 'http';
  if (/^HTTP\/\d(\.\d)?\s+\d{3}/i.test(first)) return 'http';

  if (/^[[{]/.test(first)) return 'json';

  if (/^(\$|#|>|PS\s[A-Z]:)/.test(first)) return 'shell';
  if (/^(SELECT|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|WITH)\b/i.test(first)) return 'sql';

  return '';
}

/** One token. `text` is verbatim; `kind` is one of KINDS. */
const token = (text, kind = 'plain') => ({ text, kind });

/**
 * Walks a line with an ordered list of [pattern, kind] rules.
 *
 * A rule colours its **first capture group** when it has one, and its whole match when it does not
 * — so `^HTTP\/\d(?:\.\d)?\s+(\d{3})` can require the status line in order to colour the status
 * code alone. Every group that is not the target is therefore non-capturing, and that is a rule
 * about writing rules, not a detail: the first version of this took `match[0].indexOf(match[1])`
 * to find the group, and coloured the `.1` of `HTTP/1.1` because that is where `.1` first occurs.
 * The `d` flag gives the real position, so there is nothing left to get wrong.
 *
 * Anything no rule claims stays plain, and the pieces come back in source order — which is what
 * makes "the tokens rejoin to the input" true by construction rather than by care.
 */
function markUp(line, rules) {
  const marks = [];
  for (const { regex, kind } of rules) {
    /*
     * Wound back before use, because these regexes are shared across every line of every pane.
     *
     * Belt and braces as the loop stands, and said plainly rather than dressed up: a `g` regex
     * resets `lastIndex` itself when `exec` finally returns null, and the loop below always runs to
     * exhaustion — so nothing is carried between lines today, and removing this line changes no
     * result. It is here for the version of this loop that grows a `break`, which is the one that
     * would start a line half way through and colour the wrong span with no error anywhere.
     *
     * The compilation is the part that was worth moving out: five rules over four hundred lines
     * was two thousand `new RegExp` calls for a single pane, and a red team chapter is sixty panes.
     * Measured at 259ms before and 138ms after, over sixty steps of four hundred lines.
     */
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(line)) !== null) {
      if (match[0] === '') {
        regex.lastIndex += 1;
        continue;
      }
      const span = match.indices[1] ?? match.indices[0];
      if (!span) continue;
      const [start, end] = span;
      /* First rule to claim a span keeps it, so earlier rules are the stronger ones. */
      if (start !== end && !marks.some((mark) => start < mark.end && end > mark.start)) {
        marks.push({ start, end, kind });
      }
    }
  }

  marks.sort((a, b) => a.start - b.start);
  const out = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) out.push(token(line.slice(at, mark.start)));
    out.push(token(line.slice(mark.start, mark.end), mark.kind));
    at = mark.end;
  }
  if (at < line.length) out.push(token(line.slice(at)));
  return out;
}

/**
 * The rules, in the order they get to claim.
 *
 * Earlier wins an overlap, so the more specific rule goes first. Every group that is not the thing
 * being coloured is `(?:…)` — see `markUp`.
 */
const RULES = {
  http: [
    /* The status code, before the rule that claims the rest of the status line. */
    [/^HTTP\/\d(?:\.\d)?\s+(\d{3})/, 'accent'],
    [/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE|CONNECT)\b/, 'keyword'],
    [/^HTTP\/\d(?:\.\d)?/, 'keyword'],
    /* A header name, which is the column a reader scans. The colon stays plain. */
    [/^([A-Za-z][A-Za-z0-9-]*):/, 'key'],
    [/"[^"]*"/, 'string'],
  ],
  json: [
    /* A key is the quoted string *before a colon*; the colon itself is not part of it. */
    [/("(?:[^"\\]|\\.)*")\s*:/, 'key'],
    [/"(?:[^"\\]|\\.)*"/, 'string'],
    [/\b(?:true|false|null)\b/, 'keyword'],
    [/-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/, 'number'],
    [/[{}[\],]/, 'punct'],
  ],
  shell: [
    /*
     * The prompt, including a root `#`.
     *
     * Which means a line starting `# ` is read as a root shell rather than as a comment, and that
     * is the right way round here: in tool output pasted into a report, `# id` is overwhelmingly
     * somebody who got root, not somebody annotating their transcript.
     */
    [/^\s*(\$|#|>|PS\s[A-Z]:\\[^>]*>)/, 'punct'],
    [/#.*$/, 'comment'],
    [/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/, 'string'],
    /* A flag, which is what somebody re-running this actually reads. */
    [/(?<=\s)--?[A-Za-z][\w-]*/, 'keyword'],
    [/\|/, 'punct'],
  ],
  sql: [
    [/--.*$/, 'comment'],
    [
      /\b(?:SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AND|OR|NOT|NULL|ORDER|GROUP|BY|LIMIT|UNION|ALL|AS|CREATE|ALTER|DROP|TABLE|WITH)\b/i,
      'keyword',
    ],
    [/'(?:[^'\\]|\\.)*'/, 'string'],
    [/\b\d+\b/, 'number'],
  ],
};

/**
 * The same rules, compiled once.
 *
 * `g` so a rule claims every occurrence on the line rather than the first, and `d` so `markUp` can
 * read a capture group's real position instead of searching for its text. Both are added here so a
 * rule above can be written as the plain expression it is, and so neither can be forgotten.
 *
 * Module-level and shared, which is safe because conversion is synchronous — `markUp` winds
 * `lastIndex` back before every use and nothing yields in between. If this file ever grows an
 * `await`, that assumption goes with it.
 */
const COMPILED = Object.fromEntries(
  Object.entries(RULES).map(([language, rules]) => [
    language,
    rules.map(([pattern, kind]) => ({
      regex: new RegExp(pattern.source, [...new Set([...pattern.flags, 'g', 'd'])].join('')),
      kind,
    })),
  ])
);

/**
 * One code block, as coloured tokens.
 *
 * Line by line, because every rule here is a line-shaped rule — a status line, a header, a prompt —
 * and because a regex let loose on a whole block is how a highlighter starts matching across a
 * newline and colouring something nobody wrote.
 *
 * Newlines come back as their own plain tokens so the caller can rejoin them exactly.
 *
 * @param {string} text
 * @param {string} [language] from `detectLanguage`
 * @returns {{text: string, kind: string}[]}
 */
export function highlight(text, language = '') {
  const source = String(text ?? '');
  const rules = COMPILED[language];
  if (!rules) return source ? [token(source)] : [];

  const out = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    if (index > 0) out.push(token('\n'));
    if (line === '') continue;
    out.push(...markUp(line, rules));
  }
  return out;
}

export default highlight;
