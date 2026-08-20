/**
 * One search box over everything the caller is allowed to see: engagements,
 * findings inside them, library entries, notes and clients.
 *
 * Runs in the application rather than with a Mongo text index because the useful
 * matches live inside subdocument arrays and inside editor HTML. Engagement
 * counts here are small — tens, not millions — so scanning the caller's own
 * engagements is cheaper than maintaining indexes that still could not answer
 * "which finding mentions this host".
 */

import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { Client } from '../models/client.model.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { calculateCvss, findingSeverity } from '../services/cvss.js';
import { htmlToPlainText } from '../services/ooxml/html-parser.js';
import { visibleClientFilter } from '../utils/audit-scope.js';

const router = Router();

const querySchema = z.object({
  q: z.string().trim().min(2, 'Type at least two characters').max(120),
  limit: z.coerce.number().int().min(1).max(100).optional().default(40),
});

/** Case-insensitive, with regex metacharacters treated literally. */
const matcher = (needle) => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(escaped, 'i');
};

/** The same needle, but only where it is a word of its own — "xss" not "xssable". */
const wordMatcher = (needle) => {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
};

/**
 * What a field is worth when the query is found in it.
 *
 * A name is what somebody searched for; a body is where it happens to be mentioned. Sorting
 * everything by `updatedAt` — which is what this did — meant searching "XSS" returned whatever
 * was edited most recently rather than the finding actually called "Stored XSS", and the answer
 * moved every time anybody touched anything.
 */
const FIELD_WEIGHT = {
  title: 100,
  name: 100,
  reference: 95,
  category: 55,
  type: 50,
  company: 50,
  email: 60,
  description: 30,
  remediation: 30,
  'proof of concept': 25,
  impact: 25,
  'affected assets': 35,
  text: 25,
  content: 25,
};

/**
 * How well one piece of text answers the query.
 *
 * Weight of the field, plus how much of the field the query accounts for: an exact match is the
 * thing itself, a match at the start is usually the thing, and a whole word is a real mention
 * rather than a fragment of a longer one.
 */
function scoreField(field, value, regex, needle) {
  const plain = htmlToPlainText(value ?? '').trim();
  if (!plain || !regex.test(plain)) return 0;

  const base = FIELD_WEIGHT[field] ?? 20;
  const lower = plain.toLowerCase();
  const query = needle.toLowerCase();

  let bonus = 0;
  if (lower === query) bonus += 60;
  else if (lower.startsWith(query)) bonus += 30;
  if (wordMatcher(needle).test(plain)) bonus += 20;
  // A hit in three words of title says more than the same hit in three pages of prose.
  if (plain.length <= 80) bonus += 10;

  return base + bonus;
}

/** Best field, and what it scored — so the subtitle names the field the score came from. */
function bestMatch(haystacks, regex, needle) {
  let best = null;
  for (const [field, value] of Object.entries(haystacks)) {
    const score = scoreField(field, value, regex, needle);
    if (score && (!best || score > best.score)) best = { field, value, score };
  }
  return best;
}

/**
 * A small nudge for things touched recently, applied *after* relevance.
 *
 * Recency is a tiebreak in reporting work, not an answer: two findings that match equally well
 * should come back newest first, and a finding that matches badly should not outrank one that
 * matches well merely because somebody opened it this morning. Capped at 12, which is less than
 * the gap between any two field weights.
 */
function recencyBonus(updatedAt) {
  if (!updatedAt) return 0;
  const days = (Date.now() - new Date(updatedAt).getTime()) / 86_400_000;
  if (Number.isNaN(days) || days < 0) return 0;
  if (days <= 1) return 12;
  if (days <= 7) return 8;
  if (days <= 30) return 4;
  if (days <= 90) return 1;
  return 0;
}

/** A short window of text around the hit, so results explain themselves. */
function excerpt(text, regex, width = 90) {
  const plain = htmlToPlainText(text ?? '');
  const match = regex.exec(plain);
  if (!match) return '';
  const start = Math.max(0, match.index - Math.floor(width / 2));
  const slice = plain.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${start + width < plain.length ? '…' : ''}`;
}

router.get(
  '/',
  validate(querySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query;
    const regex = matcher(q);
    const results = [];

    /* ------------------------- engagements and findings ----------------------- */
    const visible =
      req.user.role === 'admin'
        ? {}
        : {
            $or: [
              { creator: req.user._id },
              { collaborators: req.user._id },
              { reviewers: req.user._id },
            ],
          };

    const audits = await Audit.find(visible)
      .select('name reference auditType findings sections notes company updatedAt')
      .populate({ path: 'company', select: 'name' })
      .limit(500);

    for (const audit of audits) {
      const label = `${audit.name}${audit.reference ? ` · ${audit.reference}` : ''}`;

      const auditHit = bestMatch(
        {
          name: audit.name,
          reference: audit.reference,
          type: audit.auditType,
          company: audit.company?.name,
        },
        regex,
        q
      );
      if (auditHit) {
        results.push({
          type: 'engagement',
          id: audit._id,
          title: audit.name,
          subtitle: [audit.reference, audit.company?.name].filter(Boolean).join(' · '),
          href: `/engagements/${audit._id}`,
          updatedAt: audit.updatedAt,
          score: auditHit.score + recencyBonus(audit.updatedAt),
          matched: auditHit.field,
        });
      }

      for (const finding of audit.findings ?? []) {
        const haystacks = {
          title: finding.title,
          description: finding.description,
          remediation: finding.remediation,
          'proof of concept': finding.poc,
          impact: finding.observation,
          'affected assets': finding.scope,
        };
        // The best field, not the first one that matched: a title hit and a body hit are not
        // worth the same, and the old `.find()` reported whichever came first in the object.
        const hit = bestMatch(haystacks, regex, q);
        if (!hit) continue;

        const cvss = calculateCvss(finding.cvssv3);
        const rated = findingSeverity(finding);
        results.push({
          type: 'finding',
          id: finding._id,
          title: finding.title,
          subtitle: `${label} — matched in ${hit.field}`,
          excerpt: hit.field === 'title' ? '' : excerpt(hit.value, regex),
          severity: rated.severity,
          /** The CVSS score, which is why the relevance one is called `score` nowhere near it. */
          cvssScore: cvss.baseScore,
          score: cvss.baseScore,
          href: `/engagements/${audit._id}/findings/${finding._id}`,
          updatedAt: finding.updatedAt ?? audit.updatedAt,
          relevance: hit.score + recencyBonus(finding.updatedAt ?? audit.updatedAt),
          matched: hit.field,
        });
      }

      for (const section of audit.sections ?? []) {
        const sectionHit = bestMatch({ name: section.name, text: section.text }, regex, q);
        if (!sectionHit) continue;
        results.push({
          type: 'section',
          id: section._id,
          title: section.name,
          subtitle: label,
          excerpt: excerpt(section.text, regex),
          href: `/engagements/${audit._id}?tab=sections`,
          updatedAt: audit.updatedAt,
          relevance: sectionHit.score + recencyBonus(audit.updatedAt),
          matched: sectionHit.field,
        });
      }

      for (const note of audit.notes ?? []) {
        const noteHit = bestMatch({ title: note.title, content: note.content }, regex, q);
        if (!noteHit) continue;
        results.push({
          type: 'note',
          id: note._id,
          title: note.title,
          subtitle: label,
          excerpt: excerpt(note.content, regex),
          href: `/engagements/${audit._id}?tab=notes`,
          updatedAt: note.updatedAt,
          relevance: noteHit.score + recencyBonus(note.updatedAt),
          matched: noteHit.field,
        });
      }
    }

    /* ----------------------------- library entries ---------------------------- */
    const library = await Vulnerability.find({
      $or: [
        { 'details.title': regex },
        { 'details.description': regex },
        { 'details.remediation': regex },
        { category: regex },
      ],
    }).limit(50);

    for (const entry of library) {
      const detail = entry.details?.[0] ?? {};
      const cvss = calculateCvss(entry.cvssv3);
      const entryHit =
        bestMatch(
          {
            title: detail.title,
            category: entry.category,
            type: detail.vulnType,
            description: detail.description,
            remediation: detail.remediation,
          },
          regex,
          q
        ) ?? { field: 'description', score: 20 };
      results.push({
        type: 'library',
        id: entry._id,
        title: detail.title || 'Untitled',
        subtitle: [entry.category, detail.vulnType].filter(Boolean).join(' · ') || 'Library entry',
        excerpt: excerpt(detail.description, regex),
        severity: cvss.baseSeverity,
        cvssScore: cvss.baseScore,
        score: cvss.baseScore,
        href: '/library',
        updatedAt: entry.updatedAt,
        relevance: entryHit.score + recencyBonus(entry.updatedAt),
        matched: entryHit.field,
      });
    }

    /* --------------------------------- clients -------------------------------- */
    // Scoped like the Clients & data page — otherwise search is a way around it, and
    // the subtitle names the company as well as the contact.
    const clients = await Client.find({
      $and: [
        { $or: [{ firstname: regex }, { lastname: regex }, { email: regex }, { title: regex }] },
        await visibleClientFilter(req.user),
      ],
    })
      .populate('company', 'name')
      .limit(20);

    for (const client of clients) {
      const name = [client.firstname, client.lastname].filter(Boolean).join(' ');
      const clientHit =
        bestMatch({ name, email: client.email, title: client.title }, regex, q) ?? {
          field: 'name',
          score: 60,
        };
      results.push({
        type: 'client',
        id: client._id,
        title: name || client.email,
        subtitle: [client.company?.name, client.email].filter(Boolean).join(' · '),
        href: '/data',
        updatedAt: client.updatedAt,
        relevance: clientHit.score + recencyBonus(client.updatedAt),
        matched: clientHit.field,
      });
    }

    /*
     * Best answer first, newest as the tiebreak.
     *
     * This used to sort on `updatedAt` alone, on the theory that recency is relevance in
     * reporting work. It is — between equally good matches. It is not a reason for a passing
     * mention in a note somebody edited this morning to outrank the finding that carries the
     * search term as its title.
     */
    results.sort(
      (a, b) =>
        (b.relevance ?? 0) - (a.relevance ?? 0) ||
        new Date(b.updatedAt ?? 0) - new Date(a.updatedAt ?? 0)
    );

    const byType = results.reduce((acc, r) => {
      acc[r.type] = (acc[r.type] ?? 0) + 1;
      return acc;
    }, {});

    res.json({
      query: q,
      total: results.length,
      byType,
      truncated: results.length > limit,
      results: results.slice(0, limit),
    });
  })
);

export default router;
