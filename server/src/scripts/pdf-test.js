/**
 * Checks the PDF converter.
 *
 *   npm run test:pdf
 *
 * Most of this runs without any converter installed, because most of what matters is what happens
 * when there is not one: an instance with nothing configured has to behave exactly as it did
 * before, and an instance pointed at a program that is missing has to say so in a sentence somebody
 * can act on rather than failing with an errno.
 *
 * Where a converter *is* configured on the machine running this, the last block converts a real
 * template and checks the bytes that come back are a PDF. That block is skipped, loudly, otherwise
 * — a test that quietly passes because it did nothing is worse than one that says it was not run.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { docxToPdf, pdfConfig, PDF_CONVERTERS, testPdfConverter } from '../services/pdf.service.js';
import { env } from '../config/env.js';

let passed = 0;
let failed = 0;
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}${detail !== undefined ? ` — ${detail}` : ''}`);
  }
};

/* -------------------------------------------------------------------------- */
console.log('What an instance with nothing set up does:');

{
  const config = pdfConfig({});
  check('a fresh instance has no converter', config.converter === 'none' && !config.enabled);
  check('and says so in words a person can read', config.label === 'None', config.label);
}

{
  const config = pdfConfig({ pdf: { converter: 'nonsense' } });
  check(
    'a converter nobody has heard of reads as none rather than as itself',
    config.converter === 'none' && !config.enabled,
    config.converter
  );
}

{
  let refused = '';
  try {
    await docxToPdf(Buffer.from('PK'), { config: pdfConfig({}) });
  } catch (error) {
    refused = error.message;
  }
  check(
    'converting with no converter is refused, and says who can fix it',
    /No PDF converter/.test(refused) && /administrator/i.test(refused),
    refused
  );
}

/* -------------------------------------------------------------------------- */
console.log('\nThe settings it accepts:');

{
  const config = pdfConfig({ pdf: { converter: 'libreoffice' } });
  check('an empty command falls back to the preset', config.command === 'soffice', config.command);
  check('and the timeout has a working default', config.timeoutSeconds === 120, `${config.timeoutSeconds}`);
}

{
  const low = pdfConfig({ pdf: { converter: 'word', timeoutSeconds: 1 } });
  const high = pdfConfig({ pdf: { converter: 'word', timeoutSeconds: 9000 } });
  check(
    'a timeout outside the range is brought into it rather than refused',
    low.timeoutSeconds === 10 && high.timeoutSeconds === 600,
    `${low.timeoutSeconds} ${high.timeoutSeconds}`
  );
  check('the Word preset runs through PowerShell', high.command === 'powershell', high.command);
}

check(
  'every preset the settings offer has a label and a note',
  Object.values(PDF_CONVERTERS).every((preset) => preset.label && preset.note),
  JSON.stringify(Object.keys(PDF_CONVERTERS))
);

/* -------------------------------------------------------------------------- */
console.log('\nWhen the program is not there:');

{
  const config = pdfConfig({
    pdf: { converter: 'libreoffice', command: 'engy-no-such-converter', timeoutSeconds: 10 },
  });
  const before = await fs.readdir(os.tmpdir());
  const result = await testPdfConverter(config, Buffer.from('PK not really a docx'));

  check('the test reports a failure rather than throwing', result.ok === false, JSON.stringify(result));
  check(
    'naming the program and what was tried, so the fix is obvious',
    /not found/i.test(result.error) && /engy-no-such-converter/.test(result.error),
    result.error
  );

  /* The directory is made before the program is run, so a failure is exactly where it leaks. */
  const after = await fs.readdir(os.tmpdir());
  const leaked = after.filter((entry) => entry.startsWith('engy-pdf-') && !before.includes(entry));
  check('and nothing is left in the temp directory', leaked.length === 0, leaked.join(', '));
}

{
  let refused = '';
  try {
    await docxToPdf(Buffer.alloc(0), { config: pdfConfig({ pdf: { converter: 'word' } }) });
  } catch (error) {
    refused = error.message;
  }
  check('an empty document is refused before anything is spawned', /nothing to convert/i.test(refused), refused);
}

/* -------------------------------------------------------------------------- */
console.log('\nAnd with a real one, if this machine has one:');

{
  /*
   * Whichever is actually here. The environment variable is for a container, where the test knows
   * LibreOffice was installed on purpose; otherwise Word is tried on Windows, because that is the
   * one a Windows machine with Office already has.
   */
  const candidates = [
    process.env.PDF_CONVERTER === 'libreoffice' ? { converter: 'libreoffice' } : null,
    process.platform === 'win32' ? { converter: 'word' } : null,
    { converter: 'libreoffice' },
  ].filter(Boolean);

  const sample = await fs
    .readFile(path.join(env.storage.templates, 'engy-default-template.docx'))
    .catch(() => null);

  if (!sample) {
    console.log('  SKIP  the default template is not built — run `npm run make:template`');
  } else {
    let converted = null;
    for (const candidate of candidates) {
      const result = await testPdfConverter(pdfConfig({ pdf: candidate }), sample);
      if (result.ok) {
        converted = { ...result, ...candidate };
        break;
      }
    }

    if (!converted) {
      console.log('  SKIP  no converter on this machine — install LibreOffice, or run this on a machine with Word');
    } else {
      check(
        `${converted.converter} converts a real template`,
        converted.bytes > 1000,
        JSON.stringify(converted)
      );

      const { buffer } = await docxToPdf(sample, { config: pdfConfig({ pdf: { converter: converted.converter } }) });
      check(
        'and what comes back is a PDF, by its own first five bytes',
        buffer.subarray(0, 5).toString('ascii') === '%PDF-',
        JSON.stringify(buffer.subarray(0, 8).toString('ascii'))
      );
      check(
        'with more than one page in it, which a real report has',
        /\/Type\s*\/Page[^s]/.test(buffer.toString('latin1')),
        'no page objects found'
      );
    }
  }
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
