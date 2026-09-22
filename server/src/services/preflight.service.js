/**
 * Checks an engagement for the things that embarrass people after a report has
 * been sent: a finding with no remediation, a leftover "TODO", an unwritten
 * executive summary, a CVSS vector nobody scored.
 *
 * Findings are graded so the list is actionable rather than a wall of nagging:
 *
 *   blocker  the report would be wrong or unusable if sent
 *   warning  almost certainly an oversight
 *   note     worth a glance, often deliberate
 *
 * Nothing here blocks generation. A tester mid-engagement wants the draft, and a
 * tool that refuses to produce one is a tool people work around.
 */

import {
  calculateCvss,
  orderFindings,
  CVSS_DEFAULT_VECTOR,
  CVSS4_DEFAULT_VECTOR,
} from './cvss.js';
import { htmlToPlainText } from './ooxml/html-parser.js';
import { danglingReferences, figuresOf } from './figures.service.js';

/** Placeholder text people leave behind. Word-bounded to avoid false hits. */
const PLACEHOLDER_RE = /\b(TODO|TBA|TBC|FIXME|XXX|LOREM IPSUM|PLACEHOLDER|\[.{0,20}\]\s*$)/i;
/** Names that suggest the template's example text was never replaced. */
const SAMPLE_RE = /\b(acme|example\.com|example\.org|foo|bar|test client|client name)\b/i;

/**
 * The shortest client name worth looking for in somebody's prose.
 *
 * Three characters and under produce false positives faster than they produce findings — a client
 * called "IT", "Sky" or "EY" would flag every paragraph that used the word. The check is only
 * worth having if people trust it, and a check that cries wolf on ordinary English is one people
 * turn off.
 */
const NAME_MIN = 4;

/**
 * Words that are somebody's client name *and* ordinary English.
 *
 * A company genuinely called "Data", "Group" or "Systems" would otherwise make this check fire on
 * half the report. Skipped rather than matched loosely: missing one real leak is better than
 * producing thirty false ones, because the thirty are what make somebody stop reading the list.
 */
const TOO_COMMON = new Set([
  'data',
  'group',
  'systems',
  'services',
  'solutions',
  'technology',
  'technologies',
  'digital',
  'global',
  'security',
  'consulting',
  'partners',
  'holdings',
  'international',
]);

const plain = (html) => htmlToPlainText(html ?? '').trim();
const isBlank = (html) => plain(html) === '';

/**
 * The fields of a finding that hold prose, and therefore pictures and references to them.
 *
 * Written out rather than derived: a rich-text field added later should be a deliberate addition
 * here, not something that silently starts being checked.
 */
const FIGURE_FIELDS = ['description', 'observation', 'remediation', 'poc'];

/**
 * A chip pointing at another finding, as the editor stores it.
 *
 * Matched here rather than imported from `report.service.js`, which would pull the whole report
 * builder into preflight for one expression. Kept identical to `FINDING_REFERENCE` there, and the
 * suite checks both against the same markup so they cannot drift apart unnoticed.
 */
const FINDING_REFERENCE =
  /<span\b[^>]*\bdata-findingref="([0-9a-f]{24})"[^>]*>([\s\S]*?)<\/span>/gi;

/** @typedef {{level:'blocker'|'warning'|'note', code:string, message:string,
 *   detail?:string, where?:string, findingId?:string, tab?:string}} PreflightIssue */

/**
 * How big a report may get before it stops being deliverable.
 *
 * Not a guess at what Word will produce: screenshots are already compressed, so a .docx weighs
 * about what its pictures weigh plus the text around them. The numbers are the ones the outside
 * world imposes — Outlook refuses attachments over 20 MB and Gmail over 25 — so a report is worth
 * a word at 15 and worth a warning at 20.
 */
const WEIGHT_MENTION = 15 * 1024 * 1024;
const WEIGHT_WARNING = 20 * 1024 * 1024;

const inMb = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * @param {object} audit populated audit document
 * @param {{media?: {count:number, bytes:number, oversized:object[], largest:object|null}}} [context]
 *   what the engagement's screenshots weigh, from `mediaWeight` — the route has the database, this
 *   function deliberately does not
 * @returns {{ready:boolean, counts:object, issues:PreflightIssue[], checked:number}}
 */
/**
 * Another client's name, left in prose that was copied from their report.
 *
 * The worst realistic mistake in this trade, and the only one on this list that ends a
 * relationship. Somebody writes up an issue by copying the paragraph they wrote for a different
 * client last month, changes the hostname, and misses the company name in the third sentence.
 * Nothing in the app looked at the words, so nothing could catch it.
 *
 * Checked against the *other* clients on this instance — this engagement's own client is expected
 * in its own report and is never flagged. Names too short or too ordinary are skipped; see
 * `NAME_MIN` and `TOO_COMMON` for why a check nobody trusts is worse than no check.
 *
 * A **blocker**, not a warning. Every other prose problem here produces an awkward report; this
 * one puts one client's name in another client's document.
 *
 * @param {{names: string[], label: string}[]} others other clients, each with the names to look for
 */
function foreignNames(text, others) {
  const found = [];
  for (const other of others) {
    for (const name of other.names) {
      if (name.length < NAME_MIN) continue;
      if (TOO_COMMON.has(name.toLowerCase())) continue;
      /* Word boundaries, so "Northwind" does not match inside "northwindow". */
      const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (pattern.test(text)) {
        found.push(other.label);
        break;
      }
    }
  }
  return found;
}

/**
 * Roughly how many pages the report will run to.
 *
 * Counted from the material rather than from a rendered document, because the point is to answer
 * the question *before* generating: nobody renders a draft to find out it is ninety pages.
 *
 * The constants are the only interesting part and they are all approximations of one thing — how
 * much of a page something takes in an A4 report at eleven point:
 *
 *   500 words     a full page of prose
 *   3 screenshots a page, since evidence is usually half-width and captioned
 *   40 table rows a page
 *   1 page        for each finding, which most templates start on a fresh one
 *
 * Returned as a range because a single number would be trusted. The spread is ±25%, which is about
 * the difference a template's margins and type size actually make.
 */
export function estimatePages(audit, media = null) {
  const text = (html) => htmlToPlainText(html ?? '');
  const words = (value) => {
    const trimmed = text(value).trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  };

  let total = 0;
  let rows = 0;
  for (const section of audit.sections ?? []) total += words(section.text);
  for (const finding of audit.findings ?? []) {
    total += words(finding.description) + words(finding.observation);
    total += words(finding.remediation) + words(finding.poc) + words(finding.scope);
  }
  /* Enumeration output prints as a pane, and a pane's lines are not words — count them as rows. */
  for (const step of audit.enumeration ?? []) {
    const output = String(step.output ?? '');
    if (output) rows += output.split(/\r?\n/).length;
    total += words(step.content);
  }

  const findings = (audit.findings ?? []).length;
  const sections = (audit.sections ?? []).length;
  const images = media?.count ?? countImages(audit);

  const pages = Math.max(
    1,
    Math.ceil(total / 500 + images / 3 + rows / 40 + findings * 0.6 + sections * 0.4)
  );

  return {
    pages,
    low: Math.max(1, Math.round(pages * 0.75)),
    high: Math.round(pages * 1.25),
    words: total,
    images,
    findings,
  };
}

/** Screenshots in the prose, when the caller has not already weighed the media. */
function countImages(audit) {
  let count = 0;
  const walk = (html) => {
    count += (String(html ?? '').match(/<img\b/gi) ?? []).length;
  };
  for (const section of audit.sections ?? []) walk(section.text);
  for (const finding of audit.findings ?? []) {
    walk(finding.description);
    walk(finding.observation);
    walk(finding.remediation);
    walk(finding.poc);
  }
  return count;
}

export function preflightAudit(
  audit,
  {
    media = null,
    templateTags = null,
    /**
     * Every *other* client on this instance, for the copy-paste check above.
     *
     * Passed in rather than queried, like the media weights: this function is pure and is called
     * from three places, and a database read inside it would make two of them slower for a check
     * the third already has the data for.
     */
    otherClients = [],
  } = {}
) {
  /** @type {PreflightIssue[]} */
  const issues = [];
  const add = (level, code, message, extra = {}) =>
    issues.push({ level, code, message, ...extra });

  /* ------------------------------ the essentials ----------------------------- */

  /*
   * Changes still standing on somebody else's system.
   *
   * A blocker rather than a warning, and it is the strongest opinion in this file. Every other
   * check here is about a document being incomplete; this one is about a client's production
   * environment being left modified. Approving a report is the moment a job is declared finished,
   * and a job with an un-reverted intrusive change is not finished — it is a phone call waiting to
   * happen, usually to somebody who has moved on to the next engagement.
   *
   * An action recorded as irreversible does not block: saying so is the honest answer, and the
   * report prints it either way so the client is told rather than reassured.
   */
  const outstanding = (audit.intrusions ?? []).filter(
    (entry) => entry.reversible !== false && !entry.revertedAt
  );
  if (outstanding.length) {
    add(
      'blocker',
      'intrusions-outstanding',
      `${outstanding.length} ${outstanding.length === 1 ? 'change has' : 'changes have'} not been put back.`,
      {
        detail:
          `On the Intrusive tab: ${outstanding
            .slice(0, 3)
            .map((entry) => entry.title || entry.target || 'an untitled change')
            .join('; ')}${outstanding.length > 3 ? `, and ${outstanding.length - 3} more` : ''}. ` +
          'Revert them, or mark them as not reversible so the report says so.',
        tab: 'intrusive',
      }
    );
  }

  /**
   * Output pasted in a hurry and never filed.
   *
   * A warning rather than a blocker, because an unfiled paste is not a fault — it is a note to
   * self that has not been dealt with, and there are honest reasons to sign off with one sitting
   * there. But it must be *said*: an unfiled step is held back from the report exactly as an
   * internal one is, so the alternative is discovering it by its absence from a document, weeks
   * later, when the person who pasted it has forgotten what it was.
   *
   * Two things to do with one, and the message says both: file it, or delete it. Neither is
   * "leave it and hope".
   */
  const unfiled = (audit.enumeration ?? []).filter((step) => step.unfiled);
  if (unfiled.length) {
    add(
      'warning',
      'enumeration-unfiled',
      `${unfiled.length} ${unfiled.length === 1 ? 'paste has' : 'pastes have'} not been filed.`,
      {
        detail:
          `In the tray on the Enumeration tab: ${unfiled
            .slice(0, 3)
            .map((step) => step.title || 'an untitled paste')
            .join('; ')}${unfiled.length > 3 ? `, and ${unfiled.length - 3} more` : ''}. ` +
          'File them into the tree, or delete them — an unfiled paste is held back from the report.',
        tab: 'enumeration',
      }
    );
  }

  if (!audit.template) {
    add('blocker', 'no-template', 'No report template is assigned.', {
      detail: 'Pick one on the Overview tab — nothing can be generated without it.',
      tab: 'overview',
    });
  }
  /*
   * A restricted report whose template never prints the marking.
   *
   * The only check here that reads the *template* rather than the engagement, and it is possible
   * because the template's tags are already analysed and stored when it is uploaded — so "does this
   * one carry the marking" is a lookup rather than a parse.
   *
   * A warning and not a blocker, deliberately. A firm may mark its documents by another route
   * entirely — a letterhead, a cover sheet, a footer typed into the template by hand — and an app
   * that refuses to generate on the strength of a missing tag would be wrong about that and
   * unarguable. What it can honestly say is that it looked and did not find one.
   */
  if (audit.classification === 'restricted' && Array.isArray(templateTags)) {
    /*
     * Normalised before comparing, because a tag is written several ways and all of them count:
     * `{{ .classificationLabel }}` carries a leading dot, and a marking wrapped in a condition is
     * `{{#isRestricted}}` — so a comparison against the bare names alone would look straight past
     * the way the shipped template actually does it.
     */
    const bare = (tag) => String(tag ?? '').trim().replace(/^[#^/&]+/, '').replace(/^\./, '');
    const marked = templateTags.some((tag) =>
      ['classification', 'classificationLabel', 'isRestricted'].includes(bare(tag))
    );
    if (!marked) {
      add('warning', 'unmarked-restricted', 'This engagement is restricted and the template does not print the marking.', {
        detail:
          'A handling marking belongs on the page somebody prints, not only in the app. Add '
          + '{{classificationLabel}} to the template’s header and footer, or {{#isRestricted}}…{{/isRestricted}} '
          + 'around a marking of your own.',
        tab: 'overview',
      });
    }
  }
  if (!audit.company) {
    add('warning', 'no-company', 'No client company is set.', {
      detail: 'The cover page and header will have a gap where the client name goes.',
      tab: 'overview',
    });
  }
  if (!audit.client) {
    add('note', 'no-client', 'No client contact is set.', {
      detail: 'Templates that print a "prepared for" line will leave it empty.',
      tab: 'overview',
    });
  }
  if (!audit.date) {
    add('warning', 'no-date', 'The report date is empty.', { tab: 'overview' });
  }
  if (!audit.date_start || !audit.date_end) {
    add('warning', 'no-window', 'The testing window is incomplete.', {
      detail: 'Clients routinely check the dates they paid for.',
      tab: 'overview',
    });
  } else if (audit.date_start > audit.date_end) {
    add('blocker', 'window-backwards', 'Testing starts after it ends.', {
      detail: `${audit.date_start} → ${audit.date_end}`,
      tab: 'overview',
    });
  }
  if (!audit.reference) {
    add('note', 'no-reference', 'No engagement reference set.', { tab: 'overview' });
  }
  if (SAMPLE_RE.test(audit.name ?? '')) {
    add('warning', 'sample-name', 'The engagement name still looks like example text.', {
      detail: audit.name,
      tab: 'overview',
    });
  }

  /* --------------------------------- scope ---------------------------------- */

  const hosts = (audit.scope ?? []).flatMap((group) => group.hosts ?? []);
  if (hosts.length === 0) {
    add('warning', 'no-scope', 'Nothing is recorded in scope.', {
      detail: 'A report that does not state what was tested is hard to act on.',
      tab: 'scope',
    });
  } else {
    const blank = hosts.filter((h) => !h.hostname && !h.ip).length;
    if (blank) {
      add('warning', 'blank-hosts', `${blank} scope row(s) have neither a hostname nor an IP.`, {
        tab: 'scope',
      });
    }
  }

  /* -------------------------------- sections -------------------------------- */

  const sections = audit.sections ?? [];
  if (sections.length === 0) {
    add('note', 'no-sections', 'This engagement has no narrative sections.', {
      detail: 'Most templates expect at least an executive summary.',
      tab: 'sections',
    });
  }
  for (const section of sections) {
    if (isBlank(section.text)) {
      // The executive summary is the part clients actually read.
      const level = section.field === 'executive_summary' ? 'blocker' : 'warning';
      add(level, 'empty-section', `"${section.name}" is empty.`, {
        where: section.name,
        tab: 'sections',
      });
      continue;
    }
    const text = plain(section.text);
    if (PLACEHOLDER_RE.test(text)) {
      add('warning', 'placeholder-section', `"${section.name}" still contains placeholder text.`, {
        detail: firstMatch(text, PLACEHOLDER_RE),
        where: section.name,
        tab: 'sections',
      });
    }
    /*
     * And somebody else's name.
     *
     * More likely here than on a finding, not less: an executive summary is the most-reused piece
     * of prose in this trade, and the sentence that names the client is usually the first one.
     */
    const foreign = foreignNames(text, otherClients);
    if (foreign.length) {
      add('blocker', 'other-client-named', `"${section.name}" names another client.`, {
        detail: `It mentions ${foreign.join(', ')}. That is almost always a paragraph copied from their report — read the whole section, not just the name.`,
        where: section.name,
        tab: 'sections',
      });
    }
  }

  /* -------------------------------- findings -------------------------------- */

  const findings = audit.findings ?? [];
  if (findings.length === 0) {
    add('note', 'no-findings', 'No findings recorded.', {
      detail: 'Fine for a clean result — make sure the summary says so explicitly.',
      tab: 'findings',
    });
  }

  /*
   * The numbers a reader sees, in the order they see them.
   *
   * An identifier is allocated when a finding is written and then never moves, which is the right
   * trade — a client writing remediation tickets against VULN-04 must keep getting the same
   * finding — but it means two deleted drafts and a reorder leave the report reading VULN-01,
   * VULN-04, VULN-07. Nothing said so before generating, and the .docx is where people noticed.
   *
   * A note rather than a warning, and deliberately so: the sequence is untidy, not wrong, and on a
   * re-issue it is not even fixable. Renumbering is refused once anything has been delivered.
   */
  if (findings.length > 1) {
    const printed = orderFindings(findings, { manual: audit.sortFindings === false });
    const ragged = printed.some((finding, index) => (finding.identifier ?? index + 1) !== index + 1);
    if (ragged) {
      const reads = printed
        .slice(0, 5)
        .map((finding, index) => String(finding.identifier ?? index + 1).padStart(2, '0'));
      add('note', 'finding-numbering', 'The findings do not print as a clean run of numbers.', {
        detail: `They read ${reads.join(', ')}${
          printed.length > 5 ? ', …' : ''
        } — deleting a draft or reordering leaves gaps. Renumber on the findings tab puts them in order; it is refused once a report has been delivered, because the numbers the client already holds are the ones to keep.`,
        tab: 'findings',
      });
    }
  }

  /* Which findings a reference could still point at, for the dangling check below. */
  const printedFindingIds = new Set(
    findings.map((finding) => String(finding._id ?? '').toLowerCase()).filter(Boolean)
  );

  const seenTitles = new Map();
  for (const finding of findings) {
    const id = finding._id?.toString();
    const label = finding.title || 'Untitled finding';
    const at = { findingId: id, where: label, tab: 'findings' };

    if (!finding.title?.trim()) {
      add('blocker', 'untitled-finding', 'A finding has no title.', at);
    }

    /*
     * A sentence pointing at a picture that is not there any more.
     *
     * The reference survives deleting the screenshot — it is a chip in the prose, not a link the
     * editor maintains — so the document would carry "as shown in (figure removed)". Caught here
     * because the alternative is catching it in the delivered file, and because the fix is thirty
     * seconds: put the picture back, or delete the words that promised it.
     */
    /*
     * A picture that will not travel.
     *
     * Stored evidence and a pasted data URI both end up inside the document; an `<img>` still
     * pointing at somebody else's server does not — generation cannot fetch it, so the report gets
     * "[image: https://…]" where the screenshot should be. It arrives by pasting from a web page
     * rather than from a proxy, which is a thing that happens.
     *
     * This was the one useful thing the Figures panel said that nothing else did. The panel is
     * gone; the check moved here, where it is read before a report goes out rather than while
     * somebody happens to be looking at a list.
     */
    const stranded = figuresOf(finding, FIGURE_FIELDS).filter(
      (figure) => !figure.media && !/^data:/i.test(figure.src)
    );
    if (stranded.length) {
      add(
        'warning',
        'remote-image',
        `"${label}" has ${stranded.length} picture${
          stranded.length === 1 ? '' : 's'
        } that will not travel.`,
        {
          ...at,
          detail: `Still pointing at ${
            stranded[0].src.slice(0, 80) || 'somewhere else'
          }. Generation cannot fetch it, so the report prints the address instead of the picture — paste it in again as a screenshot.`,
        }
      );
    }

    for (const dangling of danglingReferences(finding, FIGURE_FIELDS)) {
      add(
        'warning',
        'dangling-figure-reference',
        `"${label}" refers to a figure that will not be numbered.`,
        {
          ...at,
          detail: `The reference reads "${dangling.text || 'a figure'}" in the ${
            dangling.field
          }, and ${dangling.why}. It will print as "(figure removed)".`,
        }
      );
    }

    /*
     * A sentence pointing at a finding that is not in this report.
     *
     * The same failure as a dangling figure reference and caught the same way: the finding was
     * deleted after the sentence naming it was written, and the document will print "(finding
     * removed)" where the identifier should be. Better found here than by the client.
     *
     * Checked against every finding that will be printed — not the whole engagement — because a
     * reference to something held back is dangling as far as this deliverable is concerned.
     */
    for (const field of FIGURE_FIELDS) {
      for (const match of String(finding[field] ?? '').matchAll(FINDING_REFERENCE)) {
        if (printedFindingIds.has(match[1].toLowerCase())) continue;
        add(
          'warning',
          'dangling-finding-reference',
          `"${label}" refers to a finding that is not in this report.`,
          {
            ...at,
            detail: `The reference reads "${match[2].replace(/<[^>]+>/g, '') || 'a finding'}" in the ${field}. It will print as "(finding removed)".`,
          }
        );
      }
    }

    // Duplicate titles are usually two people writing up the same issue.
    const key = label.trim().toLowerCase();
    if (key && seenTitles.has(key)) {
      add('warning', 'duplicate-finding', `Two findings share the title "${label}".`, at);
    } else if (key) {
      seenTitles.set(key, id);
    }

    const cvss = calculateCvss(finding.cvssv3);
    if (!cvss.complete) {
      add('blocker', 'cvss-incomplete', `"${label}" has an incomplete CVSS vector.`, {
        ...at,
        detail: 'Severity and ordering both come from it, so the report cannot rank this.',
      });
    } else if (finding.cvssv3 === CVSS_DEFAULT_VECTOR || finding.cvssv3 === CVSS4_DEFAULT_VECTOR) {
      add('warning', 'cvss-unscored', `"${label}" is still on the default vector (score 0).`, {
        ...at,
        detail: 'It will be reported as informational.',
      });
    }

    if (isBlank(finding.description)) {
      add('blocker', 'no-description', `"${label}" has no description.`, at);
    }
    if (isBlank(finding.remediation)) {
      add('warning', 'no-remediation', `"${label}" has no remediation advice.`, {
        ...at,
        detail: 'This is the part the client acts on.',
      });
    }
    if (isBlank(finding.observation)) {
      add('note', 'no-impact', `"${label}" has no impact written.`, at);
    }
    // Anything scored high or above should show evidence.
    if ((cvss.baseScore ?? 0) >= 7 && isBlank(finding.poc)) {
      add('warning', 'no-poc', `"${label}" is ${cvss.baseSeverity} but has no proof of concept.`, {
        ...at,
        detail: 'High-severity claims get challenged; evidence settles it.',
      });
    }
    if ((finding.references ?? []).length === 0) {
      add('note', 'no-references', `"${label}" has no references.`, at);
    }

    for (const [field, value] of Object.entries({
      description: finding.description,
      remediation: finding.remediation,
      observation: finding.observation,
      poc: finding.poc,
    })) {
      if (isBlank(value)) continue;
      const text = plain(value);
      if (PLACEHOLDER_RE.test(text)) {
        add('warning', 'placeholder-finding', `"${label}" has placeholder text in ${field}.`, {
          ...at,
          detail: firstMatch(text, PLACEHOLDER_RE),
        });
      }
      /* Somebody else's name, in a paragraph copied from somebody else's report. */
      const foreign = foreignNames(text, otherClients);
      if (foreign.length) {
        add(
          'blocker',
          'other-client-named',
          `"${label}" names another client in ${field}.`,
          {
            ...at,
            detail: `The ${field} mentions ${foreign.join(', ')}. That is almost always a paragraph copied from their report — check the whole field, not just the name.`,
          }
        );
      }
    }

    const unresolved = (finding.comments ?? []).filter((c) => !c.resolved).length;
    if (unresolved) {
      add('note', 'open-comments', `"${label}" has ${unresolved} unresolved comment(s).`, at);
    }
  }

  /* ------------------------------- test checks ------------------------------- */

  const checks = audit.testChecks ?? [];
  if (checks.length) {
    /*
     * A blocked check is not an oversight. It is a recorded reason why something could not be
     * done, which is the opposite of the thing this warning is for — leaving it in the count
     * would mean the only way to clear the warning was to lie about the check.
     */
    const outstanding = checks.filter((check) => !check.done && !check.blocked);
    const blocked = checks.filter((check) => !check.done && check.blocked);
    if (blocked.length) {
      add('note', 'checks-blocked', `${blocked.length} test check(s) are blocked.`, {
        detail: blocked.map((c) => `${c.title} — ${c.blockedReason}`).join('; ').slice(0, 300),
        tab: 'checks',
      });
    }
    if (outstanding.length) {
      // A warning rather than a blocker: an unticked item may simply be out of
      // scope, and only the tester knows.
      add('warning', 'checks-outstanding', `${outstanding.length} test check(s) are not ticked off.`, {
        detail:
          outstanding.length <= 3
            ? outstanding.map((c) => c.title).join('; ')
            : `Including "${outstanding[0].title}" and ${outstanding.length - 1} more.`,
        tab: 'checks',
      });
    }
  }

  /* -------------------------------- workflow -------------------------------- */

  if (audit.state === 'EDIT' && findings.length > 0) {
    add('note', 'still-editing', 'This engagement is still marked in progress.', {
      detail: 'Move it to review when the writing is done.',
      tab: 'overview',
    });
  }

  /* ------------------------------- how long it will be ----------------------- */

  /*
   * An estimate of the page count, before there is a document to count.
   *
   * "Is this a forty-page report or a ninety-page one" decides whether the executive summary needs
   * cutting, and the only way to find out was to generate it and open it in Word. Nobody does that
   * on a draft, so the answer arrived when it was too late to act on.
   *
   * Deliberately rough, and said so. The real number depends on the template's margins, its type
   * size and where its page breaks fall — none of which this can see. What it can see is the
   * material: words at roughly 500 to a page, screenshots at about a third of a page each, table
   * rows at forty, and a page for each section and finding that starts on a fresh one in most
   * templates. That is close enough for the decision it informs and no closer, so it is reported
   * as a range rather than a number, because a single figure would be believed.
   */
  const estimate = estimatePages(audit, media);
  if (estimate.pages >= 1) {
    add('note', 'length-estimate', `This will come to roughly ${estimate.low}–${estimate.high} pages.`, {
      detail:
        `About ${estimate.words.toLocaleString()} words, ${estimate.images} screenshot${
          estimate.images === 1 ? '' : 's'
        } and ${estimate.findings} finding${estimate.findings === 1 ? '' : 's'}. ` +
        'A rough guide only — your template’s margins, type size and page breaks decide the real figure.',
      tab: 'overview',
    });
  }

  /* ------------------------------- what it will weigh ------------------------ */

  if (media?.bytes) {
    if (media.bytes >= WEIGHT_MENTION) {
      add(
        media.bytes >= WEIGHT_WARNING ? 'warning' : 'note',
        'report-weight',
        `The screenshots in this report come to ${inMb(media.bytes)}.`,
        {
          detail:
            media.bytes >= WEIGHT_WARNING
              ? 'Outlook refuses attachments over 20 MB and Gmail over 25, so this may not send. Replacing the largest captures with scaled ones is the quickest fix.'
              : 'Still sendable, but worth knowing before it grows.',
          where: media.largest?.filename || undefined,
          tab: 'evidence',
        }
      );
    }
    if (media.oversized.length) {
      /*
       * Uploaded before the browser started scaling them, or dropped straight into the database by
       * something else. Named because the fix is cheap and the alternative is a report nobody can
       * email — but a note rather than a warning: the document is correct, only fat.
       */
      add(
        'note',
        'oversized-images',
        `${media.oversized.length} screenshot${media.oversized.length === 1 ? ' is' : 's are'} far wider than the page can print.`,
        {
          detail: `Largest: ${media.oversized[0].filename || 'a capture'} at ${media.oversized[0].width}px and ${inMb(media.oversized[0].bytes)}. Re-uploading scales it to fit.`,
          tab: 'evidence',
        }
      );
    }
  }

  const counts = {
    blocker: issues.filter((i) => i.level === 'blocker').length,
    warning: issues.filter((i) => i.level === 'warning').length,
    note: issues.filter((i) => i.level === 'note').length,
  };

  return {
    // "Ready" means nothing is outright broken — warnings are the author's call.
    ready: counts.blocker === 0,
    clean: issues.length === 0,
    counts,
    issues,
    checked: findings.length + sections.length,
  };
}

function firstMatch(text, regex) {
  const match = regex.exec(text);
  if (!match) return undefined;
  const at = Math.max(0, match.index - 30);
  return `…${text.slice(at, match.index + match[0].length + 30).trim()}…`;
}

export default preflightAudit;
