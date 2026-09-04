/**
 * Builds one finished engagement, so the app can be shown to somebody without
 * touching real work.
 *
 *   npm run seed:demo              # create it (safe to re-run — replaces its own data)
 *   npm run seed:demo -- --clean   # remove everything it created
 *
 * It produces a complete engagement rather than a skeleton: a client and contact,
 * three team members, scope with services, five narrative sections, six findings
 * across the severity range with real screenshots stored as evidence, a partly
 * worked checklist ticked by different people, a review conversation including an
 * @mention, an approval, an activity trail, and a rendered .docx report.
 *
 * Everything it touches is prefixed or named after the demo client, and `--clean`
 * removes exactly that — so it can be run on an instance that already has real
 * engagements in it without any risk to them.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

import env from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { Activity } from '../models/activity.model.js';
import { Audit } from '../models/audit.model.js';
import { Checklist } from '../models/checklist.model.js';
import { Client } from '../models/client.model.js';
import { Company } from '../models/company.model.js';
import { Notification } from '../models/notification.model.js';
import { Settings } from '../models/settings.model.js';
import { Template } from '../models/template.model.js';
import { User } from '../models/user.model.js';
import { deleteMedia, mediaIdsInAudit, saveMedia } from '../services/media.service.js';
import { generateReport } from '../services/report.service.js';
import { ACTIONS, recordActivity } from '../services/activity.service.js';
import { log } from '../utils/logger.js';
import {
  DEMO_CHECKLIST_SLUGS,
  DEMO_COMPANY,
  DEMO_CONTACT,
  DEMO_ENGAGEMENT,
  DEMO_FINDINGS,
  DEMO_PREFIX,
  DEMO_SCOPE,
  DEMO_SECTIONS,
  DEMO_TICKED,
  DEMO_USERS,
} from './demo-data.js';

/** Documented in the log, because these are real accounts you can sign in as. */
const DEMO_PASSWORD = 'DemoPass123!';

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                */
/* -------------------------------------------------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (buffer) => {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

const chunk = (type, data) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
};

/**
 * A terminal-looking PNG: dark background, a lighter title bar, and rows of
 * "text" drawn as short bars.
 *
 * Written by hand rather than with an image library, because adding a native
 * dependency for demo data would be a poor trade. It is not a real screenshot, but
 * at a glance it reads as one, which is all the demo needs.
 */
function terminalPng({ width = 720, height = 260, accent = [110, 128, 245], lines = 9 }) {
  const bg = [13, 17, 23];
  const bar = [22, 27, 34];
  const text = [139, 148, 158];

  const row = (y) => {
    const pixels = Buffer.alloc(width * 3);
    const paint = (from, to, colour) => {
      for (let x = Math.max(0, from); x < Math.min(width, to); x++) {
        pixels[x * 3] = colour[0];
        pixels[x * 3 + 1] = colour[1];
        pixels[x * 3 + 2] = colour[2];
      }
    };

    paint(0, width, y < 28 ? bar : bg);

    // Window buttons in the title bar.
    if (y >= 11 && y <= 17) {
      for (const [index, colour] of [[0, [255, 95, 86]], [1, [255, 189, 46]], [2, [39, 201, 63]]]) {
        paint(16 + index * 18, 22 + index * 18, colour);
      }
    }

    // Rows of pseudo-text, with the first line in the accent colour.
    const lineHeight = Math.floor((height - 44) / lines);
    for (let line = 0; line < lines; line++) {
      const top = 40 + line * lineHeight;
      if (y < top || y > top + 7) continue;
      // A deterministic pseudo-random width per line, so it looks like output.
      const seed = (line * 2654435761) % 1000;
      const chars = 18 + (seed % 46);
      paint(20, 20 + chars * 7, line === 0 ? accent : text);
    }
    return pixels;
  };

  const raw = [];
  for (let y = 0; y < height; y++) {
    raw.push(Buffer.from([0]), row(y)); // filter byte 0 (None) per scanline
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(raw), { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** One image per evidence placeholder, tinted so they are distinguishable. */
const EVIDENCE = {
  waybill: { accent: [250, 62, 94], lines: 7 },
  enumeration: { accent: [46, 208, 138], lines: 11 },
  invoice: { accent: [255, 144, 44], lines: 8 },
};

/* -------------------------------------------------------------------------- */
/* Clean                                                                      */
/* -------------------------------------------------------------------------- */

async function clean() {
  const audits = await Audit.find({ name: DEMO_ENGAGEMENT.name });

  let images = 0;
  for (const audit of audits) {
    for (const id of mediaIdsInAudit(audit.toObject())) {
      if (await deleteMedia(id)) images += 1;
    }
    await Activity.deleteMany({ audit: audit._id });
    await Notification.deleteMany({ audit: audit._id });
  }
  const removedAudits = await Audit.deleteMany({ name: DEMO_ENGAGEMENT.name });

  const company = await Company.findOne({ name: DEMO_COMPANY.name });
  if (company) await Client.deleteMany({ company: company._id });
  await Client.deleteMany({ email: DEMO_CONTACT.email });
  await Company.deleteMany({ name: DEMO_COMPANY.name });

  const users = await User.deleteMany({ username: new RegExp(`^${DEMO_PREFIX}-`) });

  log.info(
    `Removed: ${removedAudits.deletedCount} engagement(s), ${images} image(s), ` +
      `${users.deletedCount} demo account(s), the demo client and its contacts.`
  );
}

/* -------------------------------------------------------------------------- */
/* Build                                                                      */
/* -------------------------------------------------------------------------- */

async function build() {
  // Replace rather than duplicate, so re-running is safe and predictable.
  await clean();

  /* ---------------------------------- people -------------------------------- */
  const team = [];
  for (const spec of DEMO_USERS) {
    team.push(
      await User.create({
        ...spec,
        password: DEMO_PASSWORD,
        // A demo account has to be able to sign in without an authenticator app.
        totpEnrolmentRequired: false,
        enabled: true,
        approvedAt: new Date(),
        lastSeenAt: null,
      })
    );
  }
  log.info(`Created ${team.length} demo accounts (password: ${DEMO_PASSWORD})`);

  const [lead, tester, reviewer] = team;

  /* ---------------------------------- client -------------------------------- */
  // Owned by the lead, so the demo behaves like real data under client scoping.
  const company = await Company.create({ ...DEMO_COMPANY, createdBy: lead._id });
  const contact = await Client.create({
    ...DEMO_CONTACT,
    company: company._id,
    createdBy: lead._id,
  });

  /* -------------------------------- evidence -------------------------------- */
  const evidence = {};
  for (const [name, options] of Object.entries(EVIDENCE)) {
    const stored = await saveMedia({
      buffer: terminalPng(options),
      contentType: 'image/png',
      filename: `${name}.png`,
      uploader: lead,
    });
    evidence[name] = stored.url;
  }
  log.info(`Stored ${Object.keys(evidence).length} evidence images`);

  /** Swaps `{{evidence:name}}` for a real stored reference. */
  const withEvidence = (html) =>
    String(html ?? '').replace(/\{\{evidence:(\w+)\}\}/g, (whole, name) =>
      evidence[name]
        ? `<img src="${evidence[name]}" alt="Screenshot: ${name}">`
        : whole
    );

  /* ------------------------------- the template ----------------------------- */
  const template = await Template.findOne({ kind: { $ne: 'html' } }).sort({ createdAt: 1 });
  if (!template) {
    log.warn('No Word template on this instance — run npm run seed, then upload one.');
  }

  /* ------------------------------ the engagement ---------------------------- */
  const audit = await Audit.create({
    ...DEMO_ENGAGEMENT,
    company: company._id,
    client: contact._id,
    template: template?._id ?? null,
    creator: lead._id,
    collaborators: [lead._id, tester._id],
    reviewers: [reviewer._id],
    approvals: [],
    scope: DEMO_SCOPE,
    sections: DEMO_SECTIONS,
    customFields: [],
  });

  /* -------------------------------- findings -------------------------------- */
  let identifier = 0;
  for (const spec of DEMO_FINDINGS) {
    identifier += 1;
    const author = team[spec.author ?? 0];
    const customFields = [];
    if (spec.cwe) customFields.push({ key: 'cwe', label: 'CWE', fieldType: 'input', value: spec.cwe });
    if (spec.owasp) {
      customFields.push({ key: 'owasp', label: 'OWASP', fieldType: 'input', value: spec.owasp });
    }

    audit.findings.push({
      identifier,
      title: spec.title,
      vulnType: spec.vulnType,
      category: spec.category,
      cvssv3: spec.cvssv3,
      priority: spec.priority ?? null,
      remediationComplexity: spec.remediationComplexity ?? null,
      remediationStatus: spec.remediationStatus ?? 'open',
      description: withEvidence(spec.description),
      observation: withEvidence(spec.observation),
      remediation: withEvidence(spec.remediation),
      poc: withEvidence(spec.poc),
      scope: withEvidence(spec.scope),
      references: spec.references ?? [],
      customFields,
      createdBy: author._id,
      updatedBy: author._id,
      sortIndex: identifier - 1,
      comments: (spec.comments ?? []).map((comment) => ({
        author: team[comment.author]._id,
        body: comment.body,
        resolved: false,
      })),
    });
  }

  /* ------------------------------- checklists ------------------------------- */
  const checklists = await Checklist.find({ slug: { $in: DEMO_CHECKLIST_SLUGS } });
  let order = 0;
  for (const checklist of checklists) {
    for (const check of checklist.checks) {
      order += 1;
      audit.testChecks.push({
        title: check.title,
        description: check.description ?? '',
        category: check.category ?? '',
        createdBy: lead._id,
        order,
      });
    }
  }

  // Tick a realistic subset, by different people, so coverage means something.
  const ticked = new Map(DEMO_TICKED.map(([title, who]) => [title.toLowerCase(), who]));
  let done = 0;
  for (const check of audit.testChecks) {
    const who = ticked.get(check.title.toLowerCase());
    if (who === undefined) continue;
    check.done = true;
    check.doneBy = team[who]._id;
    // Spread the timestamps across the testing window so the trail looks worked.
    // Built from parts rather than a string: a single-digit hour is not valid ISO.
    check.doneAt = new Date(Date.UTC(2026, 6, 21 + (done % 4), 9 + (done % 8), 15));
    if (check.title.startsWith('Test for SQL injection')) {
      check.result = 'Parameterised throughout; no injectable parameter found.';
    }
    done += 1;
  }

  await audit.save();
  log.info(
    `Created the engagement: ${audit.findings.length} findings, ` +
      `${audit.testChecks.length} checks (${done} verified), ` +
      `${audit.findings.reduce((sum, f) => sum + f.comments.length, 0)} comments`
  );

  /* ------------------------------- the trail -------------------------------- */
  // A believable activity log, in the order the work happened.
  await recordActivity({ audit, actor: lead, action: ACTIONS.AUDIT_CREATED, target: audit.name });
  await recordActivity({
    audit,
    actor: lead,
    action: ACTIONS.CHECKS_ADDED,
    meta: { added: audit.testChecks.length, preset: checklists.map((c) => c.name).join(', ') },
  });
  for (const finding of audit.findings) {
    const author = await User.findById(finding.createdBy);
    await recordActivity({
      audit,
      actor: author,
      action: ACTIONS.FINDING_CREATED,
      target: finding.title,
    });
  }
  for (const finding of audit.findings) {
    for (const comment of finding.comments) {
      const author = await User.findById(comment.author);
      await recordActivity({
        audit,
        actor: author,
        action: ACTIONS.COMMENT_ADDED,
        target: finding.title,
      });
    }
  }
  await recordActivity({
    audit,
    actor: lead,
    action: ACTIONS.STATE_CHANGED,
    meta: { from: 'EDIT', to: 'REVIEW' },
  });

  // The @mention in the invoice finding's comment, as a real notification.
  await Notification.create({
    user: reviewer._id,
    type: 'mention',
    actor: lead._id,
    audit: audit._id,
    auditName: audit.name,
    findingId: audit.findings[1]._id,
    target: audit.findings[1].title,
    message: `${lead.firstname} ${lead.lastname} mentioned you on "${audit.findings[1].title}"`,
    href: `/engagements/${audit._id}?tab=findings`,
  });
  await Notification.create({
    user: reviewer._id,
    type: 'review-requested',
    actor: lead._id,
    audit: audit._id,
    auditName: audit.name,
    message: `${lead.firstname} ${lead.lastname} moved "${audit.name}" into review`,
    href: `/engagements/${audit._id}`,
  });
  log.info(`Left 2 notifications for ${reviewer.username}`);

  /* -------------------------------- the report ------------------------------ */
  if (template) {
    try {
      const populated = await Audit.findById(audit._id).populate([
        { path: 'company' },
        { path: 'client' },
        { path: 'creator' },
        { path: 'collaborators' },
        { path: 'reviewers' },
        { path: 'testChecks.doneBy', select: 'username firstname lastname' },
        { path: 'findings.createdBy', select: 'username firstname lastname' },
      ]);
      const settings = await Settings.getSettings();
      const { buffer, filename } = await generateReport({
        audit: populated,
        template,
        settings,
        user: lead,
      });

      const outDir = path.join(env.storage.tmp);
      await fs.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, 'demo-report.docx');
      await fs.writeFile(outPath, buffer);
      log.info(`Rendered the report: ${outPath} (${(buffer.length / 1024).toFixed(0)} KB, ${filename})`);
    } catch (error) {
      log.warn(`Could not render the demo report: ${error.message}`);
    }
  }

  /* --------------------------------- summary -------------------------------- */
  log.info('');
  log.info('Demo data ready.');
  log.info(`  Engagement:  ${audit.name}`);
  log.info(`  Client:      ${company.name} (${contact.firstname} ${contact.lastname})`);
  log.info(`  Sign in as:  ${DEMO_USERS.map((u) => u.username).join(', ')}`);
  log.info(`  Password:    ${DEMO_PASSWORD}`);
  log.info('');
  log.info('Worth a look: the Findings tab (severity spread, authorship, a comment thread),');
  log.info('Checks (a part-worked methodology), Activity, Insights, and the client page.');
  log.info(`Sign in as ${DEMO_USERS[2].username} to see the inbox with a review and a mention.`);
  log.info('');
  log.info('Remove it all again with: npm run seed:demo -- --clean');
}

async function main() {
  const cleaning = process.argv.includes('--clean') || process.argv.includes('--reset');
  await connectDatabase();
  if (cleaning) await clean();
  else await build();
  await disconnectDatabase();
}

main().catch(async (error) => {
  log.error(error.stack ?? error.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
