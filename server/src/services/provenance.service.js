/**
 * Where a generated document came from.
 *
 * A .docx that has left the building is otherwise anonymous. A client says "the last one had a
 * table of contents" or "these severities were different", and the honest answer is a shrug: the
 * template has been edited since, the settings have been changed since, and nothing recorded which
 * version of either produced the file on their desk.
 *
 * So every render is stamped twice.
 *
 * **In the file**, as Word custom document properties — File → Info → Properties → Advanced. That
 * makes a mystery .docx self-describing: whoever has the bytes can see which template, which build
 * and which render produced them, without access to this app at all. Custom properties are chosen
 * over the core ones because Word's core fields belong to the author (title, subject, keywords) and
 * a template may legitimately set them; overwriting those to carry our bookkeeping would be
 * vandalism of the document's own metadata.
 *
 * **In the database**, as a RenderRecord: the same identifiers plus the settings that were in
 * force, so "what was different about the last one" is answerable months later, and so a delivery
 * can be tied to the exact render whose bytes were sent.
 *
 * The two share one `renderId`, which is the only thing needed to get from a file to its record.
 */

import { createHash, randomUUID } from 'node:crypto';

import { buildLabel } from '../utils/build-info.js';

/** The property names written into the document. Prefixed, so nothing collides with a template's own. */
export const PROVENANCE_PROPERTIES = [
  'EngyRenderId',
  'EngyGeneratedAt',
  'EngyGeneratedBy',
  'EngyTemplate',
  'EngyTemplateVersion',
  'EngyBuild',
  'EngySubject',
];

/**
 * A short, stable fingerprint of a template's own bytes.
 *
 * The version a person can quote. Ten hex characters of sha256 over the file: long enough that two
 * templates in one firm will not collide, short enough to read down a phone. Deliberately of the
 * *bytes* rather than a version number somebody has to remember to increment — the whole failure
 * this exists to catch is a template edited without anybody noting it.
 */
export function templateVersion(buffer) {
  if (!buffer) return '';
  return createHash('sha256').update(buffer).digest('hex').slice(0, 10);
}

/** The hash a delivery record is compared against, over the produced bytes. */
export function outputHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * Everything worth stamping, assembled once so the file and the record cannot disagree.
 *
 * `subject` is what the document is *about* — an engagement name, a proposal reference — because
 * the commonest question asked of an orphaned file is "which job is this?" and the filename has
 * usually been renamed by then.
 */
export function provenanceFor({ template, templateBuffer, user, subject, settings }) {
  const pub = settings?.report?.public ?? {};
  const priv = settings?.report?.private ?? {};

  return {
    renderId: randomUUID(),
    at: new Date(),
    by: user?._id ?? null,
    byName:
      [user?.firstname, user?.lastname].filter(Boolean).join(' ') || user?.username || 'somebody',
    template: template?._id ?? null,
    templateName: template?.name ?? '',
    templateVersion: templateVersion(templateBuffer),
    /** "1.0.0 (3a79d73)" — the same label the footer and the startup line show. */
    build: buildLabel(),
    subject: subject ?? '',
    /*
     * The settings that change what comes out, and only those.
     *
     * Snapshotted rather than referenced: settings are a singleton that anybody may edit, so a
     * record pointing at "the settings" would describe today's rather than the render's — which is
     * exactly the question this is here to answer. Nothing sensitive is in here; it is presentation.
     */
    settings: {
      dateFormat: pub.dateFormat ?? '',
      captionStyle: pub.captionStyle ?? '',
      findingIdPrefix: pub.findingIdPrefix ?? '',
      codeBlockTheme: pub.codeBlockTheme ?? '',
      cvssColors: { ...(pub.cvssColors ?? {}) },
      imageBorder: Boolean(priv.imageBorder),
      imageBorderColor: priv.imageBorderColor ?? '',
      /** The one somebody always asks about: whether Word refreshes the table of contents on open. */
      updateFieldsOnOpen: priv.updateFieldsOnOpen !== false,
    },
  };
}

/** XML-escaped, because a template name may contain an ampersand and an engagement name usually does. */
const escape = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/**
 * The custom-properties part, as Word expects it.
 *
 * `pid` starts at 2 — 0 and 1 are reserved by the format, and Word treats a part numbered from 0 as
 * corrupt rather than as a document with an odd property in it. `fmtid` is the fixed GUID every
 * custom property set uses; it is not ours to choose.
 */
export function customPropertiesXml(provenance) {
  const entries = [
    ['EngyRenderId', provenance.renderId],
    ['EngyGeneratedAt', new Date(provenance.at).toISOString()],
    ['EngyGeneratedBy', provenance.byName],
    ['EngyTemplate', provenance.templateName],
    ['EngyTemplateVersion', provenance.templateVersion],
    ['EngyBuild', provenance.build],
    ['EngySubject', provenance.subject],
  ].filter(([, value]) => String(value ?? '') !== '');

  const properties = entries
    .map(
      ([name, value], index) =>
        `<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="${index + 2}" name="${escape(
          name
        )}"><vt:lpwstr>${escape(value)}</vt:lpwstr></property>`
    )
    .join('');

  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties"' +
    ' xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    properties +
    '</Properties>'
  );
}

export default provenanceFor;
