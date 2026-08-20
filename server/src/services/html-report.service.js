/**
 * Renders an HTML report template against the same data model the .docx engine
 * uses, so one Tag reference documents both and a finding written once appears
 * identically in either output.
 *
 * docxtemplater cannot help here — it operates on OOXML — so this is a small
 * mustache-shaped renderer over the same expression parser and filters.
 *
 * Escaping rule: `{{ .tag }}` is escaped, `{{@rich.field}}` (and `{{{tag}}}`) is
 * not. Unescaped output is always passed through the sanitiser first, because
 * finding bodies come from a rich-text editor and could carry pasted markup.
 */

import { createParser, registerFilters } from './template-parser.js';
import { parseHtml } from './ooxml/html-parser.js';
import { unprocessable } from '../utils/http-error.js';

/* -------------------------------------------------------------------------- */
/* Sanitiser                                                                  */
/* -------------------------------------------------------------------------- */

/** Elements a report body may contain. Anything else is unwrapped or dropped. */
const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'div', 'span', 'section', 'article',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark',
  'sub', 'sup', 'small', 'code', 'pre', 'kbd', 'samp', 'blockquote', 'q', 'cite',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd',
  'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
  'a', 'img', 'figure', 'figcaption',
]);

/** Elements removed together with their contents. */
const DROP_ENTIRELY = new Set(['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'button', 'svg', 'math']);

const ALLOWED_ATTRS = {
  '*': new Set(['class', 'style', 'title']),
  a: new Set(['href', 'target', 'rel']),
  img: new Set(['src', 'alt', 'width', 'height']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan', 'scope']),
  col: new Set(['span']),
  ol: new Set(['start', 'type']),
};

const VOID_TAGS = new Set(['br', 'hr', 'img', 'col']);

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const escapeAttr = escapeHtml;

/** Blocks `javascript:` and friends while allowing inline images through. */
function safeUrl(value, { allowData = false } = {}) {
  const url = String(value ?? '').trim();
  if (url === '') return null;
  // Strip control characters first — "java\nscript:" would otherwise slip past.
  const normalised = url.replace(/[\x00-\x1f]/g, '').toLowerCase();
  if (/^(https?:|mailto:|tel:|#|\/|\.\/|\.\.\/)/.test(normalised)) return url;
  if (allowData && /^data:image\/(png|jpe?g|gif|webp|bmp);base64,/.test(normalised)) return url;
  if (!/^[a-z][a-z0-9+.-]*:/.test(normalised)) return url; // a bare relative path
  return null;
}

/** Removes declarations that can load or position content unexpectedly. */
function safeStyle(value) {
  const cleaned = String(value ?? '')
    .split(';')
    .map((declaration) => declaration.trim())
    .filter((declaration) => {
      if (!declaration.includes(':')) return false;
      const [property, ...rest] = declaration.split(':');
      const body = rest.join(':').toLowerCase();
      if (/url\s*\(|expression|javascript:/.test(body)) return false;
      return /^[a-z-]+$/.test(property.trim().toLowerCase());
    });
  return cleaned.join('; ');
}

/**
 * Rewrites untrusted HTML to the allow-list above.
 *
 * Reuses the parser the OOXML converter uses, so both paths agree on how the
 * editor's markup is understood.
 */
export function sanitizeHtml(input) {
  if (typeof input !== 'string' || input === '') return '';
  const tree = parseHtml(input);
  let out = '';

  const walk = (node) => {
    if (node.type === 'text') {
      out += escapeHtml(node.value);
      return;
    }
    if (node.type === 'root') {
      node.children.forEach(walk);
      return;
    }
    const { tag, attrs, children } = node;
    if (DROP_ENTIRELY.has(tag)) return;

    if (!ALLOWED_TAGS.has(tag)) {
      // Unknown but harmless wrapper: keep the content, lose the element.
      children.forEach(walk);
      return;
    }

    const parts = [];
    for (const [name, raw] of Object.entries(attrs ?? {})) {
      const key = name.toLowerCase();
      // Event handlers, in any casing.
      if (key.startsWith('on')) continue;
      const permitted = ALLOWED_ATTRS[tag]?.has(key) || ALLOWED_ATTRS['*'].has(key);
      if (!permitted) continue;

      if (key === 'href') {
        const url = safeUrl(raw);
        if (!url) continue;
        parts.push(`href="${escapeAttr(url)}"`);
        // External links opened from a report should not keep a handle on it.
        if (/^https?:/i.test(url)) parts.push('target="_blank" rel="noopener noreferrer"');
        continue;
      }
      if (key === 'src') {
        const url = safeUrl(raw, { allowData: true });
        if (!url) continue;
        parts.push(`src="${escapeAttr(url)}"`);
        continue;
      }
      if (key === 'style') {
        const style = safeStyle(raw);
        if (style) parts.push(`style="${escapeAttr(style)}"`);
        continue;
      }
      parts.push(`${key}="${escapeAttr(raw)}"`);
    }

    const open = `<${tag}${parts.length ? ` ${parts.join(' ')}` : ''}>`;
    if (VOID_TAGS.has(tag)) {
      out += open;
      return;
    }
    out += open;
    children.forEach(walk);
    out += `</${tag}>`;
  };

  walk(tree);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                   */
/* -------------------------------------------------------------------------- */

const SECTION_RE = /\{\{\s*([#^])\s*([^}]+?)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\2\s*\}\}/;
const VALUE_RE = /\{\{\{\s*([^}]+?)\s*\}\}\}|\{\{\s*(@?)\s*([^}]+?)\s*\}\}/g;

const isEmptyish = (value) =>
  value === undefined ||
  value === null ||
  value === false ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

/**
 * Renders one template string.
 *
 * Sections are resolved outermost-first by repeatedly matching the first
 * `{{#x}}…{{/x}}` pair, which keeps nesting working without a full parser.
 */
function renderTemplate(template, scope, parse, depth = 0) {
  if (depth > 32) throw unprocessable('Template nests too deeply — check for a self-referencing loop.');

  let output = template;

  // Sections first, so values inside them resolve against the right scope.
  for (let guard = 0; guard < 5000; guard += 1) {
    const match = SECTION_RE.exec(output);
    if (!match) break;
    const [whole, kind, expression, body] = match;

    let value;
    try {
      value = parse(expression).get(scope, {});
    } catch {
      value = undefined;
    }

    let replacement = '';
    if (kind === '^') {
      // Inverted: render only when there is nothing.
      replacement = isEmptyish(value) ? renderTemplate(body, scope, parse, depth + 1) : '';
    } else if (Array.isArray(value)) {
      replacement = value
        .map((item, index) => {
          // Give loop bodies the item as scope, plus counters and an escape
          // hatch to the enclosing data.
          const inner =
            item !== null && typeof item === 'object' && !Array.isArray(item)
              ? { ...scope, ...item, $index: index, $number: index + 1, $parent: scope }
              : { ...scope, this: item, $index: index, $number: index + 1, $parent: scope };
          return renderTemplate(body, inner, parse, depth + 1);
        })
        .join('');
    } else if (!isEmptyish(value)) {
      const inner =
        value !== null && typeof value === 'object'
          ? { ...scope, ...value, $parent: scope }
          : scope;
      replacement = renderTemplate(body, inner, parse, depth + 1);
    }

    output = output.slice(0, match.index) + replacement + output.slice(match.index + whole.length);
  }

  // Then plain values.
  return output.replace(VALUE_RE, (whole, tripleExpression, rawPrefix, expression) => {
    const raw = Boolean(tripleExpression) || rawPrefix === '@';
    const source = tripleExpression ?? expression;
    // A stray closing tag from an unbalanced section: leave it visible rather
    // than silently swallowing it.
    if (/^[#^/]/.test(source.trim())) return whole;

    let value;
    try {
      value = parse(source).get(scope, {});
    } catch {
      value = undefined;
    }
    if (value === undefined || value === null) return '';
    if (typeof value === 'object') return raw ? '' : escapeHtml(JSON.stringify(value));
    return raw ? sanitizeHtml(String(value)) : escapeHtml(String(value));
  });
}

/**
 * @param {string} template the HTML template body
 * @param {object} data from `buildReportData(..., { target: 'html' })`
 * @param {{dateFormat?: string}} [options]
 * @returns {string} rendered HTML
 */
/**
 * Looks a partial up by name, for `{{> House header }}`.
 *
 * By name rather than by id because a partial is written into markup by a person, and an id in a
 * template is a thing nobody can read or move between instances. Case-insensitive for the same
 * reason: "house header" and "House Header" are the same intent, and a template that silently
 * inserted nothing because of a capital letter would be a bad afternoon.
 */
export async function partialResolver() {
  const { Template } = await import('../models/template.model.js');
  const rows = await Template.find({ kind: 'html' }).select('name html');
  const byName = new Map(rows.map((row) => [String(row.name).toLowerCase(), row.html ?? '']));
  return (name) => byName.get(String(name).trim().toLowerCase()) ?? null;
}

export function renderHtmlReport(template, data, options = {}) {
  if (typeof template !== 'string' || template.trim() === '') {
    throw unprocessable('This template is empty — add some HTML first.');
  }
  registerFilters({ dateFormat: options.dateFormat });
  const parse = createParser({ dateFormat: options.dateFormat });
  return renderTemplate(template, data, parse);
}

/** Tag names a template uses, for the same "detected placeholders" badge. */
export function extractHtmlTags(template) {
  const tags = new Set();
  for (const match of String(template ?? '').matchAll(/\{\{\{?\s*([^{}]+?)\s*\}?\}\}/g)) {
    tags.add(match[1].trim());
  }
  return [...tags].sort();
}

export default renderHtmlReport;
