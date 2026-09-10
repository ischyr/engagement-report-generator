/**
 * One search box over everything the caller is allowed to see: engagements,
 * findings inside them, library entries, notes and clients.
 *
 * **Two phases, and the first one runs in Mongo.**
 *
 * Scoring has to happen here: the useful matches live inside subdocument arrays and inside editor
 * HTML, and no index can say *which* finding of an engagement mentioned a host or rank a title hit
 * above a hit three pages into a write-up. But deciding scoring runs on *nothing* is what this used
 * to do — every engagement the caller could see was loaded with its whole `findings`, `sections` and
 * `notes` arrays, and then `htmlToPlainText` parsed every prose field of every one of them looking
 * for a two-character needle. A firm with two hundred engagements read and parsed every finding it
 * had ever written to answer "xss", on every query, and threw all of it away.
 *
 * So the filter moved into the database. Phase one asks Mongo which engagements contain the needle
 * at all, across exactly the fields phase two scores; phase two is the code that was always here,
 * running on the handful of documents that can actually produce a result. Still a collection scan —
 * a case-insensitive substring cannot use an index, and the alternatives all break the search:
 * a text index tokenises, so `cros` would stop finding cross-site scripting and
 * `api-staging.acme.example` would stop being one word. But a scan inside the storage engine, over
 * documents already in its cache, instead of megabytes of BSON decoded into JavaScript and handed
 * to an HTML parser.
 *
 * **Phase one cannot be allowed to miss anything phase two would have found**, which is the whole
 * design constraint, and it is why the needle sent to Mongo is not the needle. Phase two scores the
 * *plain text*, so a search for `SQL injection` must still match `SQL <em>injection</em>` — the
 * stored bytes have a tag in the middle of the phrase. See `markupTolerant`.
 */

import { Router } from 'express';
import { z } from 'zod';

import { Audit } from '../models/audit.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { Client } from '../models/client.model.js';
import { Company } from '../models/company.model.js';
import asyncHandler from '../utils/async-handler.js';
import { validate } from '../middleware/validate.js';
import { calculateCvss, findingSeverity } from '../services/cvss.js';
import { htmlToPlainText } from '../services/ooxml/html-parser.js';
import { visibleAuditFilter, visibleClientFilter } from '../utils/audit-scope.js';
import { EnumerationBody } from '../models/enumeration-body.model.js';
import { isRestricted } from '../services/classification.service.js';

const router = Router();

/* -------------------------------------------------------------------------- */
/* Searching the tool output                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Its own endpoint, deliberately, and its own answer shape.
 *
 * The main search scans engagements, findings, sections, notes, library entries and clients — and
 * has never touched a byte of tool output, because output does not live on the engagement. It is a
 * separate collection holding up to 200 KB per step, which is exactly why it was left out: folding
 * it into a search that runs on every keystroke would mean dragging megabytes through Node to
 * answer "xss".
 *
 * But it is also where the answer to the question an operator asks most often lives — *where have I
 * seen this host before* — and the app is the only thing that could answer it. So: a second door,
 * opened on purpose, with the needle typed by somebody who means it.
 *
 * **A substring, not a text index.** A text index tokenises, and the things people look for here
 * are precisely the things tokenising destroys: `api-staging.acme.example`, `nginx/1.24.0`,
 * `10.0.5.0/24`. A regex is the right tool for a banner, and the metacharacters are escaped so a
 * needle with a dot in it stays a needle.
 *
 * **The filtering happens in Mongo**, not here. Sending the regex means the documents that do not
 * match are never loaded, which is the difference between this being viable and not.
 */
const outputQuerySchema = z.object({
  /*
   * Three characters, not two. This scans bodies rather than titles: "ip" matches every line of
   * every nmap run anybody has ever pasted, and the answer to that is not useful to anybody.
   */
  q: z.string().trim().min(3, 'Type at least three characters').max(200),
  limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

/** How many matching lines to keep from one step. Enough to recognise it, not enough to read it. */
const LINES_PER_STEP = 4;
/** And how many bodies to open at all, whatever matched. A cap on the bytes, not on the answer. */
const BODIES = 120;

/** One matching line, trimmed to something that fits on a row. */
function matchingLines(text, regex, limit) {
  const out = [];
  const lines = String(text ?? '').split(/\r?\n/);
  for (let index = 0; index < lines.length && out.length < limit; index += 1) {
    const line = lines[index];
    if (!regex.test(line)) continue;
    const trimmed = line.trim();
    out.push({
      /* One-based, because that is how everything else counts lines — including the note anchors. */
      line: index + 1,
      text: trimmed.length > 220 ? `${trimmed.slice(0, 220)}…` : trimmed,
    });
  }
  return out;
}

router.get(
  '/output',
  validate(outputQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query;
    const regex = matcher(q);

    /*
     * Which engagements this person may read the output of — a stricter question than which they
     * may see in a list.
     *
     * Restricted work is excluded unless they could actually open it. `assertMayOpen` refuses a
     * restricted engagement to an account without two-factor, and raw tool output is the most
     * sensitive material in the app: it is where a hash dump or a session cookie ends up. A search
     * that returned lines out of an engagement the searcher cannot open would be a way round that
     * rule rather than an exception to it.
     *
     * `visibleAuditFilter` rather than an access clause written out here, for the same reason the
     * main search now uses it: this one did remember to exclude the trash, but not that membership
     * can expire, and tool output is the last place to keep answering somebody whose access to the
     * engagement has run out.
     */
    const audits = await Audit.find(visibleAuditFilter(req.user))
      .select('name reference company enumeration classification updatedAt')
      .populate({ path: 'company', select: 'name' })
      .limit(500);

    const readable = audits.filter((audit) => !isRestricted(audit) || req.user.totpEnabled);
    const byId = new Map(readable.map((audit) => [String(audit._id), audit]));
    if (!byId.size) return res.json({ results: [], total: 0, scanned: 0 });

    const bodies = await EnumerationBody.find({
      audit: { $in: [...byId.keys()] },
      $or: [{ output: regex }, { content: regex }],
    })
      .select('audit step output content outputAt')
      .limit(BODIES);

    const results = [];
    for (const body of bodies) {
      const audit = byId.get(String(body.audit));
      if (!audit) continue;
      const step = (audit.enumeration ?? []).find(
        (entry) => String(entry._id) === String(body.step)
      );

      /*
       * The output as it was pasted, and the write-up as prose. Both are invisible to the main
       * search and both are places a hostname gets written down; the write-up is stripped of its
       * markup first so a search for "code" does not match every `<code>` tag in it.
       */
      const lines = matchingLines(body.output, regex, LINES_PER_STEP);
      const notes = matchingLines(htmlToPlainText(body.content ?? ''), regex, LINES_PER_STEP);
      if (!lines.length && !notes.length) continue;

      results.push({
        type: 'output',
        id: `${body.audit}:${body.step}`,
        title: step?.title || 'Untitled step',
        subtitle: [audit.name, step?.tool, step?.target].filter(Boolean).join(' · '),
        href: `/engagements/${body.audit}?tab=enumeration`,
        /** Which lines matched, so the answer is visible without opening anything. */
        lines,
        notes,
        /* A step held back from the report is still the team's own record — but say so. */
        internal: Boolean(step?.internal),
        engagement: { id: String(audit._id), name: audit.name, reference: audit.reference ?? '' },
        outputAt: body.outputAt,
        updatedAt: audit.updatedAt,
        /* The most matches wins, then the most recent run: a busy step is usually the right one. */
        score: lines.length + notes.length,
      });
    }

    results.sort(
      (a, b) =>
        b.score - a.score ||
        new Date(b.outputAt ?? 0) - new Date(a.outputAt ?? 0) ||
        a.title.localeCompare(b.title)
    );

    res.json({
      results: results.slice(0, limit),
      total: results.length,
      /*
       * How many bodies were opened, so a search that hit the ceiling can say so rather than
       * quietly presenting a partial answer as a complete one.
       */
      scanned: bodies.length,
      capped: bodies.length >= BODIES,
    });
  })
);


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

/* -------------------------------------------------------------------------- */
/* Phase one: which engagements could possibly match                          */
/* -------------------------------------------------------------------------- */

/**
 * Everything the parser throws away, and may therefore sit between any two characters.
 *
 * A tag, or a character reference — the two things that exist in the stored HTML and not in the
 * plain text phase two scores. Both alternatives start with a character that cannot start the
 * other, so at any position there is exactly one way to consume noise: the group is deterministic
 * and the whole pattern stays linear, which is the property that makes it safe to send to Mongo.
 */
/*
 * The lengths are bounded, which matters more than it looks.
 *
 * Unbounded, `<[^>]*>` on a field holding a stray `<` scans to the end of the field before
 * failing, and the enclosing `*` retries that from the next position — quadratic in the size of
 * the field, inside the database, driven by prose somebody typed. Both bounds are an order of
 * magnitude past any real tag or character reference (`&thetasym;` is the long one), so nothing
 * legitimate stops being skipped, and the scan stays linear.
 */
const NOISE = '(?:<[^>]{0,1000}>|&(?:[a-zA-Z][a-zA-Z0-9]{0,30}|#[0-9]{1,7});)*';

/**
 * The characters that survive into plain text as something other than themselves.
 *
 * An editor stores `&` as `&amp;` and `<` as `&lt;`, so a needle containing one of them is looking
 * for bytes that are not in the document. Whitespace is the interesting one: `htmlToPlainText`
 * invents a newline at every block boundary and a tab after every cell, so the space in
 * `foo bar` has to be allowed to match the `</p><p>` in `<p>foo</p><p>bar</p>` — which is why it
 * takes tags as well, and why it is the one class that must consume at least one character.
 */
const AS_STORED = {
  '&': '(?:&|&amp;|&#0*38;)',
  '<': '(?:<|&lt;|&#0*60;)',
  '>': '(?:>|&gt;|&#0*62;)',
  '"': '(?:"|&quot;|&#0*34;)',
  "'": "(?:'|&apos;|&#0*39;)",
};
const WHITESPACE = '(?:\\s|&nbsp;|&#0*160;|<[^>]{0,1000}>)+';

/**
 * The needle as it might actually be stored, so phase one cannot lose a result.
 *
 * Phase two scores `htmlToPlainText(field)`. Phase one has only the field. Between those two is
 * every tag the writer left in the middle of a phrase, and a plain `RegExp(needle)` sent to Mongo
 * would quietly miss all of them: `SQL injection` would not find `SQL <em>injection</em>`,
 * `admin` would not find `<b>ad</b>min`. Missing results is the one outcome an optimisation is not
 * allowed to have, so noise is permitted between every character.
 *
 * It is deliberately allowed to say yes too often — `a<i>b` is admitted for the needle `ab` even
 * though a word joined across a tag is unusual. A false yes costs one document read that phase two
 * discards; a false no costs a result nobody knows is missing.
 */
function markupTolerant(needle) {
  const characters = [...String(needle)];
  let pattern = '';
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const whitespace = /\s/.test(character);
    /* No noise before a whitespace class: it already takes tags, and two greedy groups in a row
       is the one shape that would make this backtrack. */
    if (index > 0 && !whitespace && !/\s/.test(characters[index - 1])) pattern += NOISE;
    pattern += whitespace
      ? WHITESPACE
      : (AS_STORED[character] ?? character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  }
  return new RegExp(pattern, 'i');
}

/**
 * Every field phase two looks at, as a filter Mongo can apply.
 *
 * Kept beside the scoring loops on purpose: a field added to a `haystacks` object down there and
 * forgotten up here would be a field the search silently stopped covering, which is exactly the
 * failure mode that does not show up as an error. The suite asserts the two lists agree.
 */
const CANDIDATE_FIELDS = [
  'name',
  'reference',
  'auditType',
  'findings.title',
  'findings.description',
  'findings.remediation',
  'findings.poc',
  'findings.observation',
  'findings.scope',
  'sections.name',
  'sections.text',
  'notes.title',
  'notes.content',
];

/**
 * The phase-one clause, including the one field that is not on the document.
 *
 * A hit on the client's name is scored from `company.name`, which lives in another collection — so
 * the companies whose name matches are resolved first and folded in as an id test. Two round trips
 * instead of one, and the second is a `distinct` over a small collection; the alternative is
 * loading every engagement in the instance in order to look at its populated company.
 */
async function candidateClause(needle) {
  const tolerant = markupTolerant(needle);
  const companies = await Company.distinct('_id', { name: matcher(needle) });
  return {
    $or: [
      ...CANDIDATE_FIELDS.map((field) => ({ [field]: tolerant })),
      ...(companies.length ? [{ company: { $in: companies } }] : []),
    ],
  };
}

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
  /* Parsed once and handed back with the score: the excerpt below wants the same plain text, and
     asking for it again meant a second full parse of the field that had just matched. */
  const parsed = htmlToPlainText(value ?? '');
  const plain = parsed.trim();
  if (!plain || !regex.test(plain)) return null;

  const base = FIELD_WEIGHT[field] ?? 20;
  const lower = plain.toLowerCase();
  const query = needle.toLowerCase();

  let bonus = 0;
  if (lower === query) bonus += 60;
  else if (lower.startsWith(query)) bonus += 30;
  if (wordMatcher(needle).test(plain)) bonus += 20;
  // A hit in three words of title says more than the same hit in three pages of prose.
  if (plain.length <= 80) bonus += 10;

  return { score: base + bonus, parsed };
}

/** Best field, and what it scored — so the subtitle names the field the score came from. */
function bestMatch(haystacks, regex, needle) {
  let best = null;
  for (const [field, value] of Object.entries(haystacks)) {
    const hit = scoreField(field, value, regex, needle);
    if (hit && (!best || hit.score > best.score)) {
      best = { field, value, score: hit.score, parsed: hit.parsed };
    }
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

/** A short window of text around the hit, from text that has already been parsed. */
function excerptFrom(plain, regex, width = 90) {
  const match = regex.exec(plain ?? '');
  if (!match) return '';
  const start = Math.max(0, match.index - Math.floor(width / 2));
  const slice = plain.slice(start, start + width).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${slice}${start + width < plain.length ? '…' : ''}`;
}

/** The same window, for the callers that hold HTML rather than a scored hit. */
function excerpt(text, regex, width = 90) {
  return excerptFrom(htmlToPlainText(text ?? ''), regex, width);
}

router.get(
  '/',
  validate(querySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, limit } = req.query;
    const regex = matcher(q);
    const results = [];

    /* ------------------------- engagements and findings ----------------------- */
    /*
     * `visibleAuditFilter`, which is what the rest of the app scopes itself by.
     *
     * This wrote its own access clause — creator, collaborator, reviewer — and in doing so left out
     * the two conditions the shared one carries. Trashed engagements were not excluded, so a
     * finding deleted last month still came back with a link to a page that refuses to open; and
     * membership that has run out was not checked, so somebody whose access to an engagement had
     * expired could still read its findings' titles and the first line of their write-ups out of
     * the search box. `audit-scope.js` names search in the list of callers that use this clause.
     * It was the one that did not.
     *
     * The `$and` is how a caller's own `$or` is folded in without the two being able to replace
     * each other: phase one is a big `$or` over field matches, access is a separate clause, and
     * both have to hold.
     */
    const candidates = await Audit.find(
      visibleAuditFilter(req.user, { $and: [await candidateClause(q)] })
    )
      .select('name reference auditType findings sections notes company classification updatedAt')
      .populate({ path: 'company', select: 'name' })
      .limit(500);

    /*
     * And the same two-factor rule the tool-output search applies.
     *
     * `assertMayOpen` refuses a restricted engagement to an account without a second factor, so
     * returning its findings here — with the title, the matched field and ninety characters of the
     * write-up — was a way round that rule rather than an exception to it. `classification` is in
     * the projection above for this line; without it every engagement reads as standard and the
     * filter silently passes everything.
     */
    const audits = candidates.filter((audit) => !isRestricted(audit) || req.user.totpEnabled);

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
          /* From the text `bestMatch` already parsed, not a second parse of the same field. */
          excerpt: hit.field === 'title' ? '' : excerptFrom(hit.parsed, regex),
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
      /*
       * How many engagements phase one admitted, which used to be all of them.
       *
       * Reported because it is the number that says whether this change is working on a given
       * instance, and because a search capped at 500 matching engagements should be able to say
       * so rather than presenting a partial answer as a complete one.
       */
      scanned: audits.length,
      capped: candidates.length >= 500,
      results: results.slice(0, limit),
    });
  })
);

export default router;
