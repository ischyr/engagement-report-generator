/**
 * Turns an audit document plus a .docx template into a rendered report.
 *
 * The pipeline is deliberately ordered: relationship ids for images and
 * hyperlinks must be allocated while the template data is being built (the
 * injected XML embeds them), but the media files themselves can only be written
 * after docxtemplater has rendered.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import PizZip from 'pizzip';

import env from '../config/env.js';
import { Settings } from '../models/settings.model.js';
import { htmlToOoxml } from './ooxml/html2ooxml.js';
import { htmlToPlainText } from './ooxml/html-parser.js';
import { sanitizeHtml } from './html-report.service.js';
import { loadMediaMap, mediaIdsInAudit } from './media.service.js';
import { formatDate } from './template-parser.js';
import {
  calculateCvss,
  findingSeverity,
  describeMetrics,
  severityColor,
  PRIORITY_LABELS,
  COMPLEXITY_LABELS,
} from './cvss.js';
import { HttpError, badRequest, unprocessable } from '../utils/http-error.js';
import { openTemplate, ooxmlOptionsFor, renderDocx, safeDocName } from './docx-render.service.js';
import { provenanceFor, outputHash } from './provenance.service.js';
import { freshApprovals } from '../utils/report-fingerprint.js';
import { RECIPIENT_ROLE_LABELS } from '../models/audit.model.js';
// One definition of "how much evidence", shared with the model that stores the count and
// the engagement list that reads it.
import { countImages } from '../utils/evidence.js';
// Only for the empty case: an engagement with nothing logged still gets honest zeros.
import { detectionSummary } from './detection.service.js';
import { eachTag, stepScope } from './tag-scan.js';

/**
 * The public report settings that apply to one engagement.
 *
 * Exported because the routes that hand a `dateFormat` to something else — the delivery
 * table, the findings spreadsheet — have to agree with what the report itself used, or two
 * documents delivered together will format the same date two ways.
 */
export function resolveReportSettings(settings, company) {
  const base = settings?.report?.public ?? {};
  const overrides = company?.report ?? {};
  const merged = { ...base };
  const plain = typeof overrides.toObject === 'function' ? overrides.toObject() : overrides;
  for (const [key, value] of Object.entries(plain)) {
    // An empty override is not an override. Booleans and numbers are kept as they are.
    if (value === '' || value === null || value === undefined) continue;
    /*
     * A nested block merges key by key, not wholesale: a client who renamed only "Critical"
     * would otherwise blank the other four, and the standard words are what the other four
     * should stay.
     */
    if (typeof value === 'object' && !Array.isArray(value)) {
      const nested = { ...(base[key] ?? {}) };
      for (const [innerKey, innerValue] of Object.entries(value)) {
        if (innerValue === '' || innerValue === null || innerValue === undefined) continue;
        nested[innerKey] = innerValue;
      }
      merged[key] = nested;
      continue;
    }
    merged[key] = value;
  }
  return merged;
}

/** Fields that carry editor HTML and therefore get a `rich.*` counterpart. */
const FINDING_RICH_FIELDS = ['description', 'observation', 'remediation', 'poc', 'scope'];
const SECTION_RICH_FIELDS = ['text'];

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'None'];

const REMEDIATION_STATUS_LABELS = {
  open: 'Not fixed',
  retesting: 'Retesting',
  fixed: 'Fixed',
};

const asPlain = (html) => htmlToPlainText(html ?? '');

/**
 * Fields that exist for the team and must never reach a client deliverable.
 *
 * The finding object is spread wholesale into the template scope, so anything
 * added to the schema is exposed by default. Comments are candid review notes and
 * notes are the tester's scratchpad — either appearing in a sent report would be a
 * serious mistake, so they are stripped by name here rather than relying on
 * template authors not to reference them.
 */
const INTERNAL_FINDING_FIELDS = ['comments', 'createdBy', 'updatedBy'];

/**
 * Numbers the captioned screenshots in a block of rich text.
 *
 * A caption is worth little if the text cannot point at it, so each `<figcaption>`
 * gains a label the author can quote — "as Figure 3.2 shows".
 *
 * **Numbered per finding or section, not across the document**, because the template
 * decides what order blocks appear in and this code cannot know it: a global counter
 * would be wrong the moment somebody moved the appendix or printed findings before
 * the narrative. Within a finding the counter is prefixed with that finding's own
 * number, which is stable, so "Figure 3.2" means the same thing whatever the layout.
 *
 * A caption that already starts with "Figure" is left as the author wrote it, but
 * still consumes a number, so a hand-written label cannot collide with a generated
 * one further down.
 */
const FIGURE_CAPTION_RE = /(<figcaption\b[^>]*>)([\s\S]*?)(<\/figcaption>)/gi;
const ALREADY_LABELLED = /^\s*(?:figure|fig\.?|image|screenshot)\b/i;

function numberFigures(html, prefix, counter) {
  if (typeof html !== 'string' || !html.includes('<figcaption')) return html ?? '';
  return html.replace(FIGURE_CAPTION_RE, (_whole, open, inner, close) => {
    // Incremented even when the author labelled it themselves, so their "Figure 2"
    // and a generated one can never both be number two.
    const label = `${prefix}${(counter.n += 1)}`;
    const text = inner.trim();
    if (ALREADY_LABELLED.test(text)) return `${open}${inner}${close}`;
    return `${open}Figure ${label}${text ? ` — ${text}` : ''}${close}`;
  });
}

/**
 * The order figures are counted in across a finding's fields.
 *
 * Reading order, which is the order every shipped template prints them in — a
 * screenshot in the proof of concept comes after one in the description.
 */
const FIGURE_FIELD_ORDER = ['description', 'observation', 'poc', 'remediation', 'scope'];

/**
 * Applies figure numbering across several fields with one shared counter, so a
 * finding's second screenshot is Figure n.2 even when it sits in a different field
 * from the first.
 */
function numberFiguresAcross(source, fields, prefix) {
  const rank = (field) => {
    const at = FIGURE_FIELD_ORDER.indexOf(field);
    return at === -1 ? FIGURE_FIELD_ORDER.length : at;
  };
  const counter = { n: 0 };
  const out = { ...source };
  for (const field of [...fields].sort((a, b) => rank(a) - rank(b))) {
    out[field] = numberFigures(source?.[field] ?? '', prefix, counter);
  }
  return out;
}

/**
 * Builds `{ description: 'plain text', rich: { description: … } }` for an
 * object's rich-text fields.
 *
 * `rich.*` holds whatever the target needs: WordprocessingML for a .docx
 * template, sanitised HTML for an HTML one. The tag names stay identical so the
 * same Tag reference — and the same finding — serves both.
 */
function expandRichFields(source, fields, ooxmlOptions, target) {
  const plain = {};
  const rich = {};
  for (const field of fields) {
    const html = source?.[field] ?? '';
    plain[field] = asPlain(html);
    rich[field] = target === 'html' ? sanitizeHtml(html) : htmlToOoxml(html, ooxmlOptions);
  }
  return { plain, rich };
}

/** References as a list, in whichever markup the target speaks. */
function richReferences(references, ooxmlOptions, target) {
  const list = (references ?? []).filter(Boolean);
  if (!list.length) return target === 'html' ? '' : htmlToOoxml('', ooxmlOptions);
  const html = `<ul>${list
    .map((entry) => `<li>${String(entry).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</li>`)
    .join('')}</ul>`;
  return target === 'html' ? sanitizeHtml(html) : htmlToOoxml(html, ooxmlOptions);
}

/** The engagement state in words, for a document control table. */
const AUDIT_STATE_LABELS = {
  EDIT: 'In progress',
  REVIEW: 'In review',
  APPROVED: 'Approved',
};

/** A custom field's value by key, case-insensitively. */
function customFieldValue(fields, key) {
  const needle = key.toLowerCase();
  const match = (fields ?? []).find((field) => String(field.key ?? '').toLowerCase() === needle);
  return match?.value ?? '';
}

function userSummary(user) {
  if (!user) return null;
  /*
   * Qualifications, because real reports name them: "Tested by I. Schifirnet (OSCP, CRT)".
   * Names only — an issuer and an expiry are the firm's business, not the client's — and
   * empty for a client contact, which has no such field and never will.
   */
  const certifications = (user.profile?.certifications ?? [])
    .map((entry) => entry.name)
    .filter(Boolean);

  return {
    username: user.username ?? '',
    firstname: user.firstname ?? '',
    lastname: user.lastname ?? '',
    fullname:
      [user.firstname, user.lastname].filter(Boolean).join(' ') || user.username || '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    title: user.title ?? '',
    role: user.role ?? '',
    certifications,
    /** The same list on one line, for a signature block. */
    qualifications: certifications.join(', '),
  };
}

/**
 * Custom field values as text, keyed for `{{ .custom.KEY }}`.
 *
 * Every field type has to end up as something printable: a multiselect is a list, a
 * checkbox is a boolean, and an `editor` field holds HTML — which would otherwise
 * print its own tags into the document.
 */
function customFieldMap(list = []) {
  const map = {};
  for (const field of list) {
    if (!field?.key) continue;

    const value = field.value;
    if (Array.isArray(value)) map[field.key] = value.filter(Boolean).join(', ');
    else if (typeof value === 'boolean') map[field.key] = value ? 'Yes' : 'No';
    else if (field.fieldType === 'editor') map[field.key] = asPlain(value);
    else map[field.key] = value ?? '';
  }
  return map;
}

/**
 * The formatted counterpart for `editor` custom fields: `{{@rich.custom.KEY}}`.
 *
 * Only those, because the other types have no formatting to preserve — and a rich
 * tag for a date would just be a heavier way to print a date.
 */
function customFieldRich(list = [], ooxmlOptions, target) {
  const map = {};
  for (const field of list) {
    if (!field?.key || field.fieldType !== 'editor') continue;
    const html = field.value ?? '';
    map[field.key] = target === 'html' ? sanitizeHtml(html) : htmlToOoxml(html, ooxmlOptions);
  }
  return map;
}

/**
 * Assembles the object every template tag resolves against.
 *
 * @param {object} audit  a populated (lean-ish) audit document
 * @param {object} settings
 * @param {object} ooxmlOptions passed through to the HTML→OOXML writer
 * @param {{target?: 'docx'|'html', user?: object, templateName?: string}} [options]
 *   `user` and `templateName` only feed the document-control tags (`generatedBy`,
 *   `templateName`); leaving them out renders those empty rather than failing.
 */
export function buildReportData(audit, settings, ooxmlOptions, options = {}) {
  /** 'docx' emits WordprocessingML for rich fields, 'html' emits sanitised HTML. */
  const target = options.target === 'html' ? 'html' : 'docx';
  /*
   * The instance's report settings, with this client's overrides on top.
   *
   * Merged here rather than in each caller so every path gets it — the .docx, the HTML
   * render, the spreadsheet and the debug view. Only non-empty overrides count: a blank field
   * on the client means "whatever the instance says", not "blank".
   */
  const pub = resolveReportSettings(settings, audit?.company);
  const cvssColors = pub.cvssColors ?? {};
  const dateFormat = pub.dateFormat ?? 'yyyy-MM-dd';
  const prefix = pub.findingIdPrefix ?? '';

  /**
   * What to call a severity in *this* report.
   *
   * Standard words unless the client has their own scale. `None` reads as "Informational" by
   * default, which is what it has always printed as — the raw enum value is a poor thing to
   * put in front of a reader.
   */
  const severityWords = pub.severityLabels ?? {};
  const severityLabel = (severity) => {
    const key = String(severity ?? 'None').toLowerCase();
    const own = severityWords[key];
    if (own) return own;
    return severity === 'None' ? 'Informational' : severity;
  };
  /**
   * Where each finding has been reported to this client before, keyed by finding id.
   *
   * Passed in rather than looked up here, because it is a query across other
   * engagements while this function is deliberately synchronous. Absent — a preview,
   * or a client with no history — simply means no finding claims a past life.
   */
  /**
   * Hours logged against this engagement, from `effortFor()`.
   *
   * Passed in for the same reason as `history` — it is a query, and this function is
   * synchronous. When it is absent, or nothing was logged, `effort.recorded` is false so a
   * template can leave the sentence out rather than telling the client the job took no
   * time at all.
   */
  const effort = options.effort ?? null;

  /**
   * The delivery record, from `deliveriesFor()` — a document-control table that is kept
   * because the team keeps it, rather than retyped into the template every issue.
   */
  const deliveryLog = options.deliveries ?? null;

  /**
   * What the client agreed to change about the scope while testing was under way, from
   * `scopeChangesFor()`. The scope itself is only ever the end state.
   */
  const scopeLog = options.scopeChanges ?? null;

  /**
   * What the operators did and whether anybody on the client's side noticed, from
   * `detectionFor()`.
   *
   * Kept out of `stats` on purpose: every number in there describes what we found, and these
   * describe what *they* saw. Mixing them would put "43% detected" next to "9 findings" as if
   * they were two measures of the same thing.
   */
  const detectionLog = options.detection ?? null;

  /**
   * A phishing campaign's mailing list and what happened, from `phishingFor()`.
   *
   * Its own block rather than folded into `stats`, for the same reason detection is: every number
   * in `stats` describes findings, and these describe people.
   */
  const phishingLog = options.phishing ?? null;

  /**
   * The team's drawn signatures, from `signaturesFor()`.
   *
   * Separate from `approvals`, which is the internal review record: one is a mark for the
   * document, the other is assurance about the text, and printing the first as if it were the
   * second would put a governance meaning on a drawing.
   */
  const signatureLog = options.signatures ?? null;
  /** Filled in by the getter below, the first time a template actually asks for the block. */
  let signatureBlock;

  const history = options.history ?? new Map();
  const historyFor = (id) =>
    (typeof history.get === 'function' ? history.get(String(id)) : history[String(id)]) ?? [];

  /* --------------------------------- findings -------------------------------- */
  const rawFindings = Array.isArray(audit.findings) ? [...audit.findings] : [];

  const findings = rawFindings.map((finding, position) => {
    const raw = typeof finding.toObject === 'function' ? finding.toObject() : finding;
    // Drop internal fields before anything is spread into the template scope.
    const source = { ...raw };
    for (const field of INTERNAL_FINDING_FIELDS) delete source[field];

    const cvss = calculateCvss(source.cvssv3);
    // Severity, with an override respected — one answer for the report, the counts and the app.
    const rated = findingSeverity(source);
    // Figures carry the finding's own number, which is why this happens here rather
    // than in the pass below that assigns ids: numbering has to be woven into the
    // HTML before it becomes WordprocessingML.
    const numbered = numberFiguresAcross(
      source,
      FINDING_RICH_FIELDS,
      `${source.identifier ?? position + 1}.`
    );
    const { plain, rich } = expandRichFields(numbered, FINDING_RICH_FIELDS, ooxmlOptions, target);
    const custom = customFieldMap(source.customFields);

    return {
      ...source,
      ...plain,
      rich: {
        ...rich,
        // References read best as a bullet list.
        references: richReferences(source.references, ooxmlOptions, target),
        // Formatted values for any editor-type custom fields on this finding.
        custom: customFieldRich(source.customFields, ooxmlOptions, target),
      },
      references: source.references ?? [],
      referencesText: (source.references ?? []).join('\n'),

      /**
       * The same issue in this client's earlier engagements, newest first.
       *
       * This is the sentence a client acts on — "we told you in March and it is still
       * here" — and it was unwritable before, because nothing joined a finding to the
       * last assessment. Each entry carries `reference`, `auditName`, `date`,
       * `severity` and `remediationStatus`.
       */
      previously: historyFor(source._id).map((occurrence) => ({
        ...occurrence,
        date: occurrence.date ? formatDate(occurrence.date, dateFormat) : '',
      })),
      previouslyReported: historyFor(source._id).length > 0,
      /** "PT-2025-004, PT-2024-011" — for a sentence rather than a loop. */
      previouslyIn: historyFor(source._id)
        .map((occurrence) => occurrence.reference || occurrence.auditName)
        .filter(Boolean)
        .join(', '),
      /** When this client was first told about it, formatted. */
      firstReported: (() => {
        const oldest = historyFor(source._id).at(-1);
        return oldest?.date ? formatDate(oldest.date, dateFormat) : '';
      })(),
      cvss: {
        vector: cvss.vector || source.cvssv3 || '',
        /** '3.1' or '4.0' — findings may be scored either way. */
        version: cvss.version,
        /** 'CVSS:3.1', or for 4.0 which parts were filled in: CVSS-B/BT/BE/BTE. */
        nomenclature: cvss.nomenclature,
        score: cvss.baseScore ?? '',
        baseScore: cvss.baseScore ?? '',
        severity: cvss.baseSeverity,
        color: severityColor(cvss.baseSeverity, cvssColors),
        temporalScore: cvss.temporalScore ?? '',
        temporalSeverity: cvss.temporalSeverity,
        // v4.0's name for the temporal idea; both are always present so a
        // template can use whichever reads better.
        threatScore: cvss.threatScore ?? '',
        threatSeverity: cvss.threatSeverity ?? cvss.temporalSeverity,
        environmentalScore: cvss.environmentalScore ?? '',
        environmentalSeverity: cvss.environmentalSeverity,
        impact: cvss.impact ?? '',
        exploitability: cvss.exploitability ?? '',
        complete: cvss.complete,
        metrics: describeMetrics(source.cvssv3),
      },
      /**
       * Who wrote the finding up, as a name.
       *
       * The user document itself is stripped above — a template needs a person's
       * name, not their account — so this is the one way to print it.
       */
      author: userSummary(raw.createdBy)?.fullname ?? '',

      /**
       * Booleans, so a template can switch on remediation state with a section:
       * `{{#isFixed}}Resolved at retest.{{/isFixed}}`. The template language has no
       * comparison operator, so a flag is the only way to ask.
       */
      isOpen: (source.remediationStatus ?? 'open') === 'open',
      isRetesting: source.remediationStatus === 'retesting',
      isFixed: source.remediationStatus === 'fixed',

      /** 0 for Critical … 4 for Informational — for sorting and comparisons. */
      severityIndex: SEVERITY_ORDER.indexOf(rated.severity),
      /**
       * The severity as this client's report words it.
       *
       * `severity` stays the raw value, because templates and conditions are written against
       * it — a client renaming High to P2 must not break `{{#hasHigh}}`.
       */
      severityLabel: severityLabel(rated.severity),

      /** Whether there is any evidence to show, and how much. */
      evidenceCount: countImages(source),
      hasEvidence: countImages(source) > 0,

      /**
       * CWE, by convention from a finding custom field named `cwe`. Promoted to a
       * top-level tag because mapping to CWE is asked for often enough that
       * `{{ .custom.cwe }}` being the only route is a papercut.
       */
      cwe: customFieldValue(source.customFields, 'cwe'),
      owasp: customFieldValue(source.customFields, 'owasp'),

      // Flattened aliases — the shapes people reach for most often.
      cvssv3: source.cvssv3 ?? '',
      /** Version-neutral alias, since `cvssv3` may hold a 4.0 vector. */
      cvssVector: source.cvssv3 ?? '',
      cvssVersion: cvss.version,
      cvssScore: cvss.baseScore ?? '',
      severity: rated.severity,
      severityColor: severityColor(rated.severity, cvssColors),
      /*
       * What the vector says, beside what the team is standing behind.
       *
       * Both, always: a report that prints a rating without the score it departed from is asking
       * to be argued with, and a template that wants to show its working needs the pair.
       */
      cvssSeverity: rated.cvssSeverity,
      cvssSeverityLabel: severityLabel(rated.cvssSeverity),
      severityOverridden: rated.overridden,
      severityReason: rated.reason,
      priority: source.priority ?? null,
      priorityLabel: PRIORITY_LABELS[source.priority] ?? '',
      remediationComplexity: source.remediationComplexity ?? null,
      remediationComplexityLabel: COMPLEXITY_LABELS[source.remediationComplexity] ?? '',
      remediationStatus: source.remediationStatus ?? 'open',
      remediationStatusLabel: REMEDIATION_STATUS_LABELS[source.remediationStatus ?? 'open'],
      custom,
      _sortScore: rated.sortScore,
      _sortIndex: source.sortIndex ?? 0,
    };
  });

  if (audit.sortFindings !== false) {
    findings.sort((a, b) => b._sortScore - a._sortScore || a.title.localeCompare(b.title));
  } else {
    findings.sort((a, b) => a._sortIndex - b._sortIndex);
  }

  /*
   * `id` comes from the finding's stored identifier, never from its position.
   *
   * It used to be positional, which meant that with automatic CVSS ordering on —
   * the default — editing one finding's score renumbered every finding below it. A
   * client emailing about "VULN-03" could be discussing a different finding than the
   * one that label now pointed at, and a retest report would disagree with the
   * original it was retesting. A stable id leaves gaps when findings are deleted;
   * that is the correct trade, and `number` still gives the reading position.
   */
  findings.forEach((finding, index) => {
    const number = index + 1;
    finding.index = index;
    finding.number = number;
    // Falling back to position covers findings written before identifiers were
    // allocated reliably; `npm run fix:identifiers` gives those a permanent one.
    finding.identifier = finding.identifier ?? number;
    finding.id = `${prefix}${String(finding.identifier).padStart(2, '0')}`;
    /** The positional label, for "finding 3 of 12" phrasing. */
    finding.positionId = `${prefix}${String(number).padStart(2, '0')}`;
    delete finding._sortScore;
    delete finding._sortIndex;
  });

  const bySeverity = (severity) => findings.filter((f) => f.severity === severity);
  const counts = {
    total: findings.length,
    critical: bySeverity('Critical').length,
    high: bySeverity('High').length,
    medium: bySeverity('Medium').length,
    low: bySeverity('Low').length,
    none: bySeverity('None').length,
  };
  counts.info = counts.none;

  // Remediation progress, for retest reports that track what has been closed.
  const byStatus = (status) => findings.filter((f) => f.remediationStatus === status).length;
  counts.fixed = byStatus('fixed');
  counts.retesting = byStatus('retesting');
  counts.open = byStatus('open');
  counts.notFixed = counts.open;

  /**
   * Issues this client has been told about before and still has.
   *
   * Worth a sentence of its own in an executive summary: a report where half the
   * findings are repeats says something different from one where none are.
   */
  const repeats = findings.filter((finding) => finding.previouslyReported);
  counts.repeats = repeats.length;

  /* --------------------------------- sections -------------------------------- */
  const sectionList = (audit.sections ?? []).map((section) => {
    const source = typeof section.toObject === 'function' ? section.toObject() : section;
    // No prefix: a section has no number of its own, and its figures are numbered
    // within it. Evidence overwhelmingly lives on findings, so two sections each
    // holding a "Figure 1" is a wart worth accepting to keep the labels stable.
    const numbered = numberFiguresAcross(source, SECTION_RICH_FIELDS, '');
    const { plain, rich } = expandRichFields(numbered, SECTION_RICH_FIELDS, ooxmlOptions, target);
    return {
      ...source,
      ...plain,
      rich: { ...rich, custom: customFieldRich(source.customFields, ooxmlOptions, target) },
      custom: customFieldMap(source.customFields),
    };
  });
  /** `{{@sections.executive_summary.rich.text}}` — direct access by field name. */
  const sectionsByField = {};
  for (const section of sectionList) sectionsByField[section.field] = section;

  /* ---------------------------------- scope ---------------------------------- */
  const scope = (audit.scope ?? []).map((entry) => {
    const source = typeof entry.toObject === 'function' ? entry.toObject() : entry;
    const hosts = (source.hosts ?? []).map((host) => {
      const raw = typeof host.toObject === 'function' ? host.toObject() : host;
      const status = raw.status ?? 'pending';
      /*
       * The operator's working notes are pulled out before anything is spread into the template
       * scope. They are the scratch pad from the working view — what was tried, which credentials
       * worked, what to come back to — and the app promises they never reach a report. `...raw`
       * would have handed them straight to `{{ .notes }}` inside a hosts loop, which is a
       * plausible enough tag for somebody to write by accident.
       */
      const { notes: _workingNotes, ...reportable } = raw;
      return {
        ...reportable,
        status,
        /** For a table column, and for `{{#isTested}}` style conditions in a template. */
        statusLabel:
          status === 'tested' ? 'Tested' : status === 'excluded' ? 'Not tested' : 'Not reached',
        isTested: status === 'tested',
        isExcluded: status === 'excluded',
        isPending: status === 'pending',
        label: raw.hostname || raw.ip || '',
      };
    });
    const tested = hosts.filter((host) => host.isTested).length;
    return {
      ...source,
      hosts,
      hostList: hosts.map((h) => h.label).filter(Boolean).join(', '),
      /** Per group, because a group is usually how coverage is discussed. */
      testedCount: tested,
      hostCount: hosts.length,
      coverage: hosts.length ? Math.round((tested / hosts.length) * 100) : 0,
    };
  });
  const allHosts = scope.flatMap((s) => s.hosts ?? []);
  /** Every in-scope asset on one line — handy inside a sentence. */
  const scopeSummary = allHosts
    .map((host) => host.hostname || host.ip)
    .filter(Boolean)
    .join(', ');

  /**
   * What was actually reached.
   *
   * The honest counterpart to the scope list, and the answer to the question every closeout call
   * opens with. Split into three because "we did not get to it" and "we agreed not to" are
   * different sentences, and a report that conflates them is the one that gets queried.
   */
  const scopeCoverage = {
    hosts: allHosts.length,
    tested: allHosts.filter((host) => host.isTested).length,
    excluded: allHosts.filter((host) => host.isExcluded).length,
    pending: allHosts.filter((host) => host.isPending).length,
    percent: allHosts.length
      ? Math.round((allHosts.filter((host) => host.isTested).length / allHosts.length) * 100)
      : 0,
    /** The two lists a template usually wants to print rather than count. */
    testedHosts: allHosts.filter((host) => host.isTested),
    untestedHosts: allHosts.filter((host) => !host.isTested),
    /** True when every asset was reached, for `{{#scopeCoverage.complete}}`. */
    complete: allHosts.length > 0 && allHosts.every((host) => host.isTested),
    /** Recorded at all: an engagement nobody ticked should not read as 0% tested. */
    recorded: allHosts.some((host) => host.status !== 'pending'),
  };

  /* ------------------------------- test checks ------------------------------- */
  // Unlike notes and comments these are reportable: "what we tested" is the
  // honest counterpart to the findings list, and it fills the technical-checks
  // section most templates have.
  const testChecks = [...(audit.testChecks ?? [])]
    .map((check) => {
      const raw = typeof check.toObject === 'function' ? check.toObject() : check;
      return {
        title: raw.title ?? '',
        description: raw.description ?? '',
        category: raw.category || 'Other',
        done: Boolean(raw.done),
        /** Not done and not reachable — see the check schema for why this is its own field. */
        blocked: Boolean(raw.blocked) && !raw.done,
        blockedReason: raw.blocked && !raw.done ? (raw.blockedReason ?? '') : '',
        /*
         * Three words, not two. "Not tested" covering both "we did not get to it" and "the
         * client never opened the firewall" is the same conflation the scope status fixed: at
         * closeout they are the difference between an admission and an explanation.
         */
        status: raw.done ? 'Verified' : raw.blocked ? 'Blocked' : 'Not tested',
        result: raw.result ?? '',
        // Only a populated reference yields a name; an unpopulated ObjectId must
        // not leak an id into the document.
        verifiedBy:
          raw.doneBy && typeof raw.doneBy === 'object' && raw.doneBy.username !== undefined
            ? [raw.doneBy.firstname, raw.doneBy.lastname].filter(Boolean).join(' ') ||
              raw.doneBy.username
            : '',
        verifiedOn: raw.doneAt ? formatDate(raw.doneAt, dateFormat) : '',
        order: raw.order ?? 0,
      };
    })
    .sort((a, b) => a.order - b.order);

  const checkGroups = [];
  for (const check of testChecks) {
    let group = checkGroups.find((g) => g.category === check.category);
    if (!group) {
      group = { category: check.category, checks: [], total: 0, done: 0, blocked: 0 };
      checkGroups.push(group);
    }
    group.checks.push(check);
    group.total += 1;
    if (check.done) group.done += 1;
    if (check.blocked) group.blocked += 1;
  }
  for (const group of checkGroups) {
    group.percent = group.total ? Math.round((group.done / group.total) * 100) : 0;
  }

  const doneChecks = testChecks.filter((c) => c.done).length;

  /* ------------------------------ groupings --------------------------------- */
  /*
   * Findings grouped for templates that organise the body by something other than
   * severity order. Each group carries its own findings array, so one loop nests
   * inside another: `{{#findingsByCategory}}{{ .category }}{{#findings}}…`.
   */
  const groupBy = (key, label) => {
    const groups = [];
    for (const finding of findings) {
      const value = String(finding[key] ?? '').trim() || label;
      let group = groups.find((g) => g.label === value);
      if (!group) {
        group = { label: value, [key]: value, findings: [], count: 0 };
        groups.push(group);
      }
      group.findings.push(finding);
      group.count += 1;
    }
    return groups.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  };

  const findingsByCategory = groupBy('category', 'Uncategorised');
  const findingsByType = groupBy('vulnType', 'Unclassified');

  /** Severity groups *with* their findings — stats.bySeverity has only the counts. */
  const findingsBySeverity = SEVERITY_ORDER.map((severity) => ({
    severity,
    label: severity === 'None' ? 'Informational' : severity,
    color: severityColor(severity, cvssColors),
    findings: bySeverity(severity),
    count: bySeverity(severity).length,
  }));

  const byStatusFindings = (status) => findings.filter((f) => f.remediationStatus === status);

  /* -------------------------------- numbers --------------------------------- */
  const scores = findings.map((f) => f.cvss.baseScore).filter((n) => typeof n === 'number');
  const averageScore = scores.length
    ? Math.round((scores.reduce((sum, n) => sum + n, 0) / scores.length) * 10) / 10
    : 0;

  const openSerious = findings.filter(
    (f) => !f.isFixed && (f.severity === 'Critical' || f.severity === 'High')
  ).length;

  /** The engagement's overall rating: the worst thing found. */
  const riskRating = findings.length ? findings[0].severity : 'None';

  const countRows = (map, total) =>
    [...map.entries()]
      .map(([label, count]) => ({
        label,
        count,
        percent: total ? Math.round((count / total) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  const categoryCounts = new Map();
  const typeCounts = new Map();
  const priorityCounts = new Map();
  for (const finding of findings) {
    const category = String(finding.category ?? '').trim() || 'Uncategorised';
    categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
    const type = String(finding.vulnType ?? '').trim() || 'Unclassified';
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
    const priority = finding.priorityLabel || 'Not set';
    priorityCounts.set(priority, (priorityCounts.get(priority) ?? 0) + 1);
  }

  /* ---------------------------------- dates --------------------------------- */
  const parseDay = (value) => {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  };
  const startDay = parseDay(audit.date_start);
  const endDay = parseDay(audit.date_end);
  /** Inclusive testing days — "5 days" reads better than a date range in a sentence. */
  const durationDays =
    startDay && endDay ? Math.max(1, Math.round((endDay - startDay) / 86_400_000) + 1) : null;

  const formattedStart = audit.date_start ? formatDate(audit.date_start, dateFormat) : '';
  const formattedEnd = audit.date_end ? formatDate(audit.date_end, dateFormat) : '';

  /* --------------------------------- scope ---------------------------------- */
  const allServices = allHosts.flatMap((host) => host.services ?? []);
  const ports = [
    ...new Set(allServices.map((service) => service.port).filter((port) => Number.isFinite(port))),
  ].sort((a, b) => a - b);

  const company = audit.company
    ? typeof audit.company.toObject === 'function'
      ? audit.company.toObject()
      : audit.company
    : null;
  const client = audit.client
    ? typeof audit.client.toObject === 'function'
      ? audit.client.toObject()
      : audit.client
    : null;

  /** One shape for a contact, used for the primary and every other recipient. */
  const contactSummary = (contact) => {
    const raw = typeof contact?.toObject === 'function' ? contact.toObject() : contact;
    if (!raw) return null;
    return {
      email: raw.email ?? '',
      firstname: raw.firstname ?? '',
      lastname: raw.lastname ?? '',
      fullname: [raw.firstname, raw.lastname].filter(Boolean).join(' ') || (raw.email ?? ''),
      phone: raw.phone ?? '',
      cell: raw.cell ?? '',
      title: raw.title ?? '',
    };
  };

  /*
   * Recipients, primary first. Falls back to the primary alone for engagements saved
   * before the list existed, so a template looping `recipients` is never empty when
   * a contact is set.
   */
  /**
   * What each of them is to this report, by contact id.
   *
   * Absent for an engagement saved before roles existed, and for anybody added to the list
   * without one — both read as a technical contact, which is what everybody on a distribution
   * list was until this could be said.
   */
  const roleOf = new Map(
    (audit.recipientRoles ?? [])
      .map((entry) => [String(entry.client?._id ?? entry.client ?? ''), entry.role])
      .filter(([id, role]) => id && role)
  );

  const recipientList = (
    (audit.recipients ?? []).length ? audit.recipients : [audit.client].filter(Boolean)
  )
    .map((contact) => {
      const summary = contactSummary(contact);
      if (!summary) return null;
      const role = roleOf.get(String(contact?._id ?? contact ?? '')) ?? 'technical';
      return { ...summary, role, roleLabel: RECIPIENT_ROLE_LABELS[role] ?? role };
    })
    .filter(Boolean);

  const data = {
    /* engagement */
    name: audit.name ?? '',
    title: audit.name ?? '',
    reference: audit.reference ?? '',
    auditType: audit.auditType ?? '',
    language: audit.language ?? 'en',
    state: audit.state ?? 'EDIT',
    date: audit.date ? formatDate(audit.date, dateFormat) : '',
    date_start: audit.date_start ? formatDate(audit.date_start, dateFormat) : '',
    date_end: audit.date_end ? formatDate(audit.date_end, dateFormat) : '',
    // Raw ISO values, so a template can impose its own format with the `date`
    // filter regardless of the instance-wide setting.
    dateRaw: audit.date ?? '',
    date_startRaw: audit.date_start ?? '',
    date_endRaw: audit.date_end ?? '',
    now: formatDate(new Date(), dateFormat),

    /* document control */
    /** 'In progress' / 'In review' / 'Approved' — the state in words. */
    stateLabel: AUDIT_STATE_LABELS[audit.state] ?? 'In progress',
    /** For a DRAFT watermark: `{{#isDraft}}DRAFT{{/isDraft}}`. */
    isDraft: audit.state !== 'APPROVED',
    isApproved: audit.state === 'APPROVED',
    /** When this file was produced, and by whom — for a document control table. */
    generatedAt: formatDate(new Date(), dateFormat),
    generatedAtRaw: new Date().toISOString(),
    generatedBy: userSummary(options.user)?.fullname ?? '',
    templateName: options.templateName ?? '',
    year: (parseDay(audit.date) ?? new Date()).getFullYear(),

    /** Testing window as one phrase, and its length. */
    dateRange:
      formattedStart && formattedEnd
        ? `${formattedStart} – ${formattedEnd}`
        : formattedStart || formattedEnd || '',
    duration: durationDays ?? '',
    durationLabel: durationDays ? `${durationDays} day${durationDays === 1 ? '' : 's'}` : '',

    /* parties */
    company: company
      ? {
          name: company.name ?? '',
          shortName: company.shortName ?? '',
          logo: company.logo ?? '',
          address: company.address ?? '',
          website: company.website ?? '',
        }
      : { name: '', shortName: '', logo: '', address: '', website: '' },
    client: client
      ? {
          email: client.email ?? '',
          firstname: client.firstname ?? '',
          lastname: client.lastname ?? '',
          fullname: [client.firstname, client.lastname].filter(Boolean).join(' '),
          phone: client.phone ?? '',
          cell: client.cell ?? '',
          title: client.title ?? '',
        }
      : { email: '', firstname: '', lastname: '', fullname: '', phone: '', cell: '', title: '' },

    /**
     * Everyone the report goes to, the primary first — for a distribution list, and
     * for a covering email that has to address more than one person.
     */
    recipients: recipientList,
    /**
     * Just the people who sign the work off, for a cover page or an acceptance block.
     *
     * Its own loop rather than a filter in the template, because the template language has no
     * comparison operator — the same reason `hasCritical` exists.
     */
    signatories: recipientList.filter((person) => person.role === 'signatory'),
    hasSignatories: recipientList.some((person) => person.role === 'signatory'),
    /** Everybody who gets the technical detail, which is the default for a recipient. */
    technicalRecipients: recipientList.filter((person) => person.role === 'technical'),
    /** The same names and addresses as one line each, for a sentence. */
    recipientNames: recipientList.map((person) => person.fullname).filter(Boolean).join(', '),
    recipientEmails: recipientList.map((person) => person.email).filter(Boolean).join('; '),
    hasRecipients: recipientList.length > 0,

    creator: userSummary(audit.creator) ?? userSummary({}),
    collaborators: (audit.collaborators ?? []).map(userSummary).filter(Boolean),
    reviewers: (audit.reviewers ?? []).map(userSummary).filter(Boolean),
    /**
     * Who signed the report off, and when.
     *
     * Only signatures that still cover this text: one given before the report was
     * rewritten must not appear on a sign-off page, where it would read as assurance
     * of words that reviewer never saw. Each entry is the same person shape every
     * other loop uses, so `{{ fullname }}` keeps working, plus `{{ signedOn }}`.
     */
    approvals: freshApprovals(audit)
      .map((approval) => {
        const person = userSummary(approval.user);
        if (!person) return null;
        return { ...person, signedOn: approval.at ? formatDate(approval.at, dateFormat) : '' };
      })
      .filter(Boolean),
    /** Everyone who worked on it — the author plus collaborators, deduplicated. */
    team: (() => {
      const people = [userSummary(audit.creator), ...(audit.collaborators ?? []).map(userSummary)]
        .filter(Boolean)
        .filter((person) => person.username || person.fullname);
      const seen = new Set();
      return people.filter((person) => {
        const key = person.username || person.fullname;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    })(),
    approvalCount: freshApprovals(audit).length,
    approved: freshApprovals(audit).length > 0,
    /** Signatures given against an earlier version — not shown, but countable. */
    staleApprovalCount: (audit.approvals ?? []).length - freshApprovals(audit).length,

    /* content */
    scope,
    scopeCoverage,
    hosts: allHosts,
    scopeSummary,
    /** Counts for a "scope covered" sentence, and every distinct port on one line. */
    scopeStats: {
      groups: scope.length,
      hosts: allHosts.length,
      services: allServices.length,
      ports: ports.length,
    },
    portList: ports.join(', '),
    findings,
    testChecks,
    checkGroups,
    checkStats: {
      total: testChecks.length,
      done: doneChecks,
      outstanding: testChecks.length - doneChecks,
      percent: testChecks.length ? Math.round((doneChecks / testChecks.length) * 100) : 0,
    },
    sections: sectionsByField,
    sectionList,
    custom: customFieldMap(audit.customFields),
    /** Formatted engagement-level custom fields: {{@rich.custom.KEY}}. */
    rich: {
      custom: customFieldRich(audit.customFields, ooxmlOptions, target),
      /**
       * The signature block as real images: `{{@rich.signatures}}`.
       *
       * A lazy getter, and memoised, because converting it *allocates a media file and a
       * relationship*: built eagerly, every report from a template that never prints
       * signatures would carry an orphaned image of somebody's handwriting. Docxtemplater
       * reads a tag by property access, so this runs only if the template asks for it — and
       * once if it asks twice.
       */
      get signatures() {
        if (signatureBlock === undefined) {
          signatureBlock =
            target === 'html'
              ? sanitizeHtml(signatureLog?.html ?? '')
              : htmlToOoxml(signatureLog?.html ?? '', ooxmlOptions);
        }
        return signatureBlock;
      },
    },

    /* buckets + stats */
    criticalFindings: bySeverity('Critical'),
    highFindings: bySeverity('High'),
    mediumFindings: bySeverity('Medium'),
    lowFindings: bySeverity('Low'),
    infoFindings: bySeverity('None'),

    /** Remediation buckets — the loops a retest report is built from. */
    openFindings: byStatusFindings('open'),
    retestingFindings: byStatusFindings('retesting'),
    fixedFindings: byStatusFindings('fixed'),

    /** Grouped bodies, each carrying its own nested `findings` loop. */
    findingsByCategory,
    findingsByType,
    findingsBySeverity,

    /**
     * Presence flags. `{{^findings}}` already covers "nothing at all", but
     * "no critical findings" needs its own question, and the template language has
     * no comparison operator.
     */
    hasFindings: findings.length > 0,
    hasCritical: counts.critical > 0,
    hasHigh: counts.high > 0,
    hasSerious: counts.critical + counts.high > 0,
    hasScope: allHosts.length > 0,
    hasChecks: testChecks.length > 0,
    hasFixed: counts.fixed > 0,
    /** True when anything here has been reported to this client before. */
    hasRepeats: counts.repeats > 0,

    /**
     * What the engagement took, for a "level of effort" paragraph.
     *
     * Reported as hours *and* as person-days because clients are quoted in days and
     * testers work in hours, and a template should not have to divide. `hasEffort` guards
     * the whole paragraph: an engagement where nobody logged time must print nothing
     * rather than "0 days", which reads as a claim.
     */
    effort: effort ?? { hours: 0, days: 0, recorded: false, entries: 0, people: [], firstDay: null, lastDay: null },
    hasEffort: Boolean(effort?.recorded),

    /**
     * Every version of this report that has been sent, oldest first, for a document control
     * or revision-history table. `hasDeliveries` guards it: an engagement whose report has
     * never gone out must print nothing rather than an empty table with a header row.
     */
    deliveries: deliveryLog?.deliveries ?? [],
    lastDelivery: deliveryLog?.lastDelivery ?? null,
    hasDeliveries: Boolean(deliveryLog?.recorded),

    /**
     * Changes to the scope, oldest first, for a "what was agreed" table.
     *
     * The scope section shows where testing ended up; this shows how it got there, which is
     * the half a client asks about when a host they expected is missing from the report.
     */
    /**
     * Signatures for a sign-off page.
     *
     * `{{@rich.signatures}}` prints the whole block — image, name, title, role and date per
     * person — in one tag. The `signatures` loop is there for a template that wants to lay it
     * out itself; `image` is a data URI, so it only renders inside a rich field.
     */
    signatures: signatureLog?.signatures ?? [],
    hasSignatures: Boolean(signatureLog?.recorded),

    scopeChanges: scopeLog?.scopeChanges ?? [],
    hasScopeChanges: Boolean(scopeLog?.recorded),
    scopeChangeCounts: scopeLog?.counts ?? { added: 0, removed: 0, clarified: 0, total: 0 },

    /**
     * The detection timeline, for a "were we seen" section.
     *
     * `detection.summary` holds the figures — how many were noticed, how long it took, how many
     * deliberately loud actions went unanswered — and `detection.loudMisses` is that last list on
     * its own, because it is usually the only table a client reads twice.
     */
    /**
     * The campaign, for a phishing report.
     *
     * `phishing.summary` holds the rates and the timings; `phishing` is the whole list, and
     * `phishedTargets` is only the people who fell for it. That last one names individual
     * employees to their employer, which plenty of engagements are explicitly not permitted to
     * do — the per-department breakdown in the summary is the version most reports should print.
     */
    phishing: phishingLog?.targets ?? [],
    phishingSummary: phishingLog?.summary ?? null,
    phishedTargets: phishingLog?.phishedTargets ?? [],
    hasPhishing: Boolean(phishingLog?.recorded),

    detection: detectionLog?.events ?? [],
    /*
     * Zeroed rather than null when nothing was logged, so an unguarded `{{detectionSummary.total}}`
     * prints 0 instead of an empty cell that reads as a missing number.
     */
    detectionSummary: detectionLog?.summary ?? detectionSummary([]),
    detectionLoudMisses: detectionLog?.loudMisses ?? [],
    hasDetection: Boolean(detectionLog?.recorded),
    /** Only the repeats, for a "previously reported and still present" section. */
    repeatFindings: repeats,
    stats: {
      ...counts,
      /** Ready-to-loop rows for a "findings by severity" summary table. */
      bySeverity: SEVERITY_ORDER.map((severity) => ({
        severity,
        label: severityLabel(severity),
        count: bySeverity(severity).length,
        /** Share of all findings, so an HTML template can size a bar directly. */
        percent: counts.total
          ? Math.round((bySeverity(severity).length / counts.total) * 100)
          : 0,
        color: severityColor(severity, cvssColors),
      })),
      highest: riskRating,
      /** The engagement's overall rating — the worst finding — and its colour. */
      riskRating,
      riskRatingLabel: severityLabel(riskRating),
      riskRatingColor: severityColor(riskRating, cvssColors),

      /** Remediation progress as a percentage, for a retest summary. */
      fixRate: counts.total ? Math.round((counts.fixed / counts.total) * 100) : 0,
      /** Critical and High that are still not fixed — the headline risk number. */
      openSerious,

      /** CVSS across the engagement. */
      averageScore,
      maxScore: scores.length ? Math.max(...scores) : 0,

      /** More ways to slice the same findings, each ready to loop. */
      byPriority: countRows(priorityCounts, counts.total),
      byCategory: countRows(categoryCounts, counts.total),
      byType: countRows(typeCounts, counts.total),

      /** Ready-to-loop rows for a remediation-progress table. */
      byStatus: [
        { status: 'open', label: 'Not fixed', count: counts.open },
        { status: 'retesting', label: 'Retesting', count: counts.retesting },
        { status: 'fixed', label: 'Fixed', count: counts.fixed },
      ],
    },

    /* palette, so templates can colour-code without hard-coding hex values */
    colors: {
      critical: severityColor('Critical', cvssColors),
      high: severityColor('High', cvssColors),
      medium: severityColor('Medium', cvssColors),
      low: severityColor('Low', cvssColors),
      none: severityColor('None', cvssColors),
    },
  };

  return data;
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                  */
/* -------------------------------------------------------------------------- */

function describeTemplateError(error) {
  if (error?.properties?.errors?.length) {
    const details = error.properties.errors.map((e) => {
      const tag = e.properties?.xtag ?? e.properties?.tag ?? '';
      return {
        message: e.properties?.explanation ?? e.message,
        tag,
        id: e.properties?.id ?? '',
      };
    });
    const summary = details
      .map((d) => (d.tag ? `${d.message} (tag: ${d.tag})` : d.message))
      .join('; ');
    return unprocessable(`Template has ${details.length} error(s): ${summary}`, details);
  }
  if (error?.properties?.explanation) {
    return unprocessable(`Template error: ${error.properties.explanation}`);
  }
  return null;
}

/**
 * @returns {Promise<{buffer: Buffer, filename: string}>}
 */
export async function generateReport({
  audit,
  template,
  settings,
  user,
  history,
  effort,
  deliveries,
  scopeChanges,
  signatures,
  detection,
  phishing,
}) {
  if (!template) throw badRequest('This audit has no template assigned.');

  const resolvedSettings = settings ?? (await Settings.getSettings());
  // The same merge the data build does, so the caption style and the date filter this render
  // uses are the ones this client is meant to get.
  const pub = resolveReportSettings(resolvedSettings, audit?.company);
  const priv = resolvedSettings.report?.private ?? {};

  const startedAt = Date.now();
  const { zip, parts, numbering, buffer: templateBuffer, inheritance } = await openTemplate(template);

  /*
   * Evidence lives in GridFS, not in the engagement document, so the bytes have to be fetched
   * before rendering: docxtemplater renders synchronously and the HTML converter cannot await
   * anything once it has started.
   */
  const media = await loadMediaMap(mediaIdsInAudit(audit));
  const ooxmlOptions = ooxmlOptionsFor({ parts, numbering, media, pub, priv });

  const data = buildReportData(audit, resolvedSettings, ooxmlOptions, {
    user,
    templateName: template.name ?? '',
    history,
    effort,
    deliveries,
    scopeChanges,
    signatures,
    detection,
    phishing,
  });

  /*
   * Where this document came from, stamped into the file itself as well as returned for the record.
   * Built before the render because `renderDocx` writes it into the package — see the note in
   * provenance.service.js about why a document that cannot say where it came from is a problem.
   */
  const provenance = provenanceFor({
    template,
    templateBuffer,
    user,
    subject: [audit?.name, audit?.reference].filter(Boolean).join(' · '),
    settings: resolvedSettings,
  });

  const buffer = renderDocx({
    zip,
    parts,
    data,
    dateFormat: pub.dateFormat,
    updateFields: priv.updateFieldsOnOpen !== false,
    describeError: describeTemplateError,
    provenance,
  });

  const filename = `${safeDocName(audit.name, 'report')}${
    audit.reference ? ` - ${safeDocName(audit.reference, '')}` : ''
  }.docx`;

  return {
    buffer,
    filename,
    /**
     * What the house style contributed, and what it could not.
     *
     * Passed back rather than logged so a test render can show it: a template author who has just
     * pointed a document at a base needs to be told the letterhead arrived, and told plainly when it
     * did not — the alternative is opening the .docx to find out.
     */
    inheritance,
    /**
     * Everything a RenderRecord needs, filled in now that the bytes exist.
     *
     * Returned rather than written here: a test render and a real one go through this same function,
     * and only one of them is a document anybody will ever hold. The caller knows which it is.
     */
    provenance: {
      ...provenance,
      filename,
      size: buffer.length,
      outputHash: outputHash(buffer),
      ms: Date.now() - startedAt,
      inheritedFrom: inheritance?.from ?? '',
      inheritedParts: inheritance?.applied ?? [],
      counts: {
        findings: (audit.findings ?? []).length,
        sections: (audit.sections ?? []).length,
        scope: (audit.scope ?? []).length,
        /** What actually went in, counted by the assembler rather than guessed from the prose. */
        images: parts.imageCount ?? 0,
      },
    },
  };
}

/**
 * Lists the tags a template actually uses. Powers the "detected tags" badge on
 * the templates page and the validation warnings.
 */
export function extractTemplateTags(buffer) {
  let zip;
  try {
    zip = new PizZip(buffer);
  } catch {
    throw badRequest('Uploaded file is not a valid .docx (unreadable zip container).');
  }

  const parts = Object.keys(zip.files).filter(
    (name) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)
  );
  if (!zip.file('word/document.xml')) {
    throw badRequest('Uploaded file is not a Word document (word/document.xml is missing).');
  }

  const tags = new Set();
  for (const name of parts) {
    const xml = zip.file(name).asText();
    // Strip tags so a placeholder split across runs still matches.
    const text = xml.replace(/<[^>]*>/g, '');
    for (const match of text.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
      tags.add(match[1].trim());
    }
  }
  return [...tags].sort();
}

/**
 * Every placeholder in a piece of template text, with the loops it sits inside.
 *
 * `extractTemplateTags` returns a sorted set, which is right for "does this template
 * mention anything we do not recognise" and useless for judging whether a tag resolves:
 * `{{ title }}` is correct inside `{{#findings}}` and meaningless outside it, and once
 * the list is sorted there is no way to tell which it was.
 *
 * So this keeps document order, tracks the open loops, and reports each tag with the
 * scope it was written in. Inverted sections (`{{^x}}`) do not open a scope — their body
 * renders when `x` is falsy, so the names inside still belong to the parent.
 *
 * @returns {Array<{tag: string, scope: string[], kind: 'value'|'loop'|'inverted'|'rich'}>}
 */
export function tagScopesFromText(text) {
  const found = [];
  const stack = [];

  for (const tag of eachTag(text)) {
    const step = stepScope(stack, tag);
    // A nameless `{{ }}`, or a closing tag — neither is something to resolve.
    if (!step || step.kind === 'close') continue;
    found.push({ tag: step.tag, scope: step.scope, kind: step.kind });
  }

  return found;
}

/** The same, for an uploaded .docx: one pass per part, scopes never crossing parts. */
export function extractTagScopes(buffer) {
  const zip = new PizZip(buffer);
  const parts = Object.keys(zip.files).filter((name) =>
    /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(name)
  );

  const found = [];
  for (const name of parts) {
    // Strip XML so a placeholder split across runs still matches, exactly as the tag
    // extractor does — a tag Word has broken in half is the common case, not the odd one.
    const text = zip.file(name).asText().replace(/<[^>]*>/g, '');
    found.push(...tagScopesFromText(text));
  }
  return found;
}

export default { generateReport, buildReportData, extractTemplateTags };
