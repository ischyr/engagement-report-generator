/**
 * Turning a generated .docx into a PDF, when something on this machine can.
 *
 * The app has never produced a PDF, and the documentation has always said so plainly: a `.docx` is
 * opened in Word and saved as one. That is an honest answer to "how do I get a PDF" and a poor
 * answer to "let me see what the report looks like without leaving the app" — which is the actual
 * question, and the one a preview answers.
 *
 * ## Why this is a converter and not a renderer
 *
 * Writing a PDF from the report data directly would mean a second layout engine beside the OOXML
 * one, and two engines means two documents that disagree — the preview would stop being evidence
 * about the thing being sent. So this converts *the exact bytes the Generate button produces*. What
 * is previewed is what was generated, or it is nothing.
 *
 * ## Two backends, because there are two realistic machines
 *
 *   - **LibreOffice** (`soffice --headless --convert-to pdf`) is the cross-platform answer and the
 *     one for a container. Every run gets its own user profile directory: a shared profile is what
 *     makes concurrent `soffice` invocations fight, and a report render is exactly the thing two
 *     people do at once.
 *   - **Word**, through PowerShell and COM, on a Windows machine that has Office. It is not a
 *     lesser option — it is the same program the report is written for, so its idea of the layout
 *     is the authoritative one — it simply only exists on Windows.
 *
 * Neither is a dependency of this app. Nothing is installed, nothing is bundled, and an instance
 * with no converter behaves exactly as it did before: the Generate button downloads a .docx and the
 * preview says, in one sentence, what would make it work.
 *
 * ## What it will not do
 *
 * **Trust the file names.** Everything happens in a directory made by `mkdtemp`, the input is
 * written under a name this file chooses, and the directory goes at the end whatever happened.
 * Neither backend is ever handed a name that came from a client.
 *
 * **Run for ever.** A converter that hangs holds a request open and, with LibreOffice, a process
 * that will still be there tomorrow. The child is killed at the timeout, and killed again harder
 * if it ignores that.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { badRequest } from '../utils/http-error.js';
import { log } from '../utils/logger.js';

/** What a converted document may weigh before something has clearly gone wrong. */
export const MAX_PDF_BYTES = 128 * 1024 * 1024;

export const PDF_CONVERTERS = {
  none: {
    label: 'None',
    note: 'The report downloads as a .docx, as it always has. Open it in Word to save a PDF.',
  },
  libreoffice: {
    label: 'LibreOffice',
    note: 'Cross-platform, and the one to use in a container. Install LibreOffice and leave the command as `soffice` unless it is somewhere unusual.',
    defaultCommand: 'soffice',
  },
  word: {
    label: 'Microsoft Word',
    note: 'Windows only, and needs Word installed for the account the server runs as. It is the program the templates are written for, so its layout is the authoritative one.',
    defaultCommand: 'powershell',
  },
};

/**
 * The instance's converter settings, with the defaults filled in.
 *
 * Shaped like `assistantConfig` and `mailConfig`: one function that decides whether the capability
 * is on, so a route never has to reason about a half-filled settings document.
 */
export function pdfConfig(settings) {
  const block = settings?.pdf ?? {};
  const converter = PDF_CONVERTERS[block.converter] ? block.converter : 'none';
  return {
    converter,
    enabled: converter !== 'none',
    command: String(block.command ?? '').trim() || PDF_CONVERTERS[converter]?.defaultCommand || '',
    timeoutSeconds: Math.min(Math.max(Number(block.timeoutSeconds) || 120, 10), 600),
    label: PDF_CONVERTERS[converter]?.label ?? 'None',
  };
}

/** Runs a program, resolving with its output and never leaving it running. */
function run(command, args, { timeoutMs, cwd }) {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { timeout: timeoutMs, cwd, windowsHide: true, maxBuffer: 8 * 1024 * 1024, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          /* `code` is ENOENT when the program is not installed, which is the common case. */
          code: error?.code ?? 0,
          killed: Boolean(error?.killed),
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? error?.message ?? ''),
        });
      }
    );
    /* Nothing is ever written to it, and a converter waiting on stdin is a converter that hangs. */
    child.stdin?.end();
  });
}

/**
 * Word, driven through PowerShell.
 *
 * `SaveAs` with format 17 is "PDF". The document is opened read-only with every prompt disabled —
 * an unattended Word that puts up a dialog is a Word that never returns — and the application is
 * quit in a `finally` so a failed conversion does not leave a headless copy running for ever.
 */
const WORD_SCRIPT = `
param([string]$In, [string]$Out)
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open($In, [ref]$false, [ref]$true)
  try { $doc.SaveAs([ref]$Out, [ref]17) } finally { $doc.Close([ref]$false) }
} finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
`;

/**
 * One .docx to one PDF.
 *
 * @param {Buffer} buffer the exact bytes the report render produced
 * @param {{config: object}} options
 * @returns {Promise<{buffer: Buffer, converter: string, ms: number}>}
 */
export async function docxToPdf(buffer, { config }) {
  if (!config?.enabled) {
    throw badRequest(
      'No PDF converter is set up on this instance. An administrator can point Settings at LibreOffice, or at Word on a Windows server.'
    );
  }
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw badRequest('There is nothing to convert.');

  const started = Date.now();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'engy-pdf-'));
  /* Names this file chose. Nothing from a template, an engagement or a client reaches the shell. */
  const input = path.join(dir, 'report.docx');
  const output = path.join(dir, 'report.pdf');
  const timeoutMs = config.timeoutSeconds * 1000;

  try {
    await fs.writeFile(input, buffer);

    let result;
    if (config.converter === 'word') {
      const script = path.join(dir, 'convert.ps1');
      await fs.writeFile(script, WORD_SCRIPT, 'utf8');
      result = await run(
        config.command || 'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-In', input, '-Out', output],
        { timeoutMs, cwd: dir }
      );
    } else {
      result = await run(
        config.command || 'soffice',
        [
          '--headless',
          '--norestore',
          /* Its own profile, so two renders at once do not fight over one. */
          `-env:UserInstallation=file:///${path.join(dir, 'profile').replace(/\\/g, '/')}`,
          '--convert-to',
          'pdf:writer_pdf_Export',
          '--outdir',
          dir,
          input,
        ],
        { timeoutMs, cwd: dir }
      );
    }

    let converted = null;
    try {
      converted = await fs.readFile(output);
    } catch {
      converted = null;
    }

    if (!converted?.length) {
      /* The message says what to do about it, because every one of these has a different fix. */
      if (result.code === 'ENOENT') {
        throw badRequest(
          `${config.label} was not found on this machine (tried "${config.command}"). Install it, or correct the command in Settings.`
        );
      }
      if (result.killed) {
        throw badRequest(
          `${config.label} did not finish within ${config.timeoutSeconds}s. A very long report may need a longer timeout in Settings.`
        );
      }
      throw badRequest(
        `${config.label} could not convert the document.${
          result.stderr ? ` It said: ${result.stderr.trim().slice(0, 300)}` : ''
        }`
      );
    }

    if (converted.length > MAX_PDF_BYTES) {
      throw badRequest('The converted PDF is implausibly large; something went wrong.');
    }
    /* Every PDF starts with these five bytes. Anything else is not one, whatever the file is called. */
    if (converted.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw badRequest(`${config.label} produced a file that is not a PDF.`);
    }

    return { buffer: converted, converter: config.converter, ms: Date.now() - started };
  } finally {
    /* Whatever happened. A temp directory per render, left behind, is a disk that fills up slowly. */
    await fs.rm(dir, { recursive: true, force: true }).catch((error) => {
      log.warn(`Could not clean up ${dir}: ${error.message}`);
    });
  }
}

/**
 * Whether the configured converter is actually there, for the button in Settings.
 *
 * Converts a real — if tiny — document rather than asking the program for its version: a version
 * string proves the binary exists and nothing about whether it can produce a PDF for the account
 * the server runs as, which is where this usually fails.
 */
export async function testPdfConverter(config, sampleDocx) {
  try {
    const { buffer, ms } = await docxToPdf(sampleDocx, { config });
    return { ok: true, bytes: buffer.length, ms, converter: config.converter };
  } catch (error) {
    return { ok: false, error: error.message, converter: config.converter };
  }
}

export default docxToPdf;
