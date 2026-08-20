/**
 * The template expression language.
 *
 * Tag syntax is `{{ .PATH }}` — a leading dot is optional and stripped, so
 * `{{ .title }}` and `{{ title }}` are the same tag. Expressions are evaluated
 * with angular-expressions, which gives us property paths, arithmetic and
 * filters (`{{ .date | date:'dd/MM/yyyy' }}`).
 *
 * Sections use the docxtemplater prefixes, written without a space so the
 * prefix character stays adjacent to the delimiter:
 *   {{#findings}} … {{/findings}}     loop
 *   {{^findings}} … {{/findings}}     inverted (renders when empty/falsy)
 *   {{@rich.description}}             raw WordprocessingML
 *
 * Some filters produce WordprocessingML rather than text — hyperlinks, bookmarks,
 * cross-references. Those must be used in a raw tag, and a raw tag replaces the whole
 * paragraph, so a run-level value needs wrapping: `{{@ .name | link:.url | p }}`. The `p`
 * filter is what turns runs into a paragraph, and every filter that emits markup escapes
 * its text, because a client called "Smith & Sons" would otherwise produce a document Word
 * refuses to open.
 */

import expressions from 'angular-expressions';
// The plain-text reader, for the one filter that has to look inside a rich-text field. Reusing
// it rather than stripping tags here keeps one entity table in the codebase: a paragraph holding
// "Smith &amp; Sons" has to come out as "Smith & Sons", and a second decoder would have got that
// wrong the first time an entity was added to one and not the other.
import { htmlToPlainText } from './ooxml/html-parser.js';

export const DELIMITERS = { start: '{{', end: '}}' };

/* -------------------------------------------------------------------------- */
/* Filters                                                                     */
/* -------------------------------------------------------------------------- */

const pad = (n, width = 2) => String(n).padStart(width, '0');

/**
 * The same escaping the OOXML writer uses.
 *
 * Duplicated deliberately rather than imported from `ooxml/html2ooxml.js`: this module is the
 * template *language* and must not depend on the document writer, and both are three lines
 * that can never be allowed to disagree — the test suite renders a value containing every one
 * of these characters through both.
 */
const escapeXml = (value) =>
  String(value ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFFE\uFFFF]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** Whether a value is already WordprocessingML rather than text needing a run around it. */
const isMarkup = (value) => /^\s*<w:(r|hyperlink|bookmarkStart|fldSimple|p)\b/.test(String(value ?? ''));

/** Text as a single run, escaped, preserving the spaces a template author typed. */
const asRun = (value) =>
  isMarkup(value)
    ? String(value)
    : `<w:r><w:t xml:space="preserve">${escapeXml(value)}</w:t></w:r>`;

/**
 * A bookmark name Word will accept.
 *
 * Word allows letters, digits and underscores, up to 40 characters, and silently drops a
 * bookmark whose name breaks either rule — which is the sort of failure that shows up as a
 * cross-reference reading "Error! Bookmark not defined" in a document already sent.
 */
const bookmarkName = (value) =>
  String(value ?? '')
    .replace(/[^a-zA-Z0-9_]/g, '_')
    .slice(0, 40) || 'bookmark';

/*
 * Bookmark ids, counted rather than random.
 *
 * They only have to be unique inside one document, and a counter makes two renders of the
 * same engagement byte-identical — which the delivery record depends on, since it hashes the
 * file it sent. Reset per render by `createParser`.
 */
let bookmarkSeq = 0;
let bookmarksSeen = new Set();

/** Called once per generation, so ids restart and duplicate names are detected per document. */
export function resetBookmarks() {
  bookmarkSeq = 0;
  bookmarksSeen = new Set();
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Formats a date with a Word-friendly subset of the usual pattern letters:
 * yyyy yy MMMM MMM MM M dd d EEEE EEE HH mm ss
 */
export function formatDate(value, pattern = 'yyyy-MM-dd') {
  if (value === null || value === undefined || value === '') return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);

  const tokens = {
    yyyy: String(date.getFullYear()),
    yy: pad(date.getFullYear() % 100),
    MMMM: MONTHS[date.getMonth()],
    MMM: MONTHS[date.getMonth()].slice(0, 3),
    MM: pad(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad(date.getDate()),
    d: String(date.getDate()),
    EEEE: DAYS[date.getDay()],
    EEE: DAYS[date.getDay()].slice(0, 3),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    ss: pad(date.getSeconds()),
  };
  return pattern.replace(/yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE|HH|mm|ss/g, (t) => tokens[t]);
}

let filtersRegistered = false;

export function registerFilters(options = {}) {
  if (filtersRegistered) return expressions.filters;
  const f = expressions.filters;

  f.upper = (input) => String(input ?? '').toUpperCase();
  f.lower = (input) => String(input ?? '').toLowerCase();
  f.capitalize = (input) => {
    const s = String(input ?? '');
    return s.charAt(0).toUpperCase() + s.slice(1);
  };
  f.title = (input) =>
    String(input ?? '').replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
  f.trim = (input) => String(input ?? '').trim();
  f.default = (input, fallback = '') =>
    input === null || input === undefined || input === '' ? fallback : input;
  f.date = (input, pattern) => formatDate(input, pattern ?? options.dateFormat ?? 'yyyy-MM-dd');
  f.join = (input, separator = ', ') => (Array.isArray(input) ? input.filter(Boolean).join(separator) : String(input ?? ''));
  f.length = (input) => (Array.isArray(input) || typeof input === 'string' ? input.length : 0);
  f.fixed = (input, digits = 1) => {
    const n = Number(input);
    return Number.isFinite(n) ? n.toFixed(Number(digits)) : '';
  };
  f.pad = (input, width = 2) => pad(input ?? '', Number(width));
  f.truncate = (input, max = 80, suffix = '…') => {
    const s = String(input ?? '');
    return s.length <= Number(max) ? s : s.slice(0, Number(max)) + suffix;
  };
  f.replace = (input, search, replacement = '') =>
    String(input ?? '').split(String(search)).join(String(replacement));
  f.first = (input) => (Array.isArray(input) ? input[0] : input);
  f.last = (input) => (Array.isArray(input) ? input[input.length - 1] : input);
  f.reverse = (input) => (Array.isArray(input) ? [...input].reverse() : String(input ?? '').split('').reverse().join(''));
  /** Keeps only items whose `path` equals `value` — `findings | where:'severity':'High'` */
  f.where = (input, path, value) => {
    if (!Array.isArray(input)) return input;
    return input.filter((item) => String(getPath(item, path)) === String(value));
  };
  f.sortBy = (input, path, direction = 'asc') => {
    if (!Array.isArray(input)) return input;
    const dir = direction === 'desc' ? -1 : 1;
    return [...input].sort((a, b) => {
      const x = getPath(a, path);
      const y = getPath(b, path);
      if (x === y) return 0;
      return (x > y ? 1 : -1) * dir;
    });
  };

  /* ------------------------------------------------------------------ collections */

  /**
   * Groups a list by a field, for `{{#findings | groupBy:'severity'}}`.
   *
   * Returns `{key, value, count}` rows so a template can print the heading and loop the
   * members: `{{key}} ({{count}}) … {{#value}}`.
   *
   * Severity groups come back in severity order, not alphabetically. "Critical, High, Low,
   * Medium, None" is what sorting the words gives you, and it is wrong in the one place this
   * filter will be used most — a template author should not have to know that.
   */
  const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'None', 'Info'];
  f.groupBy = (input, path) => {
    if (!Array.isArray(input)) return [];
    const groups = new Map();
    for (const item of input) {
      const raw = getPath(item, path);
      const key = raw === null || raw === undefined || raw === '' ? '' : String(raw);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const keys = [...groups.keys()];
    const known = keys.every((key) => key === '' || SEVERITY_ORDER.includes(key));
    keys.sort((a, b) => {
      // An empty key is "ungrouped" and belongs last whichever ordering applies.
      if (a === '') return 1;
      if (b === '') return -1;
      return known
        ? SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b)
        : a.localeCompare(b);
    });
    return keys.map((key) => ({
      key,
      /** Blank keys are worth printing as something rather than as a gap. */
      label: key === '' ? 'Ungrouped' : key,
      value: groups.get(key),
      count: groups.get(key).length,
    }));
  };

  /** An object as `{key, value}` rows, so `{{#severityCounts | loopObject}}` can be looped. */
  f.loopObject = (input) =>
    input && typeof input === 'object' && !Array.isArray(input)
      ? Object.keys(input).map((key) => ({ key, label: key, value: input[key] }))
      : [];

  /** Plucks one field from every item: `{{ .findings | select:'title' | join:', ' }}`. */
  f.select = (input, path) =>
    Array.isArray(input) ? input.map((item) => getPath(item, path)).filter((v) => v !== undefined) : [];

  /** Distinct values, order preserved — the first spelling of a repeat is the one kept. */
  f.unique = (input) => (Array.isArray(input) ? [...new Set(input.map((v) => (v && typeof v === 'object' ? JSON.stringify(v) : v)))].map((v) => {
    try {
      return typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v;
    } catch {
      return v;
    }
  }) : []);

  /** Applies another filter to every item: `{{ .team | select:'fullname' | map:'upper' }}`. */
  f.map = (input, filter, ...args) => {
    if (!Array.isArray(input) || typeof f[filter] !== 'function') return input;
    return input.map((item) => f[filter](item, ...args));
  };

  /**
   * How many items match, or how many there are.
   *
   * `{{ .findings | count:'severity':'High' }}` and `{{ .findings | count }}`. The report data
   * already carries `severityCounts`, but a template that groups by anything else — a category,
   * a host, a remediation status — needed a way to count its own groups.
   */
  f.count = (input, path, value) => {
    if (!Array.isArray(input)) return 0;
    if (path === undefined) return input.length;
    return input.filter((item) => String(getPath(item, path)) === String(value)).length;
  };

  /** Totals a numeric field: `{{ .effort.people | sum:'hours' }}`. */
  f.sum = (input, path) => {
    if (!Array.isArray(input)) return 0;
    const total = input.reduce((acc, item) => {
      const n = Number(path === undefined ? item : getPath(item, path));
      return acc + (Number.isFinite(n) ? n : 0);
    }, 0);
    // Two decimals, then trimmed: hours are quarters and 7.249999999999999 is not a number
    // anybody wants printed in a report.
    return Math.round(total * 100) / 100;
  };

  /**
   * Splits a value into lines, for looping.
   *
   * Handles both shapes a field can hold in this app: editor HTML, where each paragraph is a
   * line, and plain multi-line text. `{{#scope | lines}}{{.}}{{/scope}}` prints one host per
   * paragraph without the template author caring which shape it was stored in.
   */
  f.lines = (input) => {
    const text = String(input ?? '');
    if (text === '') return [];
    const plain = /<[a-z][^>]*>/i.test(text) ? htmlToPlainText(text) : text;
    return plain
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  };

  /* ------------------------------------------------------------------ text + dates */

  /** "Iulian Schifirnet" → "I.S." — for a signature line or a tester column. */
  f.initials = (input) =>
    String(input ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => `${word[0].toUpperCase()}.`)
      .join('');

  /**
   * A date range said the way people say it.
   *
   * "12 – 16 August 2026" rather than "2026-08-12 to 2026-08-16": the parts both dates share
   * are printed once. Same month collapses to the day, same year to the day and month, and a
   * single day drops the range entirely — which is what makes an engagement window readable in
   * a sentence.
   */
  f.fromTo = (start, end, pattern) => {
    const from = start instanceof Date ? start : new Date(start);
    const to = end instanceof Date ? end : new Date(end);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return formatDate(start, pattern ?? options.dateFormat);
    }
    const full = pattern ?? 'd MMMM yyyy';
    if (from.getTime() === to.getTime()) return formatDate(from, full);
    if (from.getFullYear() !== to.getFullYear()) {
      return `${formatDate(from, full)} – ${formatDate(to, full)}`;
    }
    if (from.getMonth() !== to.getMonth()) {
      return `${formatDate(from, 'd MMMM')} – ${formatDate(to, full)}`;
    }
    return `${formatDate(from, 'd')} – ${formatDate(to, full)}`;
  };

  /** What a tag actually holds, for working out why a template prints nothing. */
  f.toJSON = (input) => JSON.stringify(input ?? null);

  /* ------------------------------------------------------------------ WordprocessingML */

  /** Text as a run. Only useful as a step towards `p`. */
  f.run = (input) => asRun(input);

  /** Runs as a paragraph, optionally in one of the template's styles. */
  f.p = (input, style) => {
    const properties = style ? `<w:pPr><w:pStyle w:val="${escapeXml(String(style).replace(/\s+/g, ''))}"/></w:pPr>` : '';
    return `<w:p>${properties}${asRun(input)}</w:p>`;
  };

  /**
   * A real Word hyperlink, as a field rather than a relationship.
   *
   * A `w:hyperlink` element needs an entry in the document's relationship part; a HYPERLINK
   * *field* carries its target inline, so a filter can produce one without reaching into the
   * package. Word renders both identically and follows both.
   */
  f.link = (input, url) => {
    const target = escapeXml(url ?? input);
    return (
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> HYPERLINK "${target}" </w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>' +
      `<w:t xml:space="preserve">${escapeXml(input)}</w:t></w:r>` +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    );
  };

  f.mailto = (input, address) => f.link(input, `mailto:${address ?? input}`);

  /**
   * Marks a place in the document so something else can point at it.
   *
   * With one argument the text is bookmarked *and* printed; the name defaults to the text
   * itself. Two arguments name the bookmark explicitly, which is what a loop needs:
   * `{{@ .title | bookmark:.identifier | p:'Heading2' }}`.
   *
   * A name used twice is emitted once. Word resolves a duplicate name to whichever it meets
   * first and ignores the rest, so pretending otherwise would produce a document whose
   * cross-references point somewhere the template author did not intend.
   */
  f.bookmark = (input, name) => {
    const label = bookmarkName(name ?? input);
    const body = asRun(input);
    if (bookmarksSeen.has(label)) return body;
    bookmarksSeen.add(label);
    bookmarkSeq += 1;
    const id = bookmarkSeq;
    return `<w:bookmarkStart w:id="${id}" w:name="${label}"/>${body}<w:bookmarkEnd w:id="${id}"/>`;
  };

  /** A clickable jump to a bookmark, showing your own words. */
  f.bookmarkLink = (input, name) =>
    `<w:hyperlink w:anchor="${bookmarkName(name ?? input)}">` +
    '<w:r><w:rPr><w:rStyle w:val="Hyperlink"/></w:rPr>' +
    `<w:t xml:space="preserve">${escapeXml(input)}</w:t></w:r></w:hyperlink>`;

  /**
   * A cross-reference Word keeps up to date: "see VULN-03 on page 12".
   *
   * A REF field rather than the text, so renumbering a finding and pressing F9 fixes every
   * mention of it. The text between `separate` and `end` is what a reader sees until Word
   * refreshes fields, so it is filled in with the same value rather than left blank.
   */
  f.ref = (input, name) => {
    const label = bookmarkName(name ?? input);
    return (
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> REF ${label} \\h </w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      `<w:r><w:t xml:space="preserve">${escapeXml(input)}</w:t></w:r>` +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    );
  };

  /** The page a bookmark ended up on, which is the other half of "see X on page Y". */
  f.pageRef = (input, name) => {
    const label = bookmarkName(name ?? input);
    return (
      '<w:r><w:fldChar w:fldCharType="begin"/></w:r>' +
      `<w:r><w:instrText xml:space="preserve"> PAGEREF ${label} \\h </w:instrText></w:r>` +
      '<w:r><w:fldChar w:fldCharType="separate"/></w:r>' +
      '<w:r><w:t>1</w:t></w:r>' +
      '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    );
  };

  filtersRegistered = true;
  return f;
}

function getPath(object, path) {
  if (!object || !path) return undefined;
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc === null || acc === undefined ? undefined : acc[key]), object);
}

/* -------------------------------------------------------------------------- */
/* Tag normalisation                                                           */
/* -------------------------------------------------------------------------- */

/** Prefix characters docxtemplater uses to select a module. */
const PREFIX_CHARS = new Set(['#', '/', '^', '@', '-', '+', '>', ':', '%']);
const NBSP = / /g;

/** Moves any module prefix flush against the braces and trims the rest. */
function canonicaliseTag(raw) {
  const trimmed = raw.replace(NBSP, ' ').trim();
  if (trimmed === '') return trimmed;
  const prefix = PREFIX_CHARS.has(trimmed[0]) ? trimmed[0] : '';
  return prefix + trimmed.slice(prefix.length).trim();
}

/**
 * docxtemplater picks a module by looking at the *first* character inside the
 * delimiters, so `{{ #findings }}` would silently be read as a plain value and
 * render as nothing — a nasty trap, since the template looks correct. This
 * module runs during preparse, before module matching, and rewrites each tag to
 * its canonical form.
 *
 * The effect is that `{{ #findings }}`, `{{#findings }}` and `{{#findings}}` all
 * behave identically, and an opening tag written with spaces still pairs with a
 * closing tag written without them.
 *
 * At this stage a tag is not a single token yet: it is the run of `content`
 * tokens between a start and an end `delimiter` token, which Word may have split
 * across several runs. The joined text is normalised onto the first token and the
 * remainder blanked, which keeps token indices — and therefore error offsets —
 * intact.
 *
 * Returns a new instance per call: docxtemplater refuses to attach the same
 * module object to two documents.
 */
export function createTagNormaliser() {
  return {
    name: 'EngyTagNormaliser',
    preparse(parsed) {
      if (!Array.isArray(parsed)) return parsed;
      let startIndex = -1;

      for (let i = 0; i < parsed.length; i += 1) {
        const token = parsed[i];
        if (token?.type !== 'delimiter') continue;

        if (token.position === 'start') {
          startIndex = i;
          continue;
        }
        if (token.position !== 'end' || startIndex === -1) continue;

        /*
         * `insidetag` only. A `content` token between the delimiters is not always tag text: when
         * Word has split a tag across runs, the run break itself arrives as `content` with
         * position `outsidetag`, holding raw markup — `<w:proofErr/>`, the contents of a
         * `<w:rPr>`. Joining those in makes the tag name `.stats.total<w:proofErr…><w:rFonts…>`,
         * which resolves to nothing, and blanking them afterwards deletes the run's formatting.
         *
         * That is not a hypothetical: Word splits a tag whenever its grammar checker sees a
         * sentence boundary inside one, so the failure appears the first time somebody opens a
         * template, saves it, and uploads it again — a report with blank numbers where the
         * template looks perfectly correct in Word.
         */
        const contentIndices = [];
        for (let j = startIndex + 1; j < i; j += 1) {
          const candidate = parsed[j];
          if (
            candidate?.type === 'content' &&
            candidate.position === 'insidetag' &&
            typeof candidate.value === 'string'
          ) {
            contentIndices.push(j);
          }
        }
        startIndex = -1;
        if (contentIndices.length === 0) continue;

        const raw = contentIndices.map((j) => parsed[j].value).join('');
        const canonical = canonicaliseTag(raw);
        if (canonical === raw) continue;

        parsed[contentIndices[0]].value = canonical;
        for (let k = 1; k < contentIndices.length; k += 1) parsed[contentIndices[k]].value = '';
      }

      return parsed;
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Parser                                                                      */
/* -------------------------------------------------------------------------- */

const SMART_QUOTES = /[‘’‛′]/g;
const SMART_DQUOTES = /[“”„″]/g;

/** An empty paragraph carrying a page break — what `$pageBreakExceptLast` resolves to. */
const PAGE_BREAK = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

/**
 * Where the current item sits in its loop.
 *
 * Two engines ask this. docxtemplater reports the position through `context.scopePathItem`
 * and `context.scopePathLength`; the HTML renderer puts the counters straight on the scope.
 * Whatever the scope already carries wins, or the second engine's counters would be
 * overwritten with the first iteration's values — a bug that showed up as every finding in
 * the HTML report being numbered 1.
 *
 * `$total` is the length of the innermost loop, so `$number` of `$total` reads correctly
 * inside a nested loop rather than counting the outer one.
 */
function loopPosition(scope, context) {
  const usable = scope && typeof scope === 'object' && !Array.isArray(scope);
  const index = (usable ? scope.$index : undefined) ?? context?.scopePathItem?.at(-1) ?? 0;
  const total = (usable ? scope.$total : undefined) ?? context?.scopePathLength?.at(-1) ?? 0;
  return {
    $index: index,
    $number: (usable ? scope.$number : undefined) ?? index + 1,
    $total: total,
    $first: index === 0,
    /** False rather than true when the length is unknown: a missing total must not end a run. */
    $last: total > 0 ? index === total - 1 : false,
  };
}

/** Normalises a raw tag body into an evaluable expression. */
export function normaliseTag(rawTag) {
  return String(rawTag)
    .trim()
    // Word helpfully "corrects" quotes typed into a document; undo that.
    .replace(SMART_QUOTES, "'")
    .replace(SMART_DQUOTES, '"')
    // `{{ .TITLE }}` — the leading dot is decoration.
    .replace(/^\.+/, '')
    .trim();
}

/**
 * Builds the docxtemplater `parser`. Errors inside an expression resolve to an
 * empty value rather than aborting the whole report.
 */
export function createParser(options = {}) {
  registerFilters(options);
  // One document, one sequence of bookmark ids — see `resetBookmarks`.
  resetBookmarks();

  return function parser(tag) {
    const expression = normaliseTag(tag);

    // `{{.}}` / `{{ this }}` inside a loop over scalars.
    if (expression === '' || expression === 'this') {
      return { get: (scope) => scope };
    }

    /*
     * A page break between loop items but not after the last one.
     *
     * It cannot be a filter: a filter only sees the value, and this needs to know where the
     * item sits in its loop. Written `{{@$pageBreakExceptLast}}` because the value is markup —
     * and the alternative every template author reaches for otherwise is a hard page break
     * inside the loop, which leaves a blank final page on every report.
     */
    if (expression === '$pageBreakExceptLast' || expression === '$pageBreakExceptFirst') {
      const exceptLast = expression === '$pageBreakExceptLast';
      return {
        get(scope, context) {
          const position = loopPosition(scope, context);
          const skip = exceptLast ? position.$last : position.$first;
          return skip ? '' : PAGE_BREAK;
        },
      };
    }

    let compiled;
    try {
      compiled = expressions.compile(expression);
    } catch {
      return { get: () => undefined };
    }

    // angular-expressions resolves properties with own-property checks, so the
    // scope must be passed as-is (a prototype-linked wrapper reads as empty).
    // Only clone when the expression actually needs the loop counters.
    const needsCounters = /\$index|\$number|\$first|\$last|\$total/.test(expression);

    return {
      get(scope, context) {
        try {
          if (!needsCounters) return compiled(scope ?? {});

          const usable = scope && typeof scope === 'object' && !Array.isArray(scope);
          const position = loopPosition(scope, context);
          const augmented = usable ? { ...scope, ...position } : { ...position };
          return compiled(augmented);
        } catch {
          return undefined;
        }
      },
    };
  };
}

export default createParser;
