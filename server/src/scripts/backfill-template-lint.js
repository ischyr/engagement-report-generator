/**
 * Analyses the tags of templates uploaded before the analysis existed.
 *
 *   npm run backfill:lint [-- --dry]
 *
 * The result is stored when a template is written, which leaves every template already in an
 * instance with nothing to show — and "no badge" reads as "not checked", which is exactly what it
 * means and exactly what nobody wants to see for the template they use every week. One pass fixes
 * that; after this, uploads keep themselves current.
 *
 * A template whose file has gone missing is reported and skipped rather than failing the run: a
 * broken reference is worth knowing about, and it is not this script's job to fix.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import env from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Template } from '../models/template.model.js';
import { Settings } from '../models/settings.model.js';
import { lintTemplateTags } from '../services/template-test.service.js';
import { log } from '../utils/logger.js';

const dry = process.argv.includes('--dry');

async function main() {
  await connectDatabase();
  const settings = await Settings.getSettings();

  const templates = await Template.find().sort({ name: 1 });
  let analysed = 0;
  let skipped = 0;
  let flagged = 0;

  for (const template of templates) {
    try {
      let lint;
      if (template.kind === 'html') {
        lint = lintTemplateTags({ html: template.html ?? '', settings });
      } else {
        const buffer = await fs.readFile(path.join(env.storage.templates, template.filename));
        lint = lintTemplateTags({ buffer, settings });
      }

      const unknown = lint.unknown.length;
      if (unknown) flagged += 1;
      log.info(
        `  ${template.name}: ${lint.counts.total} tag(s), ${unknown} unrecognised${
          unknown ? ` — ${lint.unknown.map((entry) => entry.tag).join(', ')}` : ''
        }`
      );

      if (!dry) {
        template.lint = lint;
        await template.save({ validateBeforeSave: false });
      }
      analysed += 1;
    } catch (error) {
      skipped += 1;
      log.warn(`  ${template.name}: skipped — ${error.message}`);
    }
  }

  log.info('');
  log.info(
    `${dry ? 'Would analyse' : 'Analysed'} ${analysed} template(s); ${flagged} have unrecognised tags; ${skipped} skipped.`
  );
  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
