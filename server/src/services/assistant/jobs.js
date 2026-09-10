/**
 * The four things the assistant is allowed to be asked, and nothing else.
 *
 * A job is a pure function from data this instance already holds to `{ system, user, maxTokens }`,
 * plus a `parse` that turns the reply back into something the app can show. Both halves are pure so
 * the tests can hold every prompt and every parser to a fixed input without a key, a network or a
 * provider — which is the only way any of this is checkable at all.
 *
 * Why a closed list rather than a free-text box:
 *
 *   - **The prompt is the security boundary.** What goes out is assembled here from named fields.
 *     A box that sent whatever somebody typed would eventually send the proof of concept, because
 *     one day somebody would paste it in to ask a question about it.
 *   - **Each job can be switched off on its own.** An instance that wants a hand with the executive
 *     summary and would rather nothing touched its findings is a configuration, not a fork.
 *   - **Every job says what it is for**, so the refusal when it is off can say something better
 *     than "the assistant is disabled".
 *
 * Two rules run through all four prompts, and they are not decoration:
 *
 *   1. **Nothing is invented.** Every prompt says so, and every job is given the facts rather than
 *      asked to recall them. A report is evidence; a plausible sentence about a host that was never
 *      tested is worse than a blank page, because a blank page is obviously unfinished.
 *   2. **Nothing is applied.** Every job returns a suggestion that a person reads and accepts. The
 *      routes never write to the engagement, and the UI never fills a field without a click.
 */
import { redact, redactAndTrim } from './redact.js';

/** Editor HTML down to something worth spending tokens on. */
export function plainText(html, max = 6000) {
  const text = String(html ?? '')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Plain paragraphs back into the editor's HTML, escaped. Never the model's own markup. */
export function paragraphsToHtml(text) {
  const escape = (value) =>
    value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

  return String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escape(block).replace(/\n/g, '<br />')}</p>`)
    .join('');
}

/**
 * The instruction every job carries, in front of its own.
 *
 * Written once because it is the same promise each time, and because a rule repeated in four
 * slightly different wordings is four rules that will drift.
 */
const HOUSE_RULES = [
  'You are helping a penetration testing team write a client report. You are drafting, not deciding.',
  'Use only the facts you are given. Never invent a host, a port, a version, a date, a number, a CVE or a finding.',
  'If the material you are given is too thin to answer well, say less rather than filling the gap.',
  'Write British English, plainly, in the past tense for what was done and the present for what is true.',
  'No preamble, no sign-off, no "here is", no markdown headings, no emoji. Return only what was asked for.',
].join(' ');

const withStyle = (base, houseStyle) =>
  houseStyle?.trim()
    ? `${base}\n\nThe team's own house style, which takes precedence over anything above about tone:\n${houseStyle.trim()}`
    : base;

/* -------------------------------------------------------------------------- */
/* 1. A first draft of the executive summary                                   */
/* -------------------------------------------------------------------------- */

const SEVERITY_ORDER = ['Critical', 'High', 'Medium', 'Low', 'None'];

/**
 * @param {object} brief assembled by the route from the engagement — see `assistant.routes.js`
 * @param {string} [houseStyle]
 */
export function summaryJob(brief, houseStyle = '') {
  const counts = SEVERITY_ORDER.map(
    (severity) => `${severity}: ${brief.findings.filter((f) => f.severity === severity).length}`
  ).join(', ');

  const lines = [
    `Engagement: ${brief.name}`,
    brief.client ? `Client: ${brief.client}` : '',
    brief.type ? `Type of test: ${brief.type}` : '',
    brief.window ? `Tested: ${brief.window}` : '',
    brief.scope ? `Scope: ${brief.scope}` : '',
    '',
    `Findings by severity — ${counts}`,
    '',
    'The findings, worst first:',
    ...brief.findings.map(
      (finding) =>
        `- ${[finding.identifier, finding.severity, finding.score ? `CVSS ${finding.score}` : '', finding.status]
          .filter(Boolean)
          .join(' · ')} — ${finding.title}${finding.snippet ? `: ${finding.snippet}` : ''}`
    ),
  ].filter((line) => line !== null);

  const body = redact(lines.join('\n'));

  return {
    job: 'summary',
    maxTokens: 1200,
    redacted: body.removed,
    system: withStyle(
      `${HOUSE_RULES} Write the executive summary of this report: three to five short paragraphs of continuous prose for a reader who is not technical and will read nothing else. Say what was tested and over what period, what the overall posture looked like, what the most serious findings mean for the business in its own terms, and what should be done first. Refer to findings by their identifier where it helps. Do not list every finding — the report already does. Do not use bullet points or headings. Do not state a risk rating for the engagement as a whole unless the counts plainly support it.`,
      houseStyle
    ),
    user: `Here is everything known about the engagement.\n\n${body.text}`,
  };
}

/** Plain paragraphs in, editor HTML out — the model's own markup never reaches the document. */
summaryJob.parse = (text) => ({ html: paragraphsToHtml(text), text: String(text ?? '').trim() });

/* -------------------------------------------------------------------------- */
/* 2. A house-style rewrite of one passage                                     */
/* -------------------------------------------------------------------------- */

/** The fields a rewrite may be asked for. The proof of concept is deliberately not among them. */
export const REWRITABLE = {
  description: 'the description of the weakness',
  observation: 'the impact — what an attacker gains, in business terms',
  remediation: 'the remediation — what the client should do about it',
};

export function rewriteJob({ field, finding, houseStyle = '' }) {
  const label = REWRITABLE[field] ?? 'the passage';
  const passage = redact(plainText(finding[field], 8000));

  const context = [
    `Finding: ${finding.title}`,
    finding.severity ? `Severity: ${finding.severity}` : '',
    finding.vulnType ? `Category: ${finding.vulnType}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    job: 'rewrite',
    maxTokens: 1600,
    redacted: passage.removed,
    system: withStyle(
      `${HOUSE_RULES} You are rewriting ${label} of one finding so that it reads well, without changing what it says. Every fact must survive: hostnames, URLs, parameters, ports, versions, product names, numbers and any caveat or condition stay exactly as they are. Do not add a fact, a recommendation or a severity judgement that is not already in the passage. Do not remove a qualification such as "only when authenticated" — those are the sentences that get argued about. Return the rewritten passage as plain paragraphs separated by blank lines, using "- " at the start of a line for a list item. No HTML, no markdown headings, no code fences.`,
      houseStyle
    ),
    user: `${context}\n\nThe passage to rewrite:\n\n${passage.text}`,
  };
}

/**
 * Back to HTML, and back through the same door as everything else.
 *
 * The model is asked for plain text and its answer is escaped, so nothing it writes can become
 * markup in the report. A list is recognised here rather than trusted from the model, which is the
 * difference between a `<ul>` we built and a `<ul>` somebody else's endpoint sent us.
 */
rewriteJob.parse = (text) => {
  const blocks = String(text ?? '')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  const escape = (value) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html = blocks
    .map((block) => {
      const lines = block.split('\n').map((line) => line.trim());
      if (lines.length && lines.every((line) => /^[-*•]\s+/.test(line))) {
        const items = lines
          .map((line) => `<li>${escape(line.replace(/^[-*•]\s+/, ''))}</li>`)
          .join('');
        return `<ul>${items}</ul>`;
      }
      return `<p>${escape(block).replace(/\n/g, '<br />')}</p>`;
    })
    .join('');

  return { html, text: String(text ?? '').trim() };
};

/* -------------------------------------------------------------------------- */
/* 3. One line saying what a tool run established                              */
/* -------------------------------------------------------------------------- */

export function enumerationJob({ step, output, houseStyle = '' }) {
  /*
   * The output is the one input here that is genuinely dangerous, and the one the job cannot do
   * without. Redacted and trimmed head-and-tail: a tool announces itself at the top and concludes
   * at the bottom, and "9 hosts up" is always the last line.
   */
  const body = redactAndTrim(String(output ?? ''), 12_000);

  const context = [
    step.title ? `Step: ${step.title}` : '',
    step.tool ? `Tool: ${step.tool}` : '',
    step.target ? `Target: ${step.target}` : '',
    step.command ? `Command: ${redact(step.command).text}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return {
    job: 'enumeration',
    maxTokens: 200,
    redacted: body.removed,
    truncated: body.truncated,
    system: withStyle(
      `${HOUSE_RULES} Summarise what this tool run established, in one sentence of at most 200 characters. Say what was found, not what was run — "Three live hosts; staging answered but was not in the scope document" rather than "Ran nmap against the range". Give a count where the output supports one. If the output shows nothing of note, say exactly that. One sentence, plain text, no quotation marks around it.`,
      houseStyle
    ),
    user: `${context}\n\nThe output:\n\n${body.text || '(the step has no output)'}`,
  };
}

/**
 * One line, unquoted, trimmed to what the field will hold.
 *
 * The first line *then* the quotes, in that order: a model that answers with a quoted sentence and
 * then a paragraph of explanation is the common case, and stripping quotes from the whole answer
 * first leaves the closing one stranded on the end of the sentence.
 */
enumerationJob.parse = (text) => {
  const first =
    String(text ?? '')
      .split('\n')
      .map((part) => part.trim())
      .filter(Boolean)[0] ?? '';
  return { text: first.replace(/^["'\u201c\u2018]+|["'\u201d\u2019.]*$/g, '').slice(0, 600) };
};

/* -------------------------------------------------------------------------- */
/* 4. Which library entry this finding is                                      */
/* -------------------------------------------------------------------------- */

/**
 * The candidates are chosen here on this machine, by the same text search the library page uses,
 * and only the shortlist is sent. The alternative — describing the whole library to a provider so
 * it can pick — would send every entry the team has ever written on every request, which is both
 * the expensive way and the leaky one.
 */
export function libraryJob({ finding, candidates, houseStyle = '' }) {
  const numbered = candidates
    .map(
      (candidate, index) =>
        `${index + 1}. ${candidate.title}${candidate.category ? ` [${candidate.category}]` : ''}\n   ${
          candidate.snippet || '(no description)'
        }`
    )
    .join('\n');

  const target = redact(
    [
      `Title: ${finding.title}`,
      finding.vulnType ? `Category: ${finding.vulnType}` : '',
      `Description: ${plainText(finding.description, 2000) || '(none written yet)'}`,
    ]
      .filter(Boolean)
      .join('\n')
  );

  return {
    job: 'library',
    maxTokens: 200,
    redacted: target.removed,
    system: withStyle(
      `${HOUSE_RULES} You are matching one finding against a shortlist of entries from the team's reusable library. Decide which entry, if any, describes the same weakness — the same underlying issue, not merely the same technology or the same words. A near miss is a wrong answer here: reusing the wrong write-up puts a sentence about a different vulnerability into a client's report. Reply with the number of the best entry on the first line, or 0 if none of them is the same weakness, then one sentence saying why on the second line. Nothing else.`,
      houseStyle
    ),
    user: `The finding:\n${target.text}\n\nThe shortlist:\n${numbered}`,
  };
}

/**
 * @returns {{index: number|null, reason: string}} a 1-based index into the shortlist, or null
 */
libraryJob.parse = (text) => {
  const lines = String(text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const number = /^#?(\d+)\b/.exec(first);
  const picked = number ? Number(number[1]) : NaN;
  return {
    index: Number.isFinite(picked) && picked > 0 ? picked : null,
    reason: (lines.slice(1).join(' ') || (number ? '' : first)).slice(0, 400),
  };
};

/** The jobs by name, which is what the settings toggle and the route both key off. */
export const JOBS = {
  summary: { build: summaryJob, label: 'Draft the executive summary' },
  rewrite: { build: rewriteJob, label: 'Rewrite a passage in the house style' },
  enumeration: { build: enumerationJob, label: 'Summarise a tool run in one line' },
  library: { build: libraryJob, label: 'Suggest a library match' },
};

export default JOBS;
