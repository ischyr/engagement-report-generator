/**
 * Is this package one Word will open?
 *
 * Written after a report Word refused with "an error trying to open the file — check the file
 * permissions, make sure there is sufficient free memory and disk space". None of which was the
 * problem: the package contained a part with no content type, and that is the message Word gives.
 *
 * The lesson worth encoding is that a .docx can be broken in ways nothing here notices. The XML
 * parses. The zip opens. Every test passes. Word alone refuses, and its message points at the disk.
 * So this checks the package rules a renderer can break — content types, relationships, missing
 * parts, well-formedness — and says which part and why.
 *
 * Deliberately not a schema validator. The wordprocessingml schema is enormous and validating
 * against it would be a project of its own; these are the handful of rules this app's own machinery
 * is capable of breaking, which is where the bugs actually come from.
 */

const CONTENT_TYPES = '[Content_Types].xml';

/**
 * Parts whose content type Word checks specifically.
 *
 * A `<Default Extension="xml" ContentType="application/xml"/>` covers the *extension* and satisfies
 * a naive check while leaving these declared as the wrong kind of thing — which is exactly the
 * failure this file exists for. Each of these needs an Override of its own.
 */
const REQUIRED_OVERRIDES = {
  'docProps/custom.xml': 'custom-properties+xml',
  'docProps/core.xml': 'core-properties+xml',
  'docProps/app.xml': 'extended-properties+xml',
  'word/document.xml': 'wordprocessingml.document.main+xml',
  'word/styles.xml': 'wordprocessingml.styles+xml',
  'word/numbering.xml': 'wordprocessingml.numbering+xml',
  'word/settings.xml': 'wordprocessingml.settings+xml',
  'word/footnotes.xml': 'wordprocessingml.footnotes+xml',
  'word/endnotes.xml': 'wordprocessingml.endnotes+xml',
};

/** Well-formedness, by walking the tags. Catches the classic: a start tag with no matching end. */
export function xmlProblem(xml) {
  const stack = [];
  const tag = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let match;
  while ((match = tag.exec(xml)) !== null) {
    const [whole, closing, name, , selfClosing] = match;
    if (whole.startsWith('<?') || whole.startsWith('<!')) continue;
    if (closing) {
      const open = stack.pop();
      if (open?.name !== name) return `</${name}> closes <${open?.name ?? 'nothing'}>`;
    } else if (!selfClosing) {
      stack.push({ name });
    }
  }
  return stack.length ? `<${stack[stack.length - 1].name}> is never closed` : null;
}

/**
 * An attribute by name, wherever it sits in the tag.
 *
 * Word writes `PartName` before `ContentType`; the `docx` library writes them the other way round;
 * both are correct XML. A regex that assumed one order found nothing in a package written by the
 * other producer and called every part untyped — a validator that cries wolf, which is a validator
 * somebody switches off.
 */
const attributeOf = (element, name) =>
  new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(element)?.[1] ?? null;

/** Resolves a relationship target against the part whose rels file it is in. */
function resolveTarget(relsPath, target) {
  const base = relsPath.replace(/_rels\/[^/]+$/, '');
  const out = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '.' || segment === '') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  return out.join('/');
}

/**
 * Every rule this app can break, checked. Returns a list of sentences; empty means it should open.
 *
 * @param {object} zip an opened .docx (PizZip)
 */
export function packageProblems(zip) {
  const problems = [];
  const names = Object.keys(zip.files).filter((name) => !name.endsWith('/'));
  const read = (name) => zip.file(name)?.asText() ?? null;

  const types = read(CONTENT_TYPES);
  if (!types) return [`${CONTENT_TYPES} is missing, so this is not an Office package at all.`];

  const defaults = new Map();
  for (const element of types.match(/<Default\b[^>]*>/gi) ?? []) {
    const extension = attributeOf(element, 'Extension');
    if (extension) defaults.set(extension.toLowerCase(), attributeOf(element, 'ContentType') ?? '');
  }
  const overrides = new Map();
  for (const element of types.match(/<Override\b[^>]*>/gi) ?? []) {
    const part = attributeOf(element, 'PartName');
    if (part) overrides.set(part.replace(/^\//, ''), attributeOf(element, 'ContentType') ?? '');
  }

  for (const name of names) {
    if (name === CONTENT_TYPES) continue;
    const ext = name.split('.').pop()?.toLowerCase() ?? '';
    const declared = overrides.get(name) ?? defaults.get(ext) ?? null;
    if (!declared) {
      problems.push(`${name} has no content type — Word refuses to open a package with one of these.`);
      continue;
    }
    const wanted = REQUIRED_OVERRIDES[name];
    if (wanted && !declared.includes(wanted)) {
      problems.push(
        `${name} is declared as "${declared}" — it needs its own Override ending in "${wanted}".`
      );
    }
  }

  /* Every relationship must point at something that is in the package. */
  for (const relsPath of names.filter((name) => name.endsWith('.rels'))) {
    const xml = read(relsPath) ?? '';
    for (const entry of xml.match(/<Relationship\b[^>]*>/g) ?? []) {
      if (/TargetMode="External"/i.test(entry)) continue;
      const target = attributeOf(entry, 'Target');
      if (!target || /^[a-z]+:/i.test(target)) continue;
      const resolved = resolveTarget(relsPath, target);
      if (!zip.file(resolved)) {
        problems.push(`${relsPath} points at ${resolved}, which is not in the package.`);
      }
    }
    const ids = [...xml.matchAll(/Id="([^"]+)"/g)].map((m) => m[1]);
    const twice = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
    if (twice.length) problems.push(`${relsPath} declares ${twice.join(', ')} more than once.`);
  }

  /* And every relationship the document uses must be declared. */
  const doc = read('word/document.xml') ?? '';
  const declaredIds = new Set(
    [...(read('word/_rels/document.xml.rels') ?? '').matchAll(/Id="([^"]+)"/g)].map((m) => m[1])
  );
  for (const id of new Set([...doc.matchAll(/r:(?:id|embed|link)="([^"]+)"/g)].map((m) => m[1]))) {
    if (!declaredIds.has(id)) problems.push(`word/document.xml uses ${id}, which is not declared.`);
  }

  /* Well-formedness, and the characters XML forbids outright. */
  for (const name of names.filter((n) => n.endsWith('.xml') || n.endsWith('.rels'))) {
    const xml = read(name) ?? '';
    const problem = xmlProblem(xml);
    if (problem) problems.push(`${name} is not well-formed: ${problem}`);
    const illegal = xml.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/);
    if (illegal) {
      const code = illegal[0].charCodeAt(0).toString(16).padStart(4, '0');
      problems.push(`${name} contains U+${code}, which XML does not allow.`);
    }
  }

  return problems;
}

export default packageProblems;
