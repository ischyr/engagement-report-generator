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

import { calculateCvss, CVSS_DEFAULT_VECTOR, CVSS4_DEFAULT_VECTOR } from './cvss.js';
import { htmlToPlainText } from './ooxml/html-parser.js';
import { danglingReferences, figuresOf } from './figures.service.js';

/** Placeholder text people leave behind. Word-bounded to avoid false hits. */
const PLACEHOLDER_RE = /\b(TODO|TBA|TBC|FIXME|XXX|LOREM IPSUM|PLACEHOLDER|\[.{0,20}\]\s*$)/i;
/** Names that suggest the template's example text was never replaced. */
const SAMPLE_RE = /\b(acme|example\.com|example\.org|foo|bar|test client|client name)\b/i;

const plain = (html) => htmlToPlainText(html ?? '').trim();
const isBlank = (html) => plain(html) === '';

/**
 * The fields of a finding that hold prose, and therefore pictures and references to them.
 *
 * Written out rather than derived: a rich-text field added later should be a deliberate addition
 * here, not something that silently starts being checked.
 */
const FIGURE_FIELDS = ['description', 'observation', 'remediation', 'poc'];

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
export function preflightAudit(audit, { media = null } = {}) {
  /** @type {PreflightIssue[]} */
  const issues = [];
  const add = (level, code, message, extra = {}) =>
    issues.push({ level, code, message, ...extra });

  /* ------------------------------ the essentials ----------------------------- */

  if (!audit.template) {
    add('blocker', 'no-template', 'No report template is assigned.', {
      detail: 'Pick one on the Overview tab — nothing can be generated without it.',
      tab: 'overview',
    });
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
  }

  /* -------------------------------- findings -------------------------------- */

  const findings = audit.findings ?? [];
  if (findings.length === 0) {
    add('note', 'no-findings', 'No findings recorded.', {
      detail: 'Fine for a clean result — make sure the summary says so explicitly.',
      tab: 'findings',
    });
  }

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
