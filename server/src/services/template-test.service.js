/**
 * Trying a template out before it meets a real engagement.
 *
 * An HTML template has always had a live preview; a `.docx` one could only be proven by
 * assigning it to an engagement, generating, opening Word and squinting — and if a tag
 * was misspelled, the document came out with a silent gap in it. That is a slow loop
 * around the one thing this whole app rests on: your own template being right.
 *
 * So: render the template against the sample engagement, and say what happened to every
 * placeholder it contains.
 */

import {
  sampleAudit,
  sampleDeliveries,
  sampleEffort,
  sampleReportSettings,
  sampleScopeChanges,
  sampleSignatures,
  sampleDetection,
  samplePhishing,
} from '../fixtures/sample-engagement.js';
import fs from 'node:fs/promises';
import path from 'node:path';

import env from '../config/env.js';
import {
  buildReportData,
  extractTagScopes,
  generateReport,
  tagScopesFromText,
} from './report.service.js';
import { renderHtmlReport, partialResolver } from './html-report.service.js';
import { expandPartials } from './template-inheritance.service.js';
import { knownTagRoots } from './tag-reference.js';

/**
 * The instance's own report settings, with the fixture's as a floor.
 *
 * A test render has to reflect the date format, finding prefix and severity colours the
 * user actually configured — testing against someone else's settings would prove the
 * wrong thing — but the fixture fills in anything a fresh instance has not set.
 */
function testSettings(settings) {
  const fixture = sampleReportSettings.report;
  return {
    ...(settings?.toObject?.() ?? settings ?? {}),
    report: {
      public: { ...fixture.public, ...(settings?.report?.public ?? {}) },
      private: { ...fixture.private, ...(settings?.report?.private ?? {}) },
    },
  };
}

const isBlank = (value) => {
  if (value === undefined || value === null) return true;
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === 'string') return value.trim() === '';
  return false;
};

/**
 * Names the renderer provides inside a loop; they belong to no data field.
 *
 * The page breaks are here for the same reason `$index` is: the parser answers them itself, so
 * looking for them in the data finds nothing and reports a working template as broken. That is
 * what happened — a real report template used the page break this project's own syntax notes
 * recommend, and the test render called it a tag that does not exist.
 */
const LOOP_BUILTINS = new Set([
  'this',
  '$index',
  '$number',
  '$first',
  '$last',
  '$total',
  '$pageBreakExceptLast',
  '$pageBreakExceptFirst',
]);

/**
 * What each placeholder in the template did, judged where it was written.
 *
 * Scope is the whole point. `{{ title }}` is correct inside `{{#findings}}` and
 * meaningless outside it, so resolving every tag against the top level — which is all a
 * sorted list of tag names allows — reports most of a working template as broken. Each
 * tag is resolved down its own loop stack instead, taking the first row of each loop as
 * the sample.
 *
 * Three answers, because they want three different reactions:
 *
 * - `unknown` — nothing in the app produces this name, in this scope or any other.
 *   Almost always a typo, and the only one of the three that is certainly a bug.
 * - `empty` — a real tag that resolves to nothing *for this sample*. Sometimes correct
 *   (the sample has no approvals), sometimes a tag used outside the loop it belongs to,
 *   so it is reported rather than judged.
 * - `ok` — resolved, with a preview of the value, because seeing it is how you notice
 *   you wrote `positionId` where you meant `id`.
 */
export function analyseTags(found, data) {
  const roots = knownTagRoots();

  /** Walks a path, taking the first row of any array it meets. */
  const resolve = (node, path) => {
    let current = node;
    for (const part of path.split('.')) {
      if (Array.isArray(current)) current = current[0];
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }
    return Array.isArray(current) && current.length && typeof current[0] === 'object'
      ? current
      : current;
  };

  /** How many sample rows a level contributes, so a wide fixture cannot make this walk expensive. */
  const ROWS_PER_LEVEL = 24;

  /**
   * Every sample row a scope could be standing on, so a tag is judged against a row that has it.
   *
   * Two things this gets right that one row could not:
   *
   * A level holding a plain string or number is a condition, not a loop — the renderer shows the
   * block once and leaves the scope alone. So `{{#os}} — {{ os }}{{/os}}` reads `os` off the host,
   * which is where it lives, and the scope does not move.
   *
   * And a loop is sampled across its rows rather than at its first. Report the first row and the
   * answer depends on fixture order: the sample's first technical check is not blocked, so
   * `{{ blockedReason }}` came back empty and read as a broken template, while the blocked check
   * two rows down carries exactly the value the tag was written for.
   */
  const scopesOf = (scope) => {
    let nodes = [data];
    for (const level of scope) {
      const next = [];
      for (const node of nodes) {
        const value = resolve(node, level);
        if (value === undefined || value === null) continue;
        // A condition: shown or not shown, but never a new scope.
        if (typeof value !== 'object') next.push(node);
        else if (Array.isArray(value)) next.push(...value.filter((row) => row !== undefined && row !== null));
        else next.push(value);
      }
      if (!next.length) return [];
      nodes = next.slice(0, ROWS_PER_LEVEL);
    }
    return nodes;
  };

  const preview = (value) => {
    if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'object') return 'a group of fields';
    const text = String(value).replace(/\s+/g, ' ').trim();
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };

  const seen = new Map();

  /**
   * `{{ phone }}` written inside `{{#phone}}` is the same field, twice.
   *
   * A condition over a plain value does not move the scope, so the tag inside it resolves exactly
   * where the condition did. Listing both says nothing new and doubles the rows for every optional
   * field a template has — the list stops being something you can read down.
   */
  const insideItsOwnCondition = (tag, scope) =>
    scope.length > 0 && scope.at(-1) === tag && seen.has(`${scope.slice(0, -1).join('>')}|${tag}`);

  for (const entry of found ?? []) {
    const { tag, scope = [], kind = 'value' } = entry;
    if (insideItsOwnCondition(tag, scope)) continue;
    const key = `${scope.join('>')}|${tag}`;
    if (!tag || seen.has(key)) continue;

    const where = scope.length ? scope.join(' → ') : '';

    if (LOOP_BUILTINS.has(tag)) {
      seen.set(key, { tag, where, kind, status: scope.length ? 'ok' : 'empty', value: 'provided by the loop' });
      continue;
    }

    const rows = scopesOf(scope);

    /*
     * A loop the sample leaves empty cannot be sampled, so nothing inside it can be
     * judged. Calling those a typo would be worse than saying nothing: the sample has no
     * approvals, and `{{ signedOn }}` inside `{{#approvals}}` is perfectly correct.
     */
    if (!rows.length) {
      seen.set(key, { tag, where, kind, status: 'empty', unverified: true });
      continue;
    }

    // The first row that fills the tag in, falling back to the first so there is always a
    // parent to check the spelling against.
    let parent = rows[0];
    let value = resolve(parent, tag);
    if (isBlank(value)) {
      for (const row of rows.slice(1)) {
        const candidate = resolve(row, tag);
        if (!isBlank(candidate)) {
          parent = row;
          value = candidate;
          break;
        }
      }
    }

    /*
     * A misspelled leaf under a name that exists — `stats.nonsense`, `client.nmae`,
     * `cvss.scoer` — is a typo, not an empty value, and the catalogue cannot catch it
     * because only the first segment is checked there. If the parent object resolves and
     * does not have the key at all, say so.
     */
    const segments = tag.split('.');
    let holder = parent;
    for (const part of segments.slice(0, -1)) {
      if (Array.isArray(holder)) holder = holder[0];
      holder = holder?.[part];
    }
    if (Array.isArray(holder)) holder = holder[0];
    const leaf = segments.at(-1);
    const misspeltLeaf =
      segments.length > 1 &&
      holder !== null &&
      typeof holder === 'object' &&
      !Array.isArray(holder) &&
      !(leaf in holder);

    // Unknown means unknown anywhere: a name that resolves in its own scope is fine even
    // when the catalogue lists it as a loop-local field, and a name the catalogue knows is
    // a real tag even when this sample leaves it empty.
    const known = !misspeltLeaf && (roots.has(segments[0]) || value !== undefined);
    if (!known) {
      seen.set(key, { tag, where, kind, status: 'unknown' });
      continue;
    }

    seen.set(key, {
      tag,
      where,
      kind,
      status: isBlank(value) ? 'empty' : 'ok',
      value: isBlank(value) ? '' : preview(value),
    });
  }

  const list = [...seen.values()];
  const rank = (status) => ['unknown', 'empty', 'ok'].indexOf(status);
  return {
    tags: list.sort(
      (a, b) => rank(a.status) - rank(b.status) || a.tag.localeCompare(b.tag)
    ),
    counts: {
      total: list.length,
      ok: list.filter((entry) => entry.status === 'ok').length,
      empty: list.filter((entry) => entry.status === 'empty').length,
      unknown: list.filter((entry) => entry.status === 'unknown').length,
    },
  };
}

/**
 * The template's placeholders, each with the loops it sits inside.
 *
 * Read from the document rather than from `detectedTags`, which is a sorted set and so
 * cannot say what was nested in what. Falls back to the stored list — flat, and
 * therefore harsher — if the file cannot be read, because a partial answer beats none.
 */
async function tagsWithScope(template) {
  if (template.kind === 'html') return tagScopesFromText(template.html);
  try {
    const buffer = await fs.readFile(path.join(env.storage.templates, template.filename));
    return extractTagScopes(buffer);
  } catch {
    return (template.detectedTags ?? []).map((tag) => ({ tag, scope: [], kind: 'value' }));
  }
}

/**
 * What is wrong with a template's tags, without rendering it.
 *
 * The upload route already reported "unknown tags", by checking the *first segment* of every
 * placeholder against a list of known names. That catches `{{ .nonsense }}` and misses
 * `{{ .client.nmae }}` — the misspelling people actually make, under a root that exists — and it
 * has no idea about scope, so it could not tell a tag that is only valid inside a loop from one
 * that is wrong everywhere.
 *
 * This runs the same analysis the test render does: every placeholder with the loops it sits
 * inside, resolved against the sample engagement. It is the difference between finding a typo now
 * and finding a blank space in a document already sent.
 *
 * Deliberately never fatal. A template with unrecognised tags is uploaded, saved, and flagged —
 * a half-written template is the normal state of a template being written, and an app that
 * refuses the upload is an app people work around by keeping the file on the desktop.
 *
 * @param {{buffer?: Buffer, html?: string, settings?: object, user?: object}} input
 * @returns {{at: Date, counts: object, unknown: Array<{tag: string, where: string}>}}
 */
export function lintTemplateTags({ buffer, html, settings, user } = {}) {
  const found = html !== undefined && html !== null ? tagScopesFromText(html) : extractTagScopes(buffer);
  /*
   * The same sample the test render builds, from the same call with the same arguments.
   *
   * `buildReportData` resolves the settings itself, so it takes the whole document rather than
   * the public block — passing a different shape here would have judged tags against a sample
   * the render never sees, which is worse than not checking.
   */
  const data = buildReportData(
    sampleAudit,
    testSettings(settings),
    { parts: null, numbering: null },
    {
      target: html === undefined || html === null ? 'docx' : 'html',
      user,
      templateName: '',
      effort: sampleEffort,
      deliveries: sampleDeliveries,
      scopeChanges: sampleScopeChanges,
      detection: sampleDetection,
      phishing: samplePhishing,
      signatures: sampleSignatures,
    }
  );

  const analysis = analyseTags(found, data);
  return {
    at: new Date(),
    counts: analysis.counts,
    /*
     * Only the unrecognised ones are stored. "Empty" is not a fault — the sample has no
     * approvals, so everything inside `{{#approvals}}` is legitimately blank — and keeping a
     * whole analysis on every template would be a copy of the fixture that goes stale the first
     * time the fixture changes.
     */
    unknown: analysis.tags
      .filter((entry) => entry.status === 'unknown')
      .map((entry) => ({ tag: entry.tag, where: entry.where ?? '' })),
  };
}

/**
 * Renders the template against the sample engagement.
 *
 * Everything that a real generation does, with a fixture in place of an engagement — the
 * same code path, so a template that renders here renders there. A failure is returned
 * rather than thrown: a broken loop is the answer the caller asked for, not an accident.
 *
 * @returns {Promise<{ok: boolean, error?: string, detail?: string, buffer?: Buffer, size?: number, analysis: object}>}
 */
export async function testRenderTemplate({ template, settings, user }) {
  const merged = testSettings(settings);

  // The analysis does not depend on the render succeeding, and is the more useful half
  // when it fails — a broken loop is usually a misspelled one.
  const data = buildReportData(
    sampleAudit,
    merged,
    { parts: null, numbering: null },
    {
      target: template.kind === 'html' ? 'html' : 'docx',
      user,
      templateName: template.name,
      effort: sampleEffort,
      deliveries: sampleDeliveries,
      scopeChanges: sampleScopeChanges,
      detection: sampleDetection,
      phishing: samplePhishing,
      signatures: sampleSignatures,
    }
  );
  const analysis = analyseTags(await tagsWithScope(template), data);

  try {
    if (template.kind === 'html') {
      /*
       * The same expansion the real render does, so a test render of a template built from partials
       * shows what the report will show. Its warnings come back rather than being logged: this is
       * the screen somebody is looking at *because* they want to know what is wrong.
       */
      const { html: withPartials, used, warnings } = await expandPartials(
        template.html,
        await partialResolver()
      );
      const html = renderHtmlReport(withPartials, data, {
        dateFormat: merged.report?.public?.dateFormat,
      });
      return {
        ok: true,
        analysis,
        size: Buffer.byteLength(html, 'utf8'),
        html,
        partials: { used, warnings },
      };
    }

    const { buffer, inheritance } = await generateReport({
      audit: sampleAudit,
      template,
      settings: merged,
      user,
      effort: sampleEffort,
      deliveries: sampleDeliveries,
      scopeChanges: sampleScopeChanges,
      detection: sampleDetection,
      phishing: samplePhishing,
      signatures: sampleSignatures,
    });
    return { ok: true, analysis, size: buffer.length, buffer, inheritance };
  } catch (error) {
    return {
      ok: false,
      analysis,
      error: error.message || 'The template could not be rendered',
      // Docxtemplater collects every broken tag it found rather than stopping at the
      // first, and the report pipeline already normalises them to {message, tag}.
      problems: Array.isArray(error.details) ? error.details : [],
    };
  }
}

export default testRenderTemplate;
