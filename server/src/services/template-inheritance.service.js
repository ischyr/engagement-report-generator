/**
 * One house style, five documents.
 *
 * A firm has an NDA, a permission to attack, an offer, a statement of work and a report. They share
 * the same letterhead, the same footer with the page numbers, the same heading styles and the same
 * page setup — and each is a separate .docx, so the five drift. Somebody updates the logo in the
 * report template and the NDA keeps last year's for eighteen months, which is exactly the sort of
 * thing a client notices and nobody inside the firm does.
 *
 * So a template may inherit parts from another. At render time, the chosen parts of the base are
 * substituted into the child's package: the styles, the numbering, the theme, and the page setup
 * with its headers and footers. Nothing is copied on disk and nothing is written back to a template
 * — inheritance is applied to the *render*, so fixing the base fixes every child at once, which is
 * the entire point.
 *
 * The child keeps its own `word/document.xml`, which is the part that carries the tags and the
 * words. That division is the whole design: a base owns how a document looks, a child owns what it
 * says.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

import env from '../config/env.js';
import { badRequest } from '../utils/http-error.js';

const DOC_RELS = 'word/_rels/document.xml.rels';
const CONTENT_TYPES = '[Content_Types].xml';
const REL_BASE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Which parts may be inherited, and what each one actually swaps. */
export const INHERITABLE = {
  styles: {
    label: 'Heading and text styles',
    detail: 'word/styles.xml — the house style for headings, quotes, captions and tables.',
  },
  numbering: {
    label: 'List numbering',
    detail: 'word/numbering.xml — how bullets and numbered lists are drawn.',
  },
  theme: {
    label: 'Theme colours and fonts',
    detail: 'word/theme/theme1.xml — the palette and typeface pair the styles refer to.',
  },
  page: {
    label: 'Page setup, headers and footers',
    detail:
      'The letterhead and the footer, plus the paper size and margins they were designed for. ' +
      'Section breaks inside the document — a landscape appendix — are left alone.',
  },
};

const SIMPLE_PARTS = {
  styles: ['word/styles.xml'],
  numbering: ['word/numbering.xml'],
  theme: ['word/theme/theme1.xml'],
};

const PART_TYPES = {
  'word/styles.xml': [`${REL_BASE}/styles`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
  'word/numbering.xml': [`${REL_BASE}/numbering`, 'application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml'],
  'word/theme/theme1.xml': [`${REL_BASE}/theme`, 'application/vnd.openxmlformats-officedocument.theme+xml'],
};

const HDR_TYPE = `${REL_BASE}/header`;
const FTR_TYPE = `${REL_BASE}/footer`;
const HDR_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml';
const FTR_CT = 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

const read = (zip, name) => zip.file(name)?.asText() ?? null;
const xmlAttr = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/** The highest rIdN in a rels part, so a new one cannot collide with an existing one. */
function highestRelId(relsXml) {
  let max = 0;
  for (const match of String(relsXml ?? '').matchAll(/Id="rId(\d+)"/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return max;
}

/**
 * Ensures a part exists in the child's rels and content types, and returns its relationship id.
 *
 * A part copied into the package without both of these is a part Word will not open the file over —
 * and the error it gives says nothing about which one is missing, which is why this is one function
 * rather than two calls somebody can forget half of.
 */
function register(state, partName, relType, contentType, relId) {
  const target = partName.replace(/^word\//, '');
  const existing = new RegExp(`Target="\\.?/?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(
    state.rels
  );
  if (existing) {
    const idMatch = /Id="(rId\d+)"[^>]*Target="[^"]*"/.exec(
      state.rels.slice(Math.max(0, existing.index - 200), existing.index + 200)
    );
    if (idMatch) return idMatch[1];
  }

  const id = relId ?? `rId${(state.nextRelId += 1)}`;
  state.rels = state.rels.replace(
    '</Relationships>',
    `<Relationship Id="${id}" Type="${relType}" Target="${xmlAttr(target)}"/></Relationships>`
  );
  if (!state.contentTypes.includes(`PartName="/${partName}"`)) {
    state.contentTypes = state.contentTypes.replace(
      '</Types>',
      `<Override PartName="/${partName}" ContentType="${contentType}"/></Types>`
    );
  }
  return id;
}

/**
 * The body-level section properties: the last `<w:sectPr>` that is a direct child of `<w:body>`.
 *
 * Not any of the others. A `<w:sectPr>` inside a `<w:pPr>` is a section *break* — the landscape
 * appendix, the page that turns sideways — and replacing those with the house page setup would
 * silently rotate somebody's carefully built table back to portrait.
 */
function bodySectPr(documentXml) {
  const end = documentXml.lastIndexOf('</w:body>');
  if (end === -1) return null;
  const search = documentXml.slice(0, end);
  const open = search.lastIndexOf('<w:sectPr');
  if (open === -1) return null;
  /* Inside a paragraph's properties: a break rather than the body's own. */
  const between = search.slice(open);
  if (/^<w:sectPr[^>]*\/>/.test(between)) {
    return { start: open, end: open + between.match(/^<w:sectPr[^>]*\/>/)[0].length };
  }
  const close = search.indexOf('</w:sectPr>', open);
  if (close === -1) return null;
  const before = search.slice(0, open);
  const lastPPr = before.lastIndexOf('<w:pPr>');
  const lastPPrEnd = before.lastIndexOf('</w:pPr>');
  if (lastPPr > lastPPrEnd) return null; // still inside a paragraph's properties
  return { start: open, end: close + '</w:sectPr>'.length };
}

/**
 * Applies a base template's parts to a child's package, in place.
 *
 * @param {PizZip} zip   the child, already opened
 * @param {PizZip} base  the base template, already opened
 * @param {object} parts which of INHERITABLE to take
 * @returns {{applied: string[], warnings: string[]}}
 */
export function applyInheritedParts(zip, base, parts = {}) {
  const applied = [];
  const warnings = [];

  const state = {
    rels: read(zip, DOC_RELS) ?? '',
    contentTypes: read(zip, CONTENT_TYPES) ?? '',
    nextRelId: Math.max(highestRelId(read(zip, DOC_RELS) ?? ''), 500),
  };
  if (!state.rels || !state.contentTypes) {
    throw badRequest('The template is missing its relationships or content types and cannot inherit.');
  }

  /* ------------------------------------------------- the parts that just swap --- */
  for (const [flag, names] of Object.entries(SIMPLE_PARTS)) {
    if (!parts[flag]) continue;
    let took = 0;
    for (const name of names) {
      const xml = read(base, name);
      if (xml === null) {
        warnings.push(`The base template has no ${name}, so ${INHERITABLE[flag].label} was skipped.`);
        continue;
      }
      zip.file(name, Buffer.from(xml, 'utf8'));
      const [relType, contentType] = PART_TYPES[name];
      register(state, name, relType, contentType);
      took += 1;
    }
    if (took) applied.push(flag);
  }

  /* ----------------------------------------- the page, with its furniture ------- */
  if (parts.page) {
    const baseDoc = read(base, 'word/document.xml') ?? '';
    const baseSect = bodySectPr(baseDoc);
    const childDoc = read(zip, 'word/document.xml') ?? '';
    const childSect = bodySectPr(childDoc);

    if (!baseSect) {
      warnings.push('The base template has no page setup of its own, so it was not inherited.');
    } else if (!childSect) {
      warnings.push('This template has no page setup to replace, so it was left alone.');
    } else {
      let sectXml = baseDoc.slice(baseSect.start, baseSect.end);
      const baseRels = read(base, DOC_RELS) ?? '';

      /*
       * Every header and footer the base's section refers to, copied under a name of its own.
       *
       * Under a new name rather than the base's, because the child may already have a header2.xml
       * of its own that something else still points at — overwriting it would corrupt whichever
       * section that was. The reference in the copied sectPr is then repointed at the new id.
       */
      let copied = 0;
      sectXml = sectXml.replace(
        /<w:(header|footer)Reference([^>]*?)r:id="(rId\d+)"([^>]*)\/>/g,
        (whole, which, pre, rid, post) => {
          const target = new RegExp(`Id="${rid}"[^>]*Target="([^"]+)"`).exec(baseRels)?.[1];
          if (!target) {
            warnings.push(`The base's ${which} reference ${rid} points at nothing and was dropped.`);
            return '';
          }
          const source = `word/${target.replace(/^\.?\//, '')}`;
          const xml = read(base, source);
          if (xml === null) {
            warnings.push(`The base is missing ${source}, so that ${which} was dropped.`);
            return '';
          }
          const type = /w:type="([^"]+)"/.exec(pre + post)?.[1] ?? 'default';
          const name = `word/engy-${which}-${type}.xml`;
          zip.file(name, Buffer.from(xml, 'utf8'));
          const id = register(
            state,
            name,
            which === 'header' ? HDR_TYPE : FTR_TYPE,
            which === 'header' ? HDR_CT : FTR_CT
          );
          /*
           * The header's own relationships, and whatever they point at.
           *
           * A letterhead is a logo, and a logo is an image related from the *header's* rels part
           * rather than the document's. Copying the header alone gives a header with a hole in it,
           * so its rels come across under the matching name and every local target it names is
           * carried over too. Copied here, where the source part is known, rather than worked out
           * afterwards by comparing contents.
           */
          const sourceRels = source.replace(/^word\//, 'word/_rels/') + '.rels';
          const relsXml = read(base, sourceRels);
          if (relsXml) {
            zip.file(`word/_rels/engy-${which}-${type}.xml.rels`, Buffer.from(relsXml, 'utf8'));
            for (const match of relsXml.matchAll(/Target="([^"]+)"/g)) {
              const referenced = match[1];
              /* External links carry nothing with them; only parts inside the package travel. */
              if (/^https?:|^mailto:|^file:/i.test(referenced)) continue;
              const mediaPath = `word/${referenced.replace(/^\.?\//, '')}`;
              if (zip.file(mediaPath)) continue;
              const bytes = base.file(mediaPath)?.asUint8Array();
              if (!bytes) {
                warnings.push(`The base's ${which} refers to ${referenced}, which is missing from it.`);
                continue;
              }
              zip.file(mediaPath, bytes);
              const ext = mediaPath.split('.').pop()?.toLowerCase() ?? '';
              const mime = {
                png: 'image/png',
                jpg: 'image/jpeg',
                jpeg: 'image/jpeg',
                gif: 'image/gif',
                emf: 'image/x-emf',
                wmf: 'image/x-wmf',
                svg: 'image/svg+xml',
              }[ext];
              if (mime && !new RegExp(`Extension="${ext}"`, 'i').test(state.contentTypes)) {
                state.contentTypes = state.contentTypes.replace(
                  '</Types>',
                  `<Default Extension="${ext}" ContentType="${mime}"/></Types>`
                );
              }
            }
          }
          copied += 1;
          return `<w:${which}Reference${pre}r:id="${id}"${post}/>`;
        }
      );

      const updatedDoc = childDoc.slice(0, childSect.start) + sectXml + childDoc.slice(childSect.end);
      zip.file('word/document.xml', Buffer.from(updatedDoc, 'utf8'));
      applied.push('page');
      if (!copied) {
        warnings.push('The base has no headers or footers, so only its page size and margins were taken.');
      }
    }
  }

  zip.file(DOC_RELS, Buffer.from(state.rels, 'utf8'));
  zip.file(CONTENT_TYPES, Buffer.from(state.contentTypes, 'utf8'));
  return { applied, warnings };
}

/** Reads a template's file off disk, as a zip. Shared by the render path and the lint. */
export async function openTemplateZip(template) {
  if (!template?.filename) throw badRequest(`"${template?.name ?? 'That template'}" has no file.`);
  const filePath = path.join(env.storage.templates, template.filename);
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    throw badRequest(`The file for "${template.name}" is missing from storage.`);
  }
  return { zip: new PizZip(buffer), buffer };
}

/* -------------------------------------------------------------------------- */
/* HTML partials                                                              */
/* -------------------------------------------------------------------------- */

/** `{{> Name of a partial }}` — deliberately unlike a value tag, so neither can be mistaken for the other. */
const PARTIAL = /\{\{\s*>\s*([^{}]+?)\s*\}\}/g;

/** How deep a partial may include another. Three is generous; a fourth is a mistake. */
const MAX_DEPTH = 3;

/**
 * Expands `{{> Name }}` includes in an HTML template.
 *
 * The same idea as the .docx side and for the same reason: the header block, the client's logo and
 * the footer are the same in every HTML template a firm has, and keeping five copies means fixing
 * four of them.
 *
 * A cycle is reported rather than followed — a template that includes itself is a mistake somebody
 * made, and a stack overflow is a poor way to be told about it. A name that does not resolve is left
 * visible in the output as a comment, because a silently missing block is how a report goes out with
 * no letterhead and nobody notices.
 *
 * @param {string} html
 * @param {(name: string) => Promise<string|null>} resolve
 */
export async function expandPartials(html, resolve, { depth = 0, seen = [] } = {}) {
  const text = String(html ?? '');
  if (!PARTIAL.test(text)) return { html: text, used: [], warnings: [] };
  PARTIAL.lastIndex = 0;

  if (depth >= MAX_DEPTH) {
    return {
      html: text.replace(PARTIAL, (whole, name) => `<!-- partial "${name}" nested too deeply -->`),
      used: [],
      warnings: [`Partials are nested more than ${MAX_DEPTH} deep; the innermost were not expanded.`],
    };
  }

  const used = [];
  const warnings = [];
  const names = [...text.matchAll(PARTIAL)].map((match) => match[1].trim());
  const bodies = new Map();

  for (const name of names) {
    if (bodies.has(name)) continue;
    if (seen.includes(name.toLowerCase())) {
      warnings.push(`"${name}" includes itself, directly or through another partial.`);
      bodies.set(name, `<!-- partial "${name}" skipped: it includes itself -->`);
      continue;
    }
    const body = await resolve(name);
    if (body === null || body === undefined) {
      warnings.push(`There is no template called "${name}" to include.`);
      bodies.set(name, `<!-- partial "${name}" not found -->`);
      continue;
    }
    const nested = await expandPartials(body, resolve, {
      depth: depth + 1,
      seen: [...seen, name.toLowerCase()],
    });
    bodies.set(name, nested.html);
    used.push(name, ...nested.used);
    warnings.push(...nested.warnings);
  }

  return {
    html: text.replace(PARTIAL, (whole, name) => bodies.get(name.trim()) ?? whole),
    used: [...new Set(used)],
    warnings,
  };
}

export default applyInheritedParts;
