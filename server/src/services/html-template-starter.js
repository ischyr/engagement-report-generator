/**
 * The HTML report template new users start from.
 *
 * Written for print as much as for screen: `@page` sets A4 with real margins,
 * `position: running()` is avoided in favour of a fixed-position header/footer
 * (which every current browser honours when printing), and page-break rules keep
 * a finding's heading attached to its body. Print it and the browser's own PDF
 * engine produces the file — no server-side renderer involved.
 *
 * It is deliberately one self-contained document: a report has to survive being
 * emailed as a single file.
 */

export const STARTER_HTML_TEMPLATE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ .name }} — {{ .company.name }}</title>
<style>
  /* ---------- page setup: what the PDF actually looks like ---------- */
  @page {
    size: A4;
    margin: 22mm 18mm 20mm 18mm;
  }
  /* Cover gets no running header, so it stays clean. */
  @page :first { margin-top: 0; }

  :root {
    --ink: #1f2937;
    --muted: #6b7280;
    --rule: #e5e7eb;
    --accent: #1f3864;
    --crit: #b3123a;
    --high: #c2410c;
    --med:  #a16207;
    --low:  #15803d;
    --info: #1d4ed8;
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 10.5pt/1.6 "Calibri", "Segoe UI", system-ui, sans-serif;
    color: var(--ink);
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  h1, h2, h3, h4 { color: var(--accent); line-height: 1.25; }
  h1 { font-size: 20pt; margin: 0 0 6pt; }
  h2 { font-size: 15pt; margin: 22pt 0 8pt; padding-bottom: 4pt; border-bottom: 1px solid var(--rule); }
  h3 { font-size: 12pt; margin: 14pt 0 4pt; }
  h4 { font-size: 10.5pt; margin: 10pt 0 3pt; color: var(--ink); text-transform: uppercase; letter-spacing: .04em; }
  p { margin: 0 0 8pt; }
  a { color: var(--info); }

  /* ---------- cover ---------- */
  .cover {
    height: 100vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
    padding: 0 18mm;
    text-align: center;
    page-break-after: always;
  }
  .cover .kicker { font-size: 9pt; letter-spacing: .22em; text-transform: uppercase; color: var(--muted); }
  .cover h1 { font-size: 30pt; margin: 10pt 0; }
  .cover .client { font-size: 15pt; color: var(--ink); }
  .cover .meta { margin-top: 26pt; font-size: 10pt; color: var(--muted); }
  .cover .classification {
    margin-top: 30pt; font-size: 8.5pt; letter-spacing: .16em;
    text-transform: uppercase; color: var(--crit);
  }

  /* ---------- running header and footer ---------- */
  /* Fixed positioning repeats these on every printed page. */
  @media print {
    .running-header, .running-footer { position: fixed; left: 0; right: 0; }
    .running-header { top: -14mm; }
    .running-footer { bottom: -12mm; }
  }
  .running-header, .running-footer {
    font-size: 8pt; color: var(--muted);
    display: flex; justify-content: space-between;
  }
  .running-header { border-bottom: 1px solid var(--rule); padding-bottom: 3pt; }
  .running-footer { border-top: 1px solid var(--rule); padding-top: 3pt; }

  /* ---------- tables ---------- */
  table { width: 100%; border-collapse: collapse; margin: 8pt 0 12pt; font-size: 9.5pt; }
  th, td { border: 1px solid var(--rule); padding: 5pt 7pt; text-align: left; vertical-align: top; }
  th { background: #f3f4f6; font-weight: 600; }
  .kv th { width: 30%; }
  thead { display: table-header-group; }  /* repeat headers across pages */
  tr, td, th { page-break-inside: avoid; }

  /* ---------- severity ---------- */
  .sev { display: inline-block; padding: 1pt 6pt; border-radius: 3pt; font-size: 8.5pt;
         font-weight: 700; color: #fff; letter-spacing: .04em; }
  .sev-Critical { background: var(--crit); }
  .sev-High     { background: var(--high); }
  .sev-Medium   { background: var(--med); }
  .sev-Low      { background: var(--low); }
  .sev-None     { background: var(--info); }

  .score { font-variant-numeric: tabular-nums; font-weight: 700; }

  /* ---------- findings ---------- */
  .finding { page-break-before: always; }
  .finding > h2 { margin-top: 0; }
  /* Never orphan a heading at the foot of a page. */
  h2, h3, h4 { page-break-after: avoid; break-after: avoid; }

  .finding-head { display: flex; align-items: baseline; gap: 8pt; margin-bottom: 2pt; }
  .finding-id { font-size: 9pt; color: var(--muted); font-variant-numeric: tabular-nums; }

  /* ---------- rich text coming from the editor ---------- */
  .rich :first-child { margin-top: 0; }
  .rich :last-child { margin-bottom: 0; }
  .rich ul, .rich ol { margin: 0 0 8pt; padding-left: 18pt; }
  .rich li { margin: 2pt 0; }
  .rich blockquote {
    margin: 8pt 0; padding: 4pt 10pt;
    border-left: 3px solid var(--accent); color: #4b5563; font-style: italic;
  }
  .rich code {
    font-family: "Consolas", "Courier New", monospace; font-size: 9pt;
    background: #f3f4f6; padding: 0 3pt; border-radius: 2pt;
  }
  /* Terminal-style code blocks, matching the .docx output. */
  .rich pre {
    background: #0d1117; color: #e6edf3;
    padding: 8pt 10pt; border-radius: 4pt; overflow-x: auto;
    font-family: "Consolas", "Courier New", monospace; font-size: 8.5pt; line-height: 1.45;
    white-space: pre-wrap; word-break: break-word;
    page-break-inside: avoid;
  }
  .rich pre code { background: none; color: inherit; padding: 0; }
  .rich img { max-width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 3pt; }
  /* A captioned screenshot. Kept with its caption across a page break. */
  .rich figure { margin: 8pt 0; page-break-inside: avoid; }
  .rich figcaption { margin-top: 3pt; font-size: 8pt; color: var(--muted); text-align: center; }

  .muted { color: var(--muted); }
  .empty { color: var(--muted); font-style: italic; }

  /* ---------- summary chart ---------- */
  .bars { margin: 10pt 0 14pt; }
  .bar-row { display: flex; align-items: center; gap: 8pt; margin: 3pt 0; font-size: 9.5pt; }
  .bar-label { width: 70pt; }
  .bar-track { flex: 1; height: 9pt; background: #f3f4f6; border-radius: 5pt; overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5pt; }
  .bar-count { width: 22pt; text-align: right; font-variant-numeric: tabular-nums; font-weight: 600; }
</style>
</head>
<body>

<header class="running-header">
  <span>{{ .company.name }} — {{ .auditType }}</span>
  <span>{{ .reference }}</span>
</header>
<footer class="running-footer">
  <span>{{ .custom.classification | default:'Confidential' }}</span>
  <span>{{ .name }}</span>
</footer>

<!-- ============================ COVER ============================ -->
<section class="cover">
  <p class="kicker">Penetration Test Report</p>
  <h1>{{ .name }}</h1>
  <p class="client">{{ .company.name }}</p>
  <div class="meta">
    <p>{{ .auditType }}</p>
    <p>Testing period: {{ .date_start }} – {{ .date_end }}</p>
    <p>Report date: {{ .date }}</p>
    <p>Prepared by {{ .creator.fullname }}{{#creator.title}}, {{ .creator.title }}{{/creator.title}}</p>
  </div>
  <p class="classification">{{ .custom.classification | default:'Confidential' }}</p>
</section>

<!-- ======================= DOCUMENT CONTROL ======================= -->
<h2>Document control</h2>
<table class="kv">
  <tr><th>Client</th><td>{{ .company.name }}</td></tr>
  <tr><th>Contact</th><td>{{ .client.fullname | default:'—' }}{{#client.email}} ({{ .client.email }}){{/client.email}}</td></tr>
  <!-- Everyone the report goes to. Loop "recipients" for a table, or use
       "recipientNames" for a single line as here. -->
  <tr><th>Distribution</th><td>{{ .recipientNames | default:'—' }}</td></tr>
  <tr><th>Engagement</th><td>{{ .auditType | default:'—' }}</td></tr>
  <tr><th>Reference</th><td>{{ .reference | default:'—' }}</td></tr>
  <tr><th>Testing window</th><td>{{ .dateRange | default:'—' }}{{#durationLabel}} ({{ .durationLabel }}){{/durationLabel}}</td></tr>
  <tr><th>Author</th><td>{{ .creator.fullname }}</td></tr>
  <tr><th>Status</th><td>{{ .stateLabel }}{{#approved}} · {{ .approvalCount }} approval(s){{/approved}}</td></tr>
  <tr><th>Overall rating</th><td><strong style="color:#{{ .stats.riskRatingColor }}">{{ .stats.riskRatingLabel }}</strong></td></tr>
  <tr><th>Generated</th><td>{{ .generatedAt }}{{#generatedBy}} by {{ .generatedBy }}{{/generatedBy}}</td></tr>
</table>

<h3>Assessment team</h3>
<table>
  <thead><tr><th>Name</th><th>Role</th><th>Email</th></tr></thead>
  <tbody>
    <!-- team is the author plus collaborators, deduplicated. -->
    {{#team}}
    <tr><td>{{ .fullname }}</td><td>{{ .title | default:'Security Consultant' }}</td><td>{{ .email }}</td></tr>
    {{/team}}
  </tbody>
</table>

<!-- ====================== EXECUTIVE SUMMARY ====================== -->
<h2>Executive summary</h2>
<div class="rich">
  {{@sections.executive_summary.rich.text}}
  {{^sections.executive_summary.text}}<p class="empty">No executive summary written yet.</p>{{/sections.executive_summary.text}}
</div>

<h3>Findings at a glance</h3>
<div class="bars">
  {{#stats.bySeverity}}
  <div class="bar-row">
    <span class="bar-label">{{ .label }}</span>
    <span class="bar-track">
      <span class="bar-fill sev-{{ .severity }}" style="width: {{ .percent }}%"></span>
    </span>
    <span class="bar-count">{{ .count }}</span>
  </div>
  {{/stats.bySeverity}}
</div>
<p class="muted">
  {{ .stats.total }} finding(s) in total, average CVSS {{ .stats.averageScore }}.
  <!-- Flags carry the conditional sentences; the template language has no "if". -->
  {{^hasSerious}}No high-risk issues were identified.{{/hasSerious}}
  {{#hasSerious}}{{ .stats.openSerious }} critical or high issue(s) remain unresolved.{{/hasSerious}}
  {{#hasFixed}}{{ .stats.fixRate }}% of findings have been confirmed fixed.{{/hasFixed}}
</p>

<h3>Summary of findings</h3>
<table>
  <thead>
    <tr><th style="width:12%">ID</th><th>Finding</th><th style="width:16%">Severity</th><th style="width:12%">CVSS</th></tr>
  </thead>
  <tbody>
    {{#findings}}
    <tr>
      <td>{{ .id }}</td>
      <td>{{ .title }}</td>
      <td><span class="sev sev-{{ .severity }}">{{ .severity }}</span></td>
      <td class="score">{{ .cvssScore }}</td>
    </tr>
    {{/findings}}
    {{^findings}}
    <tr><td colspan="4" class="empty">No findings recorded.</td></tr>
    {{/findings}}
  </tbody>
</table>

<!-- =========================== SCOPE =========================== -->
<h2>Scope</h2>
<div class="rich">{{@sections.scope_and_approach.rich.text}}</div>
<table>
  <thead><tr><th>Hostname</th><th>IP address</th><th>Operating system</th></tr></thead>
  <tbody>
    {{#hosts}}
    <tr><td>{{ .hostname | default:'—' }}</td><td>{{ .ip | default:'—' }}</td><td>{{ .os | default:'—' }}</td></tr>
    {{/hosts}}
    {{^hosts}}
    <tr><td colspan="3" class="empty">No assets recorded.</td></tr>
    {{/hosts}}
  </tbody>
</table>

<!-- ========================= METHODOLOGY ======================== -->
<h2>Methodology</h2>
<div class="rich">{{@sections.methodology.rich.text}}</div>

<!-- ========================== FINDINGS ========================== -->
{{#findings}}
<section class="finding">
  <div class="finding-head">
    <span class="finding-id">{{ .id }}</span>
    <span class="sev sev-{{ .severity }}">{{ .severity }} · {{ .cvssScore }}</span>
  </div>
  <h2>{{ .title }}</h2>

  <table class="kv">
    <tr><th>CVSS v{{ .cvss.version }}</th><td><code>{{ .cvssv3 }}</code> <small>{{ .cvss.nomenclature }}</small></td></tr>
    <tr><th>Category</th><td>{{ .category | default:'—' }} {{#vulnType}}· {{ .vulnType }}{{/vulnType}}</td></tr>
    <tr><th>Priority</th><td>{{ .priorityLabel | default:'—' }} · Effort: {{ .remediationComplexityLabel | default:'—' }}</td></tr>
    <tr><th>Status</th><td>{{ .remediationStatusLabel }}</td></tr>
  </table>

  <h4>Description</h4>
  <div class="rich">{{@rich.description}}</div>

  {{#scope}}
  <h4>Affected assets</h4>
  <div class="rich">{{@rich.scope}}</div>
  {{/scope}}

  {{#poc}}
  <h4>Proof of concept</h4>
  <div class="rich">{{@rich.poc}}</div>
  {{/poc}}

  {{#observation}}
  <h4>Impact</h4>
  <div class="rich">{{@rich.observation}}</div>
  {{/observation}}

  <h4>Remediation</h4>
  <div class="rich">{{@rich.remediation}}</div>

  <h4>References</h4>
  <div class="rich">{{@rich.references}}</div>
</section>
{{/findings}}

<!-- ========================= CONCLUSION ========================= -->
<h2>Conclusion</h2>
<div class="rich">{{@sections.conclusion.rich.text}}</div>

</body>
</html>
`;

export default STARTER_HTML_TEMPLATE;
