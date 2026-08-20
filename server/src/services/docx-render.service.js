/**
 * Turning a .docx template plus some data into a .docx file.
 *
 * Lifted out of `generateReport` so that the paperwork a proposal produces — an NDA, a
 * permission to attack, the offer — goes through the identical pipeline as a report: the same
 * delimiters, the same parser and filters, the same tag normaliser, the same treatment of
 * unknown tags, the same rich-text-to-OOXML machinery. Two copies of this configuration
 * would drift, and the first sign of it would be a contract where `{{ date | date }}` prints
 * differently from the report that references it.
 *
 * What is *not* here is the data. That is the whole difference between the two: a report's
 * data is built from an engagement, a proposal's from a proposal, and each knows tags the
 * other has never heard of. So the caller passes a `build` function, which is handed the
 * OOXML options it needs for rich text and returns the object to render.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';
import Docxtemplater from 'docxtemplater';

import env from '../config/env.js';
import { DocxAssembler } from './ooxml/docx-parts.js';
import { applyInheritedParts, openTemplateZip } from './template-inheritance.service.js';
import { createParser, createTagNormaliser, DELIMITERS } from './template-parser.js';
import { customPropertiesXml } from './provenance.service.js';
import { HttpError, badRequest } from '../utils/http-error.js';

/**
 * Opens a template file and prepares everything a render needs from it.
 *
 * Separate from the render because the pieces are wanted on their own: the assembler holds
 * the template's own styles and text width, which the rich-text converter needs *before*
 * anybody builds data with rich text in it.
 */
export async function openTemplate(template) {
  if (!template) throw badRequest('No template was given.');
  if (template.kind && template.kind !== 'docx') {
    throw badRequest(`"${template.name}" is not a Word template.`);
  }
  if (!template.filename) throw badRequest(`"${template.name}" has no uploaded file.`);

  const filePath = path.join(env.storage.templates, template.filename);
  let buffer;
  try {
    buffer = await fs.readFile(filePath);
  } catch {
    throw badRequest(
      `Template file "${template.filename}" is missing from storage. Re-upload the template.`
    );
  }

  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw badRequest('Template is not a readable .docx file (the zip container is corrupt).');
  }
  if (!zip.file('word/document.xml')) {
    throw badRequest('Template does not look like a Word document (word/document.xml is missing).');
  }

  /*
   * The house style, before anything reads the package.
   *
   * Applied here rather than at upload so that fixing the base fixes every child, and *before* the
   * assembler loads: it reads the styles it may use and the page geometry it measures against out of
   * exactly these parts, so inheriting after it had looked would leave it measuring the wrong page.
   *
   * A base that has gone missing is a warning rather than a failure. The child is still a complete
   * document — it just looks like itself instead of like the house — and refusing to produce a
   * report at all because a *decoration* is unavailable would be the wrong trade for whoever is
   * standing in front of a client.
   */
  const inheritance = { applied: [], warnings: [] };
  const wanted = template.inheritParts ?? {};
  if (template.inherits && Object.values(wanted).some(Boolean)) {
    try {
      const parent =
        typeof template.inherits === 'object' && template.inherits.filename
          ? template.inherits
          : await (await import('../models/template.model.js')).Template.findById(template.inherits);
      if (!parent) throw badRequest('The base template it inherits from no longer exists.');
      const { zip: baseZip } = await openTemplateZip(parent);
      const result = applyInheritedParts(zip, baseZip, wanted);
      inheritance.applied = result.applied;
      inheritance.warnings = result.warnings;
      inheritance.from = parent.name;
    } catch (error) {
      inheritance.warnings.push(
        `Could not take the house style from the base template: ${error.message}`
      );
    }
  }

  const parts = new DocxAssembler(zip).load();
  /*
   * The buffer comes back too, for the template's version hash — see provenance.service.js. It is
   * already in memory, and hashing the file on disk a second time would be the same bytes read
   * twice with a window in between for them to differ.
   */
  return { zip, parts, numbering: parts.ensureNumbering(), buffer, inheritance };
}

/**
 * The options the rich-text converter needs, given a loaded template and the presentation
 * settings this document is meant to use.
 *
 * `media` defaults to an empty map: a proposal has no evidence in it, and the alternative —
 * making every caller pass one — is a footgun for the caller who does not.
 */
export function ooxmlOptionsFor({ parts, numbering, media = new Map(), pub = {}, priv = {} }) {
  return {
    parts,
    numbering,
    media,
    monoFont: 'Consolas',
    imageBorder: Boolean(priv.imageBorder),
    imageBorderColor: priv.imageBorderColor ?? '000000',
    captionStyle: pub.captionStyle ?? 'Caption',
    codeTheme: pub.codeBlockTheme ?? 'terminal',
    availableStyles: parts.styleIds,
    usableTwips: parts.usableTwips,
  };
}

/**
 * Renders and returns the bytes.
 *
 * `describeError` lets the caller turn docxtemplater's internals into something a person can
 * act on — the report path already has a good one, and this stays out of its way rather than
 * imposing a worse one.
 */
export function renderDocx({
  zip,
  parts,
  data,
  dateFormat,
  updateFields = true,
  describeError,
  provenance = null,
}) {
  let doc;
  try {
    doc = new Docxtemplater(zip, {
      delimiters: DELIMITERS,
      parser: createParser({ dateFormat }),
      modules: [createTagNormaliser()],
      paragraphLoop: true,
      linebreaks: true,
      // Unknown tags render empty instead of throwing, so a half-finished template still
      // produces a document.
      nullGetter(part) {
        if (part.module === 'rawxml') return '<w:p/>';
        return '';
      },
    });
    doc.render(data);
  } catch (error) {
    const described = describeError?.(error);
    if (described) throw described;
    throw new HttpError(500, `Document generation failed: ${error.message}`);
  }

  /*
   * Ask Word to refresh the fields on open. Requested before the commit rather than after,
   * because `commit()` is what writes the settings part — this is the last moment the
   * document is still a package rather than bytes.
   */
  parts.requestFieldUpdate(updateFields);
  /*
   * Stamped here rather than by the caller, so that every path through this pipeline is stamped —
   * the report, the NDA, the permission to attack, the test render. A caller that forgot would
   * produce the one anonymous document nobody can trace, which is the failure this prevents.
   */
  if (provenance) parts.setCustomProperties(customPropertiesXml(provenance));
  parts.commit();

  return doc.getZip().generate({
    type: 'nodebuffer',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/** A filename that will survive being written to a disk and put in a header. */
export const safeDocName = (value, fallback = 'document') =>
  String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim() || fallback;

export default renderDocx;
