/**
 * The catalogue of tags a .docx template may use. It is served to the client so
 * the Templates page can render a searchable reference, and it is used to flag
 * unrecognised tags on upload.
 *
 * Keep this in sync with `buildReportData()` in report.service.js.
 */

export const TAG_SYNTAX = {
  value: '{{ .TAG }}',
  valueAlt: '{{ TAG }}',
  loopOpen: '{{#LIST}}',
  loopClose: '{{/LIST}}',
  inverted: '{{^LIST}}',
  rich: '{{@rich.FIELD}}',
  notes: [
    'A leading dot is optional: {{ .title }} and {{ title }} behave identically.',
    'Spacing inside the braces never matters: {{#findings}}, {{ #findings }} and {{ # findings }} are all the same tag, and an opening tag written one way still pairs with a closing tag written another.',
    'Rich-text fields have two forms: {{ .description }} inserts plain text, {{@rich.description}} inserts real Word formatting (headings, lists, tables, screenshots).',
    'A raw tag such as {{@rich.description}} must be the only thing in its paragraph — Word replaces the whole paragraph with the formatted content. Put it on its own line.',
    "Filters use a pipe: {{ .date | date:'dd/MM/yyyy' }} or {{ .title | upper }}.",
    'Loop tags placed in the first and last cell of the same table row make Word repeat that row once per item.',
    "Templates need the standard Word styles (Heading1–6, ListParagraph, Quote, Caption) for rich text to look right — documents created from Word's default template already have them.",
    'Unknown tags render empty rather than failing, so a half-finished template still produces a document.',
    'Inside a loop you also get {{ $number }} (1-based), {{ $index }} (0-based), {{ $total }}, and {{ $first }} / {{ $last }} for conditions: {{#$last}}…{{/$last}}.',
    '{{@$pageBreakExceptLast}} on its own paragraph inside a loop puts a page break between items and not after the last — which is what a plain page break gets wrong, leaving a blank final page.',
    'Some filters produce Word markup rather than text (link, bookmark, ref, p). Those go in a raw tag and need `| p` at the end, because a raw tag replaces its whole paragraph: {{@ .name | link:.url | p }}.',
    'Everything a filter emits is escaped, so a client called “Smith & Sons” cannot break the document.',
  ],
};

export const FILTERS = [
  { name: 'upper', example: "{{ .name | upper }}", description: 'Uppercase.' },
  { name: 'lower', example: "{{ .name | lower }}", description: 'Lowercase.' },
  { name: 'capitalize', example: "{{ .name | capitalize }}", description: 'Capitalises the first letter.' },
  { name: 'title', example: "{{ .name | title }}", description: 'Title Cases Every Word.' },
  { name: 'trim', example: "{{ .name | trim }}", description: 'Strips surrounding whitespace.' },
  { name: 'default', example: "{{ .reference | default:'N/A' }}", description: 'Falls back when empty.' },
  { name: 'date', example: "{{ .date_start | date:'dd MMMM yyyy' }}", description: 'Formats a date. Patterns: yyyy yy MMMM MMM MM M dd d EEEE EEE HH mm ss.' },
  { name: 'join', example: "{{ .references | join:'; ' }}", description: 'Joins an array.' },
  { name: 'length', example: '{{ .findings | length }}', description: 'Item or character count.' },
  { name: 'fixed', example: '{{ .cvss.score | fixed:1 }}', description: 'Fixed decimal places.' },
  { name: 'pad', example: '{{ .number | pad:3 }}', description: 'Zero-pads a number.' },
  { name: 'truncate', example: '{{ .description | truncate:120 }}', description: 'Shortens with an ellipsis.' },
  { name: 'replace', example: "{{ .name | replace:'_':' ' }}", description: 'Replaces every occurrence.' },
  { name: 'first / last', example: '{{ .findings | first }}', description: 'First or last item.' },
  { name: 'reverse', example: '{{ .findings | reverse }}', description: 'Reverses an array or string.' },
  { name: 'where', example: "{{#findings | where:'severity':'High'}}", description: 'Keeps items matching a field value.' },
  { name: 'sortBy', example: "{{#findings | sortBy:'title':'asc'}}", description: 'Sorts by a field path.' },

  /* ---------------------------------------------------------------- collections */
  {
    name: 'groupBy',
    example: "{{#findings | groupBy:'severity'}}{{label}} ({{count}}){{#value}}…{{/value}}{{/findings | groupBy:'severity'}}",
    description:
      'Groups a list by a field. Each row has key, label, count and value (the members). Severity groups come back in severity order, not alphabetically.',
  },
  {
    name: 'loopObject',
    example: '{{#severityCounts | loopObject}}{{key}}: {{value}}{{/severityCounts | loopObject}}',
    description: 'Turns an object into {key, label, value} rows so it can be looped.',
  },
  {
    name: 'select',
    example: "{{ .team | select:'fullname' | join:', ' }}",
    description: 'Plucks one field from every item. Supports dotted paths.',
  },
  { name: 'unique', example: "{{ .findings | select:'category' | unique | join:', ' }}", description: 'Drops repeats, keeping the first spelling.' },
  { name: 'map', example: "{{ .references | map:'upper' | join:'; ' }}", description: 'Applies another filter to every item.' },
  {
    name: 'count',
    example: "{{ .findings | count:'severity':'High' }}",
    description: 'How many items match a field value — or how many there are, with no arguments.',
  },
  { name: 'sum', example: "{{ .effort.people | sum:'hours' }}", description: 'Totals a numeric field.' },
  {
    name: 'lines',
    example: '{{#scope | lines}}{{.}}{{/scope | lines}}',
    description:
      'Splits a value into lines for looping: one per paragraph for rich text, one per newline for plain text.',
  },

  /* ---------------------------------------------------------------- text + dates */
  { name: 'initials', example: '{{ .tester | initials }}', description: 'Iulian Schifirnet → I.S.' },
  {
    name: 'fromTo',
    example: '{{ .date_start | fromTo:.date_end }}',
    description:
      'A date range said the way people say it: “12 – 16 August 2026”. The parts both dates share are printed once, and a single day is not a range.',
  },
  { name: 'toJSON', example: '{{ .finding | toJSON }}', description: 'What the tag actually holds — for working out why something prints nothing.' },

  /* ---------------------------------------------------------------- Word markup */
  {
    name: 'p',
    example: '{{@ .title | p:\'Heading2\' }}',
    description:
      'Wraps a value in a paragraph, optionally in one of the template’s styles. Needed at the end of any raw tag that uses the filters below.',
  },
  { name: 'run', example: '{{@ .title | run | p }}', description: 'Wraps text in a run. Only useful as a step towards p.' },
  {
    name: 'link',
    example: '{{@ .name | link:.url | p }}',
    description: 'A real Word hyperlink. With one argument the text is also the target.',
  },
  { name: 'mailto', example: '{{@ .email | mailto | p }}', description: 'A hyperlink to an email address.' },
  {
    name: 'bookmark',
    example: "{{@ .title | bookmark:.reportId | p:'Heading2' }}",
    description:
      'Marks a place so something else can point at it. Names are sanitised to what Word accepts; a name used twice is written once, because Word resolves a duplicate to whichever it meets first.',
  },
  {
    name: 'bookmarkLink',
    example: '{{@ \'see the TLS finding\' | bookmarkLink:\'VULN-02\' | p }}',
    description: 'A clickable jump to a bookmark, showing your own words.',
  },
  {
    name: 'ref',
    example: '{{@ .reportId | ref | p }}',
    description:
      'A cross-reference Word keeps up to date, so renumbering a finding and pressing F9 fixes every mention of it.',
  },
  { name: 'pageRef', example: '{{@ .reportId | pageRef | p }}', description: 'The page a bookmark ended up on — the other half of “see X on page Y”.' },
];

/**
 * @typedef {{tag: string, description: string, kind?: 'value'|'loop'|'rich'}} TagDoc
 * @typedef {{title: string, description: string, tags: TagDoc[]}} TagGroup
 */

/** @type {TagGroup[]} */
export const TAG_GROUPS = [
  {
    title: 'Engagement',
    description: 'Top-level facts about the assessment.',
    tags: [
      { tag: 'name', description: 'Engagement name.' },
      { tag: 'title', description: 'Alias for name.' },
      { tag: 'reference', description: 'Client-facing reference, e.g. PT-2026-014.' },
      { tag: 'auditType', description: 'Engagement type (Web Application, Internal Network, …).' },
      { tag: 'language', description: 'Report locale code.' },
      { tag: 'state', description: 'EDIT, REVIEW or APPROVED.' },
      { tag: 'date', description: 'Report date, formatted with the configured pattern.' },
      { tag: 'date_start', description: 'Testing start date.' },
      { tag: 'date_end', description: 'Testing end date.' },
      { tag: 'now', description: 'Date the report was generated.' },
      {
        tag: 'dateRaw',
        description:
          "Unformatted report date, so a template can impose its own pattern regardless of the instance setting: {{ .dateRaw | date:'dd.MM.yyyy' }}.",
      },
      { tag: 'date_startRaw', description: 'Unformatted testing start date, for use with the date filter.' },
      { tag: 'date_endRaw', description: 'Unformatted testing end date, for use with the date filter.' },
      { tag: 'dateRange', description: 'Testing window as one phrase, e.g. "1 Aug 2026 – 5 Aug 2026".' },
      { tag: 'duration', description: 'Testing days as a number (inclusive of both ends).' },
      { tag: 'durationLabel', description: '"5 days" — the same figure in words.' },
      { tag: 'year', description: "The report date's year, for a copyright line." },
    ],
  },
  {
    title: 'Document control',
    description:
      'For the version table most report templates carry on page two — and for a DRAFT watermark.',
    tags: [
      { tag: 'stateLabel', description: '"In progress", "In review" or "Approved".' },
      {
        tag: 'isDraft',
        description:
          'True until the engagement is approved. Wrap a watermark in it: {{#isDraft}}DRAFT{{/isDraft}}.',
        kind: 'flag',
      },
      { tag: 'isApproved', description: 'True once the engagement is approved.', kind: 'flag' },
      { tag: 'generatedAt', description: 'When this file was produced.' },
      { tag: 'generatedAtRaw', description: 'The same moment unformatted, for the date filter.' },
      { tag: 'generatedBy', description: 'Who pressed Generate.' },
      { tag: 'templateName', description: 'The template this report was built from.' },
      {
        tag: 'approvalCount',
        description: 'How many reviewers have signed off on the report as it stands.',
      },
      {
        tag: 'approved',
        description: 'True when at least one current sign-off exists.',
        kind: 'flag',
      },
      {
        tag: 'staleApprovalCount',
        description: 'Sign-offs given before the text changed. They count for nothing.',
      },
    ],
  },
  {
    title: 'Company',
    description: 'The organisation being assessed.',
    tags: [
      { tag: 'company.name', description: 'Company name.' },
      { tag: 'company.shortName', description: 'Abbreviation.' },
      { tag: 'company.address', description: 'Postal address.' },
      { tag: 'company.website', description: 'Website.' },
      { tag: 'company.logo', description: 'Logo as a data URI (use inside a rich field).' },
    ],
  },
  {
    title: 'Client contact',
    description: 'The named contact for the engagement.',
    tags: [
      { tag: 'client.fullname', description: 'First and last name.' },
      { tag: 'client.firstname', description: 'First name.' },
      { tag: 'client.lastname', description: 'Last name.' },
      { tag: 'client.email', description: 'Email address.' },
      { tag: 'client.phone', description: 'Phone number.' },
      { tag: 'client.cell', description: 'Mobile number.' },
      { tag: 'client.title', description: 'Job title.' },
      {
        tag: 'recipients',
        description:
          'Loop over everyone the report goes to, primary first: fullname, email, title, phone — same fields as client — plus role and roleLabel ("Technical contact", "Management", "Signs off", "Copied in").',
        kind: 'loop',
      },
      {
        tag: 'signatories',
        description:
          'Only the recipients who sign the work off, for a cover page or an acceptance block. Guard it with {{#hasSignatories}}.',
        kind: 'loop',
      },
      {
        tag: 'hasSignatories',
        description: 'True when somebody on the distribution list signs off.',
        kind: 'flag',
      },
      {
        tag: 'technicalRecipients',
        description: 'Only the technical contacts — the default role for a recipient.',
        kind: 'loop',
      },
      {
        tag: 'recipientNames',
        description: 'Every recipient on one line, comma-separated — for a "prepared for" sentence.',
      },
      { tag: 'recipientEmails', description: 'Their email addresses, semicolon-separated.' },
      {
        tag: 'hasRecipients',
        description: 'True when at least one contact is set.',
        kind: 'flag',
      },
    ],
  },
  {
    title: 'People',
    description: 'Who wrote and reviewed the report.',
    tags: [
      { tag: 'creator.fullname', description: 'Report author.' },
      { tag: 'creator.email', description: "Author's email." },
      { tag: 'creator.title', description: "Author's job title." },
      {
        tag: 'creator.qualifications',
        description:
          'Certifications on one line — "OSCP, CREST CRT" — from Skills. Also available on every person in the collaborators, reviewers, team and approvals loops.',
      },
      { tag: 'collaborators', description: 'Loop of testers: fullname, email, title, phone.', kind: 'loop' },
      { tag: 'reviewers', description: 'Loop of reviewers.', kind: 'loop' },
      {
        tag: 'approvals',
        description:
          'Loop of reviewers who signed this report off: fullname, email, title, plus signedOn. Signatures given before the text changed are left out.',
        kind: 'loop',
      },
      {
        tag: 'team',
        description: 'Loop of everyone who worked on it — the author plus collaborators, deduplicated.',
        kind: 'loop',
      },
    ],
  },
  {
    title: 'Findings',
    description:
      'Loop over every finding. Ordered by CVSS score unless the engagement uses manual ordering.',
    tags: [
      { tag: 'findings', description: 'Open the loop, then use the fields below inside it.', kind: 'loop' },
      {
        tag: 'id',
        description:
          'Stable label with the configured prefix, e.g. VULN-01. Belongs to the finding for the life of the engagement — it does not change when findings re-sort, so a retest report agrees with the original. Deleting a finding therefore leaves a gap.',
      },
      {
        tag: 'positionId',
        description:
          'The same shape, but numbered by reading position — use it when the label must run 01, 02, 03 with no gaps.',
      },
      { tag: 'number', description: '1-based position in the report.' },
      { tag: 'title', description: 'Finding title.' },
      { tag: 'vulnType', description: 'Vulnerability type.' },
      { tag: 'category', description: 'Category.' },
      {
        tag: 'severity',
        description:
          'Critical / High / Medium / Low / None — the raw value, which conditions and filters are written against.',
      },
      {
        tag: 'severityLabel',
        description:
          'The severity as this client’s report words it: the standard word, "Informational" for None, or their own scale when one is set on the client record.',
      },
      { tag: 'author', description: 'Who wrote the finding up. Empty if it predates that being recorded.' },
      { tag: 'cvssScore', description: 'CVSS base score, whichever version this finding uses.' },
      { tag: 'cvssv3', description: 'Full CVSS vector string (3.1 or 4.0).' },
      { tag: 'cvssVector', description: 'Same thing, under a version-neutral name.' },
      { tag: 'cvssVersion', description: '"3.1" or "4.0".' },
      { tag: 'severityColor', description: 'Hex colour for the severity, from Settings.' },
      { tag: 'priorityLabel', description: 'Low / Medium / High / Urgent.' },
      { tag: 'remediationComplexityLabel', description: 'Easy / Medium / Complex.' },
      { tag: 'remediationStatus', description: 'open / retesting / fixed.' },
      { tag: 'remediationStatusLabel', description: 'Not fixed / Retesting / Fixed.' },
      { tag: 'description', description: 'Description as plain text.' },
      { tag: 'rich.description', description: 'Description with full Word formatting.', kind: 'rich' },
      { tag: 'rich.observation', description: 'Observation / impact, formatted.', kind: 'rich' },
      { tag: 'rich.remediation', description: 'Remediation advice, formatted.', kind: 'rich' },
      { tag: 'rich.poc', description: 'Proof of concept, including screenshots.', kind: 'rich' },
      { tag: 'rich.scope', description: 'Affected assets, formatted.', kind: 'rich' },
      { tag: 'rich.references', description: 'References as a bullet list.', kind: 'rich' },
      { tag: 'referencesText', description: 'References, one per line.' },
      { tag: 'references', description: 'Loop over reference strings — use {{.}} inside.', kind: 'loop' },
      { tag: 'cvss.metrics.AV', description: 'Readable metric value, e.g. "Network". Any metric in the vector, by its key.' },
      { tag: 'cvss.version', description: '"3.1" or "4.0".' },
      { tag: 'cvss.nomenclature', description: '4.0 only: CVSS-B, -BT, -BE or -BTE — which parts were filled in.' },
      { tag: 'cvss.impact', description: '3.1 only: impact sub-score. Empty for 4.0, which publishes none.' },
      { tag: 'cvss.exploitability', description: '3.1 only: exploitability sub-score.' },
      { tag: 'cvss.temporalScore', description: 'Temporal (3.1) / threat (4.0) score.' },
      { tag: 'cvss.threatScore', description: 'The same number under 4.0’s name for it.' },
      { tag: 'cvss.environmentalScore', description: 'Environmental score.' },
      { tag: 'custom.KEY', description: 'Any finding custom field, by its key.' },
      { tag: 'cwe', description: 'CWE reference, from a finding custom field named "cwe".' },
      { tag: 'owasp', description: 'OWASP reference, from a custom field named "owasp".' },
      { tag: 'severityIndex', description: '0 for Critical through 4 for Informational.' },
      { tag: 'evidenceCount', description: 'How many images the finding carries.' },
      { tag: 'hasEvidence', description: 'True when it has at least one screenshot.', kind: 'flag' },
      {
        tag: 'isOpen',
        description:
          'Remediation state as a flag, for conditional text: {{#isFixed}}Resolved at retest.{{/isFixed}}. Also isRetesting and isFixed.',
        kind: 'flag',
      },
      {
        tag: 'previouslyReported',
        description:
          'True when this client was told about the same issue in an earlier engagement.',
        kind: 'flag',
      },
      {
        tag: 'previously',
        description:
          'Loop of the earlier engagements that reported it, newest first: reference, auditName, date, severity, remediationStatus.',
        kind: 'loop',
      },
      {
        tag: 'previouslyIn',
        description: 'The same engagements as one line — "PT-2025-004, PT-2024-011".',
      },
      { tag: 'firstReported', description: 'When this client was first told, formatted.' },
    ],
  },
  {
    title: 'Grouped findings',
    description:
      'Pre-filtered and pre-grouped lists, for chapters organised by something other than the default order.',
    tags: [
      { tag: 'criticalFindings', description: 'Critical findings only.', kind: 'loop' },
      { tag: 'highFindings', description: 'High findings only.', kind: 'loop' },
      { tag: 'mediumFindings', description: 'Medium findings only.', kind: 'loop' },
      { tag: 'lowFindings', description: 'Low findings only.', kind: 'loop' },
      { tag: 'infoFindings', description: 'Informational findings only.', kind: 'loop' },
      { tag: 'openFindings', description: 'Still not fixed — the retest worklist.', kind: 'loop' },
      { tag: 'retestingFindings', description: 'Currently being retested.', kind: 'loop' },
      { tag: 'fixedFindings', description: 'Confirmed fixed.', kind: 'loop' },
      {
        tag: 'findingsBySeverity',
        description:
          'Loop of { severity, label, color, count, findings } — a nested findings loop per severity, for "one chapter per severity".',
        kind: 'loop',
      },
      {
        tag: 'findingsByCategory',
        description: 'Loop of { category, label, count, findings } — nest a findings loop inside.',
        kind: 'loop',
      },
      {
        tag: 'findingsByType',
        description: 'The same, grouped by vulnerability type.',
        kind: 'loop',
      },
    ],
  },
  {
    title: 'Conditions',
    description:
      'Flags for text that should only appear sometimes. The template language has no comparison operator, so these answer the questions {{^findings}} cannot.',
    tags: [
      { tag: 'hasFindings', description: 'True when anything was found at all.', kind: 'flag' },
      { tag: 'hasCritical', description: 'True when there is at least one Critical.', kind: 'flag' },
      { tag: 'hasHigh', description: 'True when there is at least one High.', kind: 'flag' },
      {
        tag: 'hasSerious',
        description:
          'Critical or High. {{^hasSerious}}No high-risk issues were identified.{{/hasSerious}}',
        kind: 'flag',
      },
      { tag: 'hasScope', description: 'True when the scope has hosts in it.', kind: 'flag' },
      { tag: 'hasChecks', description: 'True when a test checklist exists.', kind: 'flag' },
      { tag: 'hasFixed', description: 'True when something has been fixed — a retest.', kind: 'flag' },
      {
        tag: 'hasRepeats',
        description: 'True when anything here was already reported to this client before.',
        kind: 'flag',
      },
      {
        tag: 'repeatFindings',
        description:
          'Loop of only those findings, for a "previously reported and still present" section.',
        kind: 'loop',
      },
      { tag: 'stats.repeats', description: 'How many findings are repeats.' },
    ],
  },
  {
    title: 'Signatures',
    description:
      'What the team drew on the engagement\u2019s Signatures tab. Not the same as sign-off: this is a mark for the document, while approvals are assurance about the text. Guard it with {{#hasSignatures}}.',
    tags: [
      {
        tag: 'hasSignatures',
        description: 'True when at least one person has signed.',
        kind: 'flag',
      },
      {
        tag: 'rich.signatures',
        description:
          'The whole sign-off block in one tag — {{@rich.signatures}}: each signature as a real image, with the name, title, role and date under it. Must be alone in its paragraph, like every raw tag.',
        kind: 'rich',
      },
      {
        tag: 'signatures',
        description:
          'Loop of { name, title, role, statement, date, signedOn, image } for a template that lays the page out itself. `image` is a data URI, so it only renders inside a rich field.',
        kind: 'loop',
      },
    ],
  },
  {
    title: 'Scope changes',
    description:
      'What the client agreed to change about the scope while testing was under way, from the engagement\u2019s Scope tab. The scope itself only shows where it ended up; this shows how it got there. Guard it with {{#hasScopeChanges}}.',
    tags: [
      {
        tag: 'hasScopeChanges',
        description: 'True when any change was recorded.',
        kind: 'flag',
      },
      {
        tag: 'scopeChanges',
        description:
          'Loop of { kind, kindLabel, date, agreedOn, summary, targets, targetList, agreedBy, channel, note }, oldest first — a "what was agreed" table.',
        kind: 'loop',
      },
      { tag: 'scopeChangeCounts.added', description: 'How many additions were agreed.' },
      { tag: 'scopeChangeCounts.removed', description: 'How many things were taken out of scope.' },
      { tag: 'scopeChangeCounts.clarified', description: 'How many were clarifications rather than changes.' },
      { tag: 'scopeChangeCounts.total', description: 'All of them.' },
    ],
  },
  {
    title: 'Phishing campaign',
    description:
      'The sending list and what happened to each person, from a phishing engagement’s Sending list tab. Guard it with {{#hasPhishing}}.',
    tags: [
      {
        tag: 'hasPhishing',
        description: 'True when a campaign has recipients recorded.',
        kind: 'flag',
      },
      {
        tag: 'phishing',
        description:
          'Loop of { email, name, department, title, wave, sent, opened, clicked, phished, reported, outcome, sentAt, clickedAt, phishedAt, reportedAt, note } — the whole list.',
        kind: 'loop',
      },
      {
        tag: 'phishedTargets',
        description:
          'Only the people who fell for it. Naming individual employees to their employer is not permitted on every engagement — the department breakdown is usually the right table.',
        kind: 'loop',
      },
      { tag: 'phishingSummary.total', description: 'How many people were on the list.' },
      { tag: 'phishingSummary.sent', description: 'How many the mail actually went to.' },
      {
        tag: 'phishingSummary.reached',
        description: 'The denominator every rate below uses — those sent, or the whole list if nothing recorded a send.',
      },
      { tag: 'phishingSummary.opened', description: 'How many opened it.' },
      { tag: 'phishingSummary.clicked', description: 'How many followed the link.' },
      { tag: 'phishingSummary.phished', description: 'How many did what the pretext asked.' },
      { tag: 'phishingSummary.reported', description: 'How many told their security team — the good news.' },
      { tag: 'phishingSummary.noResponse', description: 'How many did nothing at all, either way.' },
      { tag: 'phishingSummary.openedPercent', description: 'Share of those reached who opened it.' },
      { tag: 'phishingSummary.clickedPercent', description: 'Share who clicked.' },
      { tag: 'phishingSummary.phishedPercent', description: 'Share who were phished. The headline.' },
      { tag: 'phishingSummary.reportedPercent', description: 'Share who reported it.' },
      {
        tag: 'phishingSummary.medianClick',
        description: 'Typical time from the send to a click, written out — "4 min".',
      },
      { tag: 'phishingSummary.medianPhish', description: 'Typical time to being phished.' },
      { tag: 'phishingSummary.medianReport', description: 'Typical time to somebody reporting it.' },
      {
        tag: 'phishingSummary.firstPhishMinutes',
        description: 'How many minutes before the first person fell for it.',
      },
      {
        tag: 'phishingSummary.firstReportMinutes',
        description: 'And how many before the first person raised the alarm.',
      },
      {
        tag: 'phishingSummary.reportedBeforeFirstPhish',
        description:
          'True when somebody reported it before anybody was phished. The single most useful thing a campaign can tell a client about their people.',
        kind: 'flag',
      },
      {
        tag: 'phishingSummary.departments',
        description:
          'Loop of { department, total, phished, reported, phishedPercent, reportedPercent }, worst first — the table most reports should print instead of names.',
        kind: 'loop',
      },
      { tag: 'phishingSummary.waves', description: 'The send groups used, if any.' },
    ],
  },
  {
    title: 'Detection',
    description:
      'What the operators did and whether the client’s side noticed, from the engagement’s Detection tab — the answer to "were we seen", which the findings list cannot give. Guard it with {{#hasDetection}}.',
    tags: [
      {
        tag: 'hasDetection',
        description: 'True when any action was logged. Nothing recorded means the report says nothing, rather than implying a clean sheet.',
        kind: 'flag',
      },
      {
        tag: 'detection',
        description:
          'Loop of { action, target, technique, at, outcome, outcomeLabel, noise, noiseLabel, noticed, responded, loudMiss, detectedAt, respondedAt, detectionLatency, responseLatency, source, notes }, oldest first — the timeline.',
        kind: 'loop',
      },
      {
        tag: 'detectionLoudMisses',
        description:
          'The same rows, filtered to deliberately loud actions nothing responded to. Usually the only table a client reads twice.',
        kind: 'loop',
      },
      { tag: 'detectionSummary.total', description: 'How many actions were logged.' },
      {
        tag: 'detectionSummary.confirmed',
        description: 'How many outcomes have actually been confirmed with the client.',
      },
      {
        tag: 'detectionSummary.unconfirmed',
        description: 'And how many are still open questions, so a percentage can be qualified honestly.',
      },
      { tag: 'detectionSummary.noticed', description: 'Actions their telemetry captured, response or not.' },
      { tag: 'detectionSummary.responded', description: 'Actions something or somebody actually acted on.' },
      { tag: 'detectionSummary.missed', description: 'Confirmed actions where nothing happened at all.' },
      {
        tag: 'detectionSummary.loggedOnly',
        description: 'In their logs and nowhere else — a monitoring gap rather than a telemetry gap.',
      },
      { tag: 'detectionSummary.blocked', description: 'Actions that were prevented outright.' },
      {
        tag: 'detectionSummary.noticedPercent',
        description: 'Share of confirmed actions their telemetry captured.',
      },
      {
        tag: 'detectionSummary.respondedPercent',
        description: 'Share of confirmed actions that drew a response. The headline number.',
      },
      {
        tag: 'detectionSummary.medianDetect',
        description: 'Typical time to notice, written out — "1 h 34 min". The median, so one late discovery does not set the figure.',
      },
      { tag: 'detectionSummary.medianRespond', description: 'Typical time from action to response.' },
      {
        tag: 'detectionSummary.loudMisses',
        description: 'How many deliberately loud actions went unanswered.',
      },
      {
        tag: 'detectionSummary.loudTotal',
        description: 'How many were deliberately loud, so the miss count has a denominator.',
      },
      {
        tag: 'detectionSummary.quietCatches',
        description: 'Quiet work they caught anyway — the credit side of the same table.',
      },
      {
        tag: 'detectionSummary.byOutcome',
        description: 'Loop of { outcome, label, count, percent } for a summary table.',
        kind: 'loop',
      },
      {
        tag: 'detectionSummary.techniques',
        description:
          'Loop of { technique, total, confirmed, unconfirmed, noticed, responded, noticedPercent, respondedPercent, rated } — coverage per technique, busiest first. Guard the percentages with {{#rated}}: a technique with nothing confirmed has no rate, and printing 0% would accuse the client of a failure nobody established.',
        kind: 'loop',
      },
    ],
  },
  {
    title: 'Delivery record',
    description:
      'Every version of this report that has been sent, from the engagement\u2019s Delivery tab — the document-control table, kept once rather than retyped each issue. Guard it with {{#hasDeliveries}}.',
    tags: [
      {
        tag: 'hasDeliveries',
        description: 'True when at least one delivery has been recorded.',
        kind: 'flag',
      },
      {
        tag: 'deliveries',
        description:
          'Loop of { version, date, sentAt, channel, recipientList, recipients, filename, fileHash, fileHashShort, hashAlgorithm, note }, oldest first — a revision history table.',
        kind: 'loop',
      },
      {
        tag: 'lastDelivery.version',
        description: 'The version most recently sent, for a cover page: "Version 1.1".',
      },
      { tag: 'lastDelivery.date', description: 'When that version was sent, already formatted.' },
      {
        tag: 'lastDelivery.recipientList',
        description: 'Who it went to, as one line: "A. Turner, procurement@acme.example".',
      },
      {
        tag: 'lastDelivery.fileHashShort',
        description:
          'First twelve characters of the SHA-256 of the file that was sent — enough for a document-control table, and enough to settle which copy somebody is holding.',
      },
    ],
  },
  {
    title: 'Effort',
    description:
      'What the engagement actually took, from the hours the team logged against it. Nothing is logged automatically, so guard the paragraph with {{#hasEffort}} — an engagement nobody logged time on must not print "0 days".',
    tags: [
      {
        tag: 'hasEffort',
        description: 'True when anybody has logged hours against this engagement.',
        kind: 'flag',
      },
      {
        tag: 'effort.days',
        description:
          'Person-days, to two decimals, at eight hours to the day. This is the figure clients are quoted in: "6.5 person-days".',
      },
      { tag: 'effort.hours', description: 'The same effort in hours.' },
      { tag: 'effort.hoursPerDay', description: 'What a day is worth here — 8.' },
      {
        tag: 'effort.people',
        description:
          'Loop of { name, title, hours, days, effortDays } — one row per person, most hours first. `days` is how many calendar days they touched it.',
        kind: 'loop',
      },
      { tag: 'effort.firstDay', description: 'The first day anybody logged time. Raw yyyy-mm-dd; pipe it through the date filter to format it.' },
      { tag: 'effort.lastDay', description: 'The last day anybody logged time.' },
      { tag: 'effort.entries', description: 'How many day-entries make up the total.' },
    ],
  },
  {
    title: 'Statistics',
    description: 'Counts for summary tables and charts.',
    tags: [
      { tag: 'stats.total', description: 'Total findings.' },
      { tag: 'stats.critical', description: 'Critical count.' },
      { tag: 'stats.high', description: 'High count.' },
      { tag: 'stats.medium', description: 'Medium count.' },
      { tag: 'stats.low', description: 'Low count.' },
      { tag: 'stats.info', description: 'Informational count.' },
      { tag: 'stats.highest', description: 'Severity of the worst finding.' },
      {
        tag: 'stats.riskRating',
        description:
          "The engagement's overall rating — the worst finding's severity. Most executive summaries lead with this.",
      },
      {
        tag: 'stats.riskRatingLabel',
        description:
          'The same in words — "Informational" for None, or whatever this client calls that severity if they have their own scale.',
      },
      { tag: 'stats.riskRatingColor', description: 'Hex colour for the overall rating.' },
      { tag: 'stats.averageScore', description: 'Mean CVSS base score across the findings.' },
      { tag: 'stats.maxScore', description: 'Highest CVSS base score.' },
      { tag: 'stats.openSerious', description: 'Critical and High findings that are still not fixed.' },
      { tag: 'stats.fixRate', description: 'Percentage of findings marked fixed.' },
      {
        tag: 'stats.byCategory',
        description: 'Loop of { label, count, percent } — one row per category, most common first.',
        kind: 'loop',
      },
      { tag: 'stats.byType', description: 'The same, per vulnerability type.', kind: 'loop' },
      { tag: 'stats.byPriority', description: 'The same, per remediation priority.', kind: 'loop' },
      {
        tag: 'stats.bySeverity',
        description:
          'Loop of { severity, label, count, percent, color } — one row per severity. `percent` is the share of all findings, handy for sizing a bar in an HTML template.',
        kind: 'loop',
      },
      { tag: 'stats.fixed', description: 'Findings marked fixed.' },
      { tag: 'stats.retesting', description: 'Findings currently being retested.' },
      { tag: 'stats.notFixed', description: 'Findings still open. Same as stats.open.' },
      {
        tag: 'stats.byStatus',
        description: 'Loop of { status, label, count } — one row per remediation status.',
        kind: 'loop',
      },
    ],
  },
  {
    title: 'Sections',
    description:
      'Narrative blocks. Address one directly by its field name, or loop over all of them.',
    tags: [
      { tag: 'sections.executive_summary.name', description: 'Section heading.' },
      {
        tag: 'sections.executive_summary.rich.text',
        description: 'Section body with full formatting. Replace the middle part with your own field name.',
        kind: 'rich',
      },
      { tag: 'sections.executive_summary.text', description: 'Section body as plain text.' },
      { tag: 'sectionList', description: 'Loop over every section: name, field, text, rich.text.', kind: 'loop' },
    ],
  },
  {
    title: 'Scope',
    description: 'Assets in scope.',
    tags: [
      { tag: 'scope', description: 'Loop of scope groups: name, hostList, hosts.', kind: 'loop' },
      { tag: 'hosts', description: 'Flat loop of every host: hostname, ip, os, services.', kind: 'loop' },
      {
        tag: 'scopeSummary',
        description: 'Every in-scope asset on one line — drop it straight into a sentence.',
      },
      {
        tag: 'scopeStats.hosts',
        description: 'How many hosts were in scope. Also .groups, .services and .ports.',
      },
      { tag: 'portList', description: 'Every distinct open port found, comma-separated and sorted.' },
      { tag: 'hostname', description: 'Hostname (inside a hosts loop).' },
      { tag: 'ip', description: 'IP address (inside a hosts loop).' },
      { tag: 'os', description: 'Operating system (inside a hosts loop).' },
      { tag: 'services', description: 'Loop of services: port, protocol, name, product.', kind: 'loop' },
    ],
  },
  {
    title: 'Test checks',
    description:
      'What the team set out to test and whether it was verified — the honest counterpart to the findings list, for a "technical checks" section.',
    tags: [
      {
        tag: 'testChecks',
        description:
          'Flat loop of every check: title, description, category, done, status, result, verifiedBy, verifiedOn.',
        kind: 'loop',
      },
      {
        tag: 'checkGroups',
        description:
          'Loop of categories: { category, total, done, percent, checks }. Loop `checks` inside for a grouped table.',
        kind: 'loop',
      },
      { tag: 'status', description: 'Verified / Not tested (inside a checks loop).' },
      {
        tag: 'blockedReason',
        description:
          'Why a blocked check could not be done — "the firewall was never opened". Produced by the app and previously undocumented, so a template using it was warned about on upload.',
      },
      { tag: 'verifiedBy', description: 'Who ticked the check off (inside a checks loop).' },
      { tag: 'verifiedOn', description: 'When it was ticked (inside a checks loop).' },
      { tag: 'checkStats.total', description: 'Number of checks on the list.' },
      { tag: 'checkStats.done', description: 'How many were verified.' },
      { tag: 'checkStats.outstanding', description: 'How many were not.' },
      { tag: 'checkStats.percent', description: 'Percentage verified.' },
    ],
  },
  {
    title: 'Custom fields & palette',
    description: 'Your own fields, plus the severity colours from Settings.',
    tags: [
      {
        tag: 'custom.KEY',
        description:
          'A custom field by its key, always printable: a multiselect joins with commas, a checkbox reads Yes or No, and a rich-text field prints as plain text. Works at engagement, finding and section level.',
      },
      {
        tag: 'rich.custom.KEY',
        description:
          'A rich-text ("editor") custom field with its formatting kept. Must be the only thing in its paragraph, like the other @ tags.',
        kind: 'rich',
      },
      { tag: 'colors.critical', description: 'Critical colour (hex, no #). Also high, medium, low, none.' },
    ],
  },
];

/**
 * The tags a *proposal* template can use — the NDA, the permission to attack, the offer.
 *
 * A separate list rather than more entries in TAG_GROUPS, because they are a different
 * vocabulary for a different document, and mixing them would offer `{{ findings }}` to
 * somebody writing a contract. What overlaps is deliberate: `company`, `client`, `now` and the
 * date filters mean the same thing in both, so whoever writes these has one habit and not two.
 */
/**
 * The money. Every amount twice: a number, and the same thing already written out.
 *
 * A template doing its own arithmetic wants `price.net`; a template printing a line in a table wants
 * `price.netText`, which is grouped and carries the currency. Without the second, an author would
 * have to write thousands separators inside a tag, which is not a thing a tag can do.
 */
const PRICE_TAGS = {
  title: 'The price',
  description:
    'From the rate card, the client’s own rate or the proposal’s, times the days agreed. Every amount ' +
    'also has a *Text form, already formatted with the currency. Empty when no rate card is set.',
  tags: [
    { tag: 'isPriced', description: 'True when there is a real figure. Use as {{#isPriced}}…{{/isPriced}} so an offer with no rate card prints no price section.', kind: 'loop' },
    { tag: 'isDiscounted', description: 'True when a discount was given, for a "was/now" line.', kind: 'loop' },
    { tag: 'price.currency', description: 'The currency code, e.g. EUR.' },
    { tag: 'price.days', description: 'Days being charged for — the agreed figure where there is one.' },
    { tag: 'price.dayRate', description: 'The rate in force, as a number.' },
    { tag: 'price.dayRateText', description: 'The same, written out: "1 200.00 EUR".' },
    { tag: 'price.gross', description: 'Rate times days, before any discount.' },
    { tag: 'price.grossText', description: 'The same, written out.' },
    { tag: 'price.discountPercent', description: 'The discount as a percentage, empty when there is none.' },
    { tag: 'price.discount', description: 'The discount as an amount.' },
    { tag: 'price.discountText', description: 'The same, written out.' },
    { tag: 'price.net', description: 'What they are being asked for, before tax.' },
    { tag: 'price.netText', description: 'The same, written out — the headline figure on most offers.' },
    { tag: 'price.taxLabel', description: 'What tax is called here, e.g. VAT.' },
    { tag: 'price.taxPercent', description: 'The rate of it.' },
    { tag: 'price.tax', description: 'The tax amount.' },
    { tag: 'price.taxText', description: 'The same, written out.' },
    { tag: 'price.total', description: 'Net plus tax.' },
    { tag: 'price.totalText', description: 'The same, written out.' },
    { tag: 'price.paymentTermsDays', description: 'Days to pay — the client’s own terms where they have them.' },
  ],
};

/** The client's side of the invoice, which an offer quotes so that an invoice can. */
const BILLING_TAGS = {
  title: 'Billing',
  description: 'The purchase order and the client’s invoicing details.',
  tags: [
    { tag: 'billing.poNumber', description: 'Their purchase order, where one has been given.' },
    { tag: 'billing.clientVat', description: 'The client’s tax registration, for a reverse-charge clause.' },
    { tag: 'billing.invoiceEmail', description: 'Where their invoices go.' },
    { tag: 'billing.invoiceAddress', description: 'The invoicing address, when it is not the main one.' },
  ],
};

/** Sold as one agreement rather than one job. Empty on an ordinary proposal. */
const RETAINER_TAGS = {
  title: 'Retainer',
  description: 'Several engagements sold together. Every tag here is empty on a one-off proposal.',
  tags: [
    { tag: 'isRetainer', description: 'True when more than one engagement was sold. Use as {{#isRetainer}}…{{/isRetainer}}.', kind: 'loop' },
    { tag: 'retainer.engagements', description: 'How many engagements the agreement covers.' },
    { tag: 'retainer.everyMonths', description: 'Months between one and the next.' },
    { tag: 'retainer.summary', description: '"4 engagements, one every 3 months" — the sentence, already assembled.' },
  ],
};

export const PROPOSAL_TAG_GROUPS = [
  {
    title: 'The proposal',
    description: 'What was asked for, and the reference the paperwork calls itself by.',
    tags: [
      { tag: 'reference', description: 'PRO-2026-014 — the reference of this proposal.' },
      { tag: 'title', description: 'What the work is. Also available as `name`.' },
      { tag: 'auditType', description: 'Type of work. Also available as `engagementType`.' },
      { tag: 'summary', description: 'What the client asked for, as plain text.' },
      { tag: 'constraints', description: 'Anything that changes the price — out of hours, retest, sites.' },
      { tag: 'statusLabel', description: 'Where it has got to, in words.' },
      { tag: 'docTypeLabel', description: '“NDA”, “Permission to attack” — which document this render is.' },
      { tag: 'rich.summary', kind: 'rich', description: 'The same summary, with its formatting kept.' },
      { tag: 'rich.constraints', kind: 'rich', description: 'The constraints, with formatting.' },
      { tag: 'rich.evaluationNotes', kind: 'rich', description: 'The technical evaluation, with formatting.' },
    ],
  },
  {
    title: 'Us',
    description: 'The first party. Filled in once under Settings → Your firm, not per document.',
    tags: [
      { tag: 'firm.legalName', description: 'Registered company name.' },
      { tag: 'firm.address', description: 'Registered address.' },
      { tag: 'firm.registration', description: 'Company number.' },
      { tag: 'firm.vat', description: 'VAT number.' },
      { tag: 'firm.email', description: 'Contact email.' },
      { tag: 'firm.phone', description: 'Contact phone.' },
      { tag: 'firm.signatoryName', description: 'Who signs on our behalf.' },
      { tag: 'firm.signatoryTitle', description: 'Their job title, for under the signature.' },
      { tag: 'firm.jurisdiction', description: 'Governing law, e.g. “England and Wales”.' },
    ],
  },
  {
    title: 'Them',
    description: 'The client. The same keys and fields as a report, so one habit covers both.',
    tags: [
      { tag: 'company.name', description: 'The client name, as it should read on a contract.' },
      { tag: 'company.shortName', description: 'Short form, for running text.' },
      { tag: 'company.address', description: 'Their registered address.' },
      { tag: 'company.website', description: 'Their website.' },
      { tag: 'company.logo', kind: 'rich', description: 'Their logo, if one is on record.' },
      { tag: 'client.fullname', description: 'The primary contact — the person who signs.' },
      { tag: 'client.title', description: 'Their job title.' },
      { tag: 'client.email', description: 'Their email address.' },
      { tag: 'client.phone', description: 'Their phone number.' },
      {
        tag: 'contacts',
        kind: 'loop',
        description: 'Everyone it is addressed to. Fields: fullname, title, email, phone.',
      },
      { tag: 'hasContacts', description: 'True when there is at least one, for a conditional block.' },
    ],
  },
  {
    title: 'Effort and dates',
    description: 'What it will take, and when. Both effort figures are available.',
    tags: [
      { tag: 'effort.daysLabel', description: '“9 days” — the agreed figure in words, pluralised.' },
      { tag: 'effort.days', description: 'The agreed figure as a number, falling back to the sales one.' },
      { tag: 'effort.agreedDays', description: 'What whoever would do the work said. Empty if nobody has yet.' },
      { tag: 'effort.salesDays', description: 'What sales originally quoted.' },
      { tag: 'effort.agreed', description: 'True once somebody who would do the work has confirmed it.' },
      { tag: 'effort.revised', description: 'True when the agreed figure differs from the quoted one.' },
      { tag: 'effort.note', description: 'Why it differs, if it does.' },
      { tag: 'requestedOn', description: 'When they asked.' },
      { tag: 'expectedStart', description: 'Hoped start date.' },
      { tag: 'expectedEnd', description: 'Hoped end date.' },
      { tag: 'dateRange', description: 'The window as one phrase.' },
      { tag: 'validUntil', description: 'When the offer lapses.' },
      { tag: 'now', description: 'Today, formatted with the configured pattern.' },
      {
        tag: 'validUntilRaw',
        description:
          'Unformatted, so a template can impose its own pattern: {{ .validUntilRaw | date:“dd.MM.yyyy” }}. Also requestedOnRaw, expectedStartRaw and expectedEndRaw.',
      },
    ],
  },
  {
    title: 'The kickoff',
    description:
      'What was agreed on the call. This is what a permission to attack is written from, so a template can leave the whole section out when the call has not happened.',
    tags: [
      { tag: 'kickoff.held', description: 'True once a kickoff date has been recorded. Use it to wrap the section.' },
      { tag: 'kickoff.heldOn', description: 'The date of the call.' },
      { tag: 'kickoff.attendeesOurs', description: 'Who was there from us.' },
      { tag: 'kickoff.attendeesTheirs', description: 'Who was there from the client.' },
      {
        tag: 'kickoff.emergencyContact',
        description:
          'Who to ring during testing, and on what number. A permission to attack without one tells somebody they may break things and not who to tell when they do.',
      },
      { tag: 'kickoff.notes', description: 'What was agreed, as plain text.' },
      { tag: 'rich.kickoffNotes', kind: 'rich', description: 'The same notes, with formatting.' },
      { tag: 'kickoff.heldOnRaw', description: 'Unformatted, for use with the date filter.' },
    ],
  },
  {
    title: 'Ours and theirs',
    description: 'Who to ask about it, and what the technical read was.',
    tags: [
      { tag: 'owner.fullname', description: 'The salesperson whose deal this is.' },
      { tag: 'owner.email', description: 'Their email — “your contact with us”.' },
      { tag: 'owner.phone', description: 'Their phone number.' },
      { tag: 'evaluation.verdict', description: 'feasible, needs-more-info or not-for-us.' },
      { tag: 'evaluation.notes', description: 'The technical evaluation, as plain text.' },
      { tag: 'evaluation.by', description: 'Who wrote it.' },
      { tag: 'evaluation.at', description: 'When they wrote it.' },
      { tag: 'generatedAt', description: 'When this file was produced.' },
      { tag: 'generatedBy', description: 'Who produced it.' },
      { tag: 'templateName', description: 'Which template produced it.' },
      { tag: 'year', description: 'This year, for a copyright line.' },
    ],
  },
  RETAINER_TAGS,
  PRICE_TAGS,
  BILLING_TAGS,
];

export const TAG_REFERENCE = {
  syntax: TAG_SYNTAX,
  filters: FILTERS,
  groups: TAG_GROUPS,
  /** The proposal vocabulary. Same syntax and the same filters; a different set of names. */
  proposalGroups: PROPOSAL_TAG_GROUPS,
};

let rootCache = null;

/**
 * The set of accepted first path segments. Used to warn about typos in an
 * uploaded template without rejecting it.
 */
export function knownTagRoots() {
  if (rootCache) return rootCache;
  const roots = new Set([
    // Loop-local field names, valid inside findings/sections/hosts/services.
    'this', '$index', '$number', 'rich', 'custom',
    /*
     * The loop-position helpers, which `createParser` handles by name. Described in the syntax
     * notes above but never in this list, so a template using the page break — the thing the
     * notes recommend — was reported as containing a tag that does not exist.
     */
    '$pageBreakExceptLast', '$pageBreakExceptFirst', '$first', '$last', '$total',
    // Fields of the stats.bySeverity / stats.byStatus rows.
    'label', 'count', 'percent', 'color', 'status',
    // Fields of a testChecks / checkGroups row.
    'done', 'verifiedBy', 'verifiedOn', 'result', 'checks', 'total',
    'identifier', 'index', 'number', 'id', 'positionId', 'title', 'vulnType', 'category',
    'severity', 'severityLabel', 'severityColor', 'author',
    'cvss', 'cvssv3', 'cvssVector', 'cvssVersion', 'cvssScore', 'priority',
    'priorityLabel', 'remediationComplexity', 'remediationComplexityLabel',
    'description', 'observation', 'remediation', 'poc', 'references',
    'referencesText', 'field', 'name', 'text', 'hostname', 'ip', 'os',
    'services', 'hosts', 'hostList', 'port', 'protocol', 'product',
    'fullname', 'firstname', 'lastname', 'email', 'phone', 'username', 'role',
    // Per-finding additions, valid inside a findings loop.
    'cwe', 'owasp', 'severityIndex', 'evidenceCount', 'hasEvidence',
    'isOpen', 'isRetesting', 'isFixed',
    // Fields of a `previously` row: where the same issue was reported before.
    'auditName', 'reference', 'date', 'findingId', 'auditId', 'score', 'remediationStatus',
    // A row of the `approvals` loop: the person, plus when they signed.
    'signedOn',
    // A row of the `effort.people` loop.
    'hours', 'days', 'effortDays',
    // A row of the `recipients` loop.
    'role', 'roleLabel',
    // A row of the `signatures` loop.
    'statement', 'image',
    // A row of the `scopeChanges` loop.
    'kind', 'kindLabel', 'summary', 'targets', 'targetList', 'agreedBy', 'channel', 'agreedOn',
    // A row of the `phishing` loop, and of `phishingSummary.departments`.
    'department', 'wave', 'sent', 'opened', 'clicked', 'phished', 'reported',
    'phishedPercent', 'reportedPercent', 'sentAt', 'clickedAt', 'phishedAt', 'reportedAt',
    // A row of the `detection` loop, and of `detectionSummary.techniques`.
    'action', 'target', 'technique', 'at', 'outcome', 'outcomeLabel', 'noise', 'noiseLabel',
    'noticed', 'responded', 'unconfirmed', 'loudMiss', 'detectedAt', 'respondedAt',
    'detectionLatency', 'responseLatency', 'noticedPercent', 'respondedPercent',
    'confirmed', 'rated', 'source', 'notes',
    // `findings` is also the nested loop inside a findingsBy* group row.
    'findings',
  ]);
  /*
   * Both vocabularies, in one set. A proposal template's own tags — `validUntil`, `constraints`,
   * `retainer.*` — were documented but never added here, so the lint reported every one of them as a
   * tag that does not exist: the offer templates shipped with the app warned about themselves. One
   * set over-accepts across purposes (a report using `validUntil` is not flagged) which is the
   * cheaper mistake by a wide margin, since the warning exists to catch typos, not to police intent.
   */
  for (const group of [...TAG_GROUPS, ...PROPOSAL_TAG_GROUPS]) {
    for (const { tag } of group.tags) roots.add(tag.split('.')[0]);
  }
  rootCache = roots;
  return roots;
}

export default TAG_REFERENCE;
