/**
 * Proves the 16 MB wall is gone.
 *
 *   npm run test:media
 *
 * The point of moving evidence into GridFS was that an engagement could not hold
 * more than 16 MB of screenshots — MongoDB's per-document limit — and hit it by
 * failing the save outright, mid engagement. So the central check here is the
 * blunt one: store more evidence than that against one engagement, save it, read
 * it back, and generate the report.
 *
 * It also checks the parts that could quietly break: authentication on the serve
 * route (an <img> tag cannot send a bearer token), deduplication, the .docx and
 * HTML render paths, and that orphan collection does not eat images still in use.
 *
 * Everything it creates is removed at the end.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';
import zlib from 'node:zlib';
import PizZip from 'pizzip';

import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { createApp } from '../app.js';
import { signAccessToken, signMediaToken } from '../middleware/auth.js';
import { Audit } from '../models/audit.model.js';
import { Template } from '../models/template.model.js';
import { User } from '../models/user.model.js';
import { Settings } from '../models/settings.model.js';
import {
  collectOrphanMedia,
  deleteMedia,
  inlineMediaInHtml,
  loadMediaMap,
  mediaIdsInAudit,
  mediaIdsInHtml,
  saveMedia,
} from '../services/media.service.js';
import { buildReportData, generateReport } from '../services/report.service.js';
import { renderHtmlReport } from '../services/html-report.service.js';
import { log } from '../utils/logger.js';

let passed = 0;
const failures = [];
const check = (label, condition, detail) => {
  if (condition) {
    passed += 1;
    log.info(`  ok    ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    log.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

/**
 * A valid PNG of the requested byte size.
 *
 * Real image bytes, because the pipeline sniffs dimensions from the header and a
 * random blob would be rejected as unreadable. The bulk is a tIME-adjacent private
 * chunk, which decoders ignore, so the file stays valid at any size.
 */
function makePng(sizeBytes, seed = 0) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(8, 0); // width
  ihdr.writeUInt32BE(8, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.alloc(8 * (8 * 3 + 1), seed % 251);
  const idat = zlib.deflateSync(raw);

  const head = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
  ]);
  const tail = chunk('IEND', Buffer.alloc(0));

  const padding = sizeBytes - head.length - tail.length - 12;
  if (padding <= 0) return Buffer.concat([head, tail]);

  // A private ancillary chunk: lower-case first letter means "safe to ignore".
  const filler = Buffer.alloc(padding, (seed % 7) + 1);
  return Buffer.concat([head, chunk('prIv', filler), tail]);
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function main() {
  await connectDatabase();

  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const username = 'zz-media-test';
  await User.deleteOne({ username });
  const user = await User.create({
    username,
    email: `${username}@example.invalid`,
    password: 'media-test-password',
    role: 'admin',
    totpEnrolmentRequired: false,
    approvedAt: new Date(),
  });
  const accessToken = signAccessToken(user);
  const mediaCookie = signMediaToken(user);

  const storedIds = [];
  let auditId = null;

  try {
    /* ------------------------------------------------------- upload route --- */
    log.info('Upload and serve');

    const uploadViaApi = async (buffer, name, token = accessToken) => {
      const body = new FormData();
      body.append('file', new Blob([buffer], { type: 'image/png' }), name);
      const response = await fetch(`${base}/media`, {
        method: 'POST',
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body,
      });
      return { status: response.status, body: await response.json().catch(() => null) };
    };

    const first = await uploadViaApi(makePng(120_000, 1), 'shot-1.png');
    check('upload accepted', first.status === 201, JSON.stringify(first.body));
    check('it comes back as a url reference', first.body?.url?.startsWith('/api/media/'), first.body?.url);
    check('dimensions read from the header', first.body?.width === 8 && first.body?.height === 8);
    storedIds.push(first.body.id);

    const same = await uploadViaApi(makePng(120_000, 1), 'shot-1-again.png');
    check('an identical image is stored once', same.body?.id === first.body.id && same.body?.deduplicated === true);

    const anonymous = await fetch(`${base}/media/${first.body.id}`);
    check('images are not public', anonymous.status === 401, `got ${anonymous.status}`);

    const withBearer = await fetch(`${base}/media/${first.body.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    check('a bearer token can read one', withBearer.status === 200, `got ${withBearer.status}`);
    check('served with the right type', withBearer.headers.get('content-type') === 'image/png');
    const servedBytes = Buffer.from(await withBearer.arrayBuffer());
    check(
      'the bytes come back unchanged',
      crypto.createHash('sha256').update(servedBytes).digest('hex') ===
        crypto.createHash('sha256').update(makePng(120_000, 1)).digest('hex')
    );

    // The case the whole cookie exists for: an <img> tag, which cannot send a header.
    const viaCookie = await fetch(`${base}/media/${first.body.id}`, {
      headers: { Cookie: `engy_media=${mediaCookie}` },
    });
    check('an <img> tag can read one via the media cookie', viaCookie.status === 200, `got ${viaCookie.status}`);

    const etag = withBearer.headers.get('etag');
    const conditional = await fetch(`${base}/media/${first.body.id}`, {
      headers: { Authorization: `Bearer ${accessToken}`, 'If-None-Match': etag },
    });
    check('unchanged images are not re-sent', conditional.status === 304, `got ${conditional.status}`);

    const rejected = await uploadViaApi(Buffer.from('#!/bin/sh\necho hi\n'), 'evil.sh');
    check('a non-image is refused', rejected.status === 400, `got ${rejected.status}`);

    /* -------------------------------------------- past the 16 MB ceiling --- */
    log.info('More evidence than a MongoDB document can hold');

    const audit = await Audit.create({
      name: 'zz Media self-test',
      creator: user._id,
      sections: [{ field: 'executive_summary', name: 'Executive summary', text: '' }],
    });
    auditId = audit._id;

    // 6 × 4 MB = 24 MB of evidence. As data URIs that is ~32 MB of base64 inside
    // one document: twice the hard limit, and the save would fail.
    const SHOTS = 6;
    const SHOT_BYTES = 4 * 1024 * 1024;
    let evidence = '';
    for (let i = 0; i < SHOTS; i++) {
      const stored = await saveMedia({
        buffer: makePng(SHOT_BYTES, i + 10),
        contentType: 'image/png',
        filename: `evidence-${i}.png`,
        uploader: user,
        audit,
      });
      storedIds.push(stored.id);
      evidence += `<p>Step ${i + 1}</p><p><img src="${stored.url}" alt="step ${i + 1}"></p>`;
    }

    audit.findings.push({
      title: 'Evidence-heavy finding',
      cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N',
      description: '<p>Six full-size screenshots.</p>',
      poc: evidence,
    });
    await audit.save();

    const reloaded = await Audit.findById(auditId);
    const documentBytes = Buffer.byteLength(JSON.stringify(reloaded.toObject()));
    const evidenceBytes = SHOTS * SHOT_BYTES;

    check(
      `${(evidenceBytes / 1024 / 1024).toFixed(0)} MB of evidence saved without complaint`,
      reloaded.findings[0].poc.includes('/api/media/')
    );
    check(
      `the engagement document is still ${(documentBytes / 1024).toFixed(0)} KB, not ${(evidenceBytes / 1024 / 1024).toFixed(0)} MB`,
      documentBytes < 200 * 1024,
      `${documentBytes} bytes`
    );
    check(
      'the evidence is well past the 16 MB document limit',
      evidenceBytes > 16 * 1024 * 1024,
      `${(evidenceBytes / 1024 / 1024).toFixed(0)} MB`
    );

    const ids = mediaIdsInAudit(reloaded.toObject());
    check(`all ${SHOTS} references found in the engagement`, ids.size === SHOTS, `${ids.size}`);
    check('and each resolves to bytes', (await loadMediaMap(ids)).size === SHOTS);

    /* ----------------------------------------------------- report paths ---- */
    log.info('Reports');

    const settings = await Settings.getSettings();
    const wordTemplate = await Template.findOne({ kind: { $ne: 'html' } });
    if (wordTemplate) {
      const populated = await Audit.findById(auditId).populate('template');
      const report = await generateReport({ audit: populated, template: wordTemplate, settings });

      // Counted rather than weighed: a .docx is a zip, and these synthetic PNGs are
      // runs of one byte, so 24 MB of them deflates to almost nothing.
      const zip = new PizZip(report.buffer);
      const embedded = Object.keys(zip.files).filter((name) => /^word\/media\//.test(name));
      check(
        `the .docx embeds all ${SHOTS} stored screenshots`,
        embedded.length >= SHOTS,
        `${embedded.length} media part(s): ${embedded.slice(0, 3).join(', ')}`
      );

      const documentXml = zip.file('word/document.xml').asText();
      check(
        'and none of them fell back to a "missing image" marker',
        !documentXml.includes('image missing from storage')
      );
    } else {
      log.warn('  skip  .docx render — no Word template on this instance (run npm run seed)');
    }

    const htmlData = buildReportData(
      reloaded,
      settings,
      { parts: null, numbering: null },
      { target: 'html' }
    );
    const rendered = renderHtmlReport(
      '<h1>{{ .name }}</h1>{{#findings}}{{{ .rich.poc }}}{{/findings}}',
      htmlData,
      {}
    );
    check('the HTML report keeps references until asked otherwise', rendered.includes('/api/media/'));

    const media = await loadMediaMap(mediaIdsInAudit(reloaded.toObject()));
    const selfContained = inlineMediaInHtml(rendered, media);
    check(
      'and inlines them for delivery, so a saved copy still shows its evidence',
      selfContained.includes('data:image/png;base64,') && !selfContained.includes('/api/media/')
    );

    /* --------------------------------------------- the bytes, kept for a moment --- */
    {
      /*
       * A thirty-screenshot report pulled all thirty out of GridFS on every generation, and the
       * per-finding preview pulled the same handful again on every render. The bytes are the slow part
       * of a render that is otherwise string work.
       */
      const { mediaCacheReport, forgetMedia, loadMediaMap: loadAgain } = await import(
        '../services/media.service.js'
      );

      forgetMedia();
      const before = mediaCacheReport();
      const ids = mediaIdsInAudit((await Audit.findById(auditId)).toObject());
      await loadAgain(ids);
      const afterFirst = mediaCacheReport();
      await loadAgain(ids);
      const afterSecond = mediaCacheReport();

      check(
        'the first read of an image comes from storage',
        afterFirst.misses > before.misses && afterFirst.entries > 0,
        JSON.stringify(afterFirst)
      );
      check(
        'and the second comes from memory',
        afterSecond.hits > afterFirst.hits && afterSecond.misses === afterFirst.misses,
        JSON.stringify(afterSecond)
      );
      /*
       * Same bytes, or the cache is worse than no cache.
       *
       * Compared by id rather than by position: `loadMediaMap` fills its map inside a `Promise.all`,
       * so the insertion order is whichever read finished first — which differs between a run served
       * from memory and one that went to storage. Callers look entries up by id and never notice;
       * a test comparing two arrays positionally notices immediately, and blames the wrong thing.
       */
      const fromCache = await loadAgain(ids);
      forgetMedia();
      const fromStorage = await loadAgain(ids);
      const sameBytes = [...fromCache.entries()].every(([id, entry]) => {
        const fresh = fromStorage.get(id);
        if (entry === null || fresh === null) return entry === fresh;
        return Boolean(entry && fresh && entry.buffer.equals(fresh.buffer));
      });
      check(
        'with the same bytes either way',
        fromCache.size === fromStorage.size && sameBytes,
        `${fromCache.size} cached vs ${fromStorage.size} fresh`
      );

      const filled = mediaCacheReport();
      const [oneId] = [...ids];
      if (oneId) {
        forgetMedia(oneId);
        const afterForget = mediaCacheReport();
        check(
          // A purged client's screenshot must not outlive the purge in memory.
          'and forgetting one drops it',
          afterForget.entries === filled.entries - 1,
          `${filled.entries} → ${afterForget.entries}`
        );
      }
    }

    /* ----------------------------------------------- orphan collection ----- */
    log.info('Orphan collection');

    const orphan = await saveMedia({
      buffer: makePng(50_000, 99),
      contentType: 'image/png',
      filename: 'nobody-references-me.png',
    });
    storedIds.push(orphan.id);

    const graced = await collectOrphanMedia({ dryRun: true });
    check(
      'a fresh upload is inside the grace period, so it is left alone',
      !graced.orphans.some((file) => file._id.toString() === orphan.id)
    );

    const swept = await collectOrphanMedia({ graceMs: 0, dryRun: true });
    check(
      'past the grace period it is collectable',
      swept.orphans.some((file) => file._id.toString() === orphan.id)
    );
    check(
      'but referenced evidence never is',
      !swept.orphans.some((file) => storedIds.slice(1, 1 + SHOTS).includes(file._id.toString())),
      'in-use images were listed as orphans'
    );

    /* --------------------------------------------------------- plumbing ---- */
    check(
      'references are found in an attribute',
      mediaIdsInHtml('<img src="/api/media/0123456789abcdef01234567">').size === 1
    );
    check(
      'an outside url that merely looks similar is not treated as ours',
      mediaIdsInHtml('<img src="https://elsewhere.example/api/media/0123456789abcdef01234567">').size === 0
    );
  } finally {
    if (auditId) await Audit.deleteOne({ _id: auditId });
    for (const id of storedIds) await deleteMedia(id);
    await User.deleteOne({ username });
    await new Promise((resolve) => server.close(resolve));
    await disconnectDatabase();
  }

  log.info('');
  log.info(
    failures.length === 0 ? `RESULT: ${passed} checks passed` : `RESULT: ${passed} passed, ${failures.length} failed`
  );
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await mongoose.connection.close().catch(() => {});
  process.exit(1);
});
