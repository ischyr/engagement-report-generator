/**
 * One finished engagement, as data.
 *
 * Shared on purpose. `npm run smoke` renders a report from this to prove the pipeline
 * works, and the app renders a template against the *same* fixture when somebody presses
 * Test render — so a template tested in the app is tested against the data the suite
 * validates, and improving one improves the other.
 *
 * It is deliberately awkward: two CVSS versions in one engagement, a 4.0 vector next to a
 * 3.1 one, nested lists, a table, a code block, an inline screenshot, a finding with
 * empty optional fields, and custom fields. A template that survives this survives a real
 * engagement.
 */

// The detection block is derived rather than written out, so it cannot contradict itself.
import { detectionReport } from '../services/detection.service.js';
import { campaignSummary } from '../services/phishing.service.js';
import { outcomeOf } from '../models/phishing-target.model.js';
import { formatDate } from '../services/template-parser.js';

// 1x1 red PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAACNMs+9AAAAFUlEQVR42mP8z8Dwn4GBgYGJgYGBAQAkBgMBWWM8+wAAAABJRU5ErkJggg==';

const RICH = `
<h3>Reproduction</h3>
<p>The endpoint <code>/api/report?id=1</code> concatenates the <strong>id</strong> parameter
straight into the query. A single quote is enough to <em>break out</em> of the literal.</p>
<ol>
  <li>Authenticate as any low-privileged user.
    <ul><li>Nested bullet, level two.</li><li>Another one.</li></ul>
  </li>
  <li>Request <code>/api/report?id=1'</code> and observe the SQL error.</li>
  <li>Extract the schema with a UNION payload.</li>
</ol>
<blockquote>Errors are returned verbatim to the client, which makes exploitation trivial.</blockquote>
<pre><code>GET /api/report?id=1' UNION SELECT NULL,version()-- HTTP/1.1
Host: target.example.com</code></pre>
<table>
  <thead><tr><th>Parameter</th><th>Injectable</th><th>Technique</th></tr></thead>
  <tbody>
    <tr><td>id</td><td>Yes</td><td>UNION, error-based</td></tr>
    <tr><td>sort</td><td>Yes</td><td>Boolean blind</td></tr>
  </tbody>
</table>
<p>Screenshot: <img src="data:image/png;base64,${PNG}" width="240" height="120" alt="sqlmap output"/></p>
<p>See <a href="https://owasp.org/Top10/A03_2021-Injection/">OWASP A03:2021</a> and
<a href="https://cwe.mitre.org/data/definitions/89.html">CWE-89</a>.</p>
<p style="text-align:center">Centred caption line with <mark>highlighted</mark> text,
<sup>super</sup>, <sub>sub</sub> and <s>struck</s> runs.</p>
`;

export const sampleAudit = {
  name: 'Acme Web Platform Assessment',
  reference: 'PT-2026-014',
  auditType: 'Web Application Penetration Test',
  language: 'en',
  state: 'REVIEW',
  date: '2026-08-01',
  date_start: '2026-07-20',
  date_end: '2026-07-31',
  sortFindings: true,
  company: { name: 'Acme Industries S.R.L.', shortName: 'Acme', address: '12 Calea Victoriei, Bucharest', website: 'https://acme.example' },
  client: { firstname: 'Elena', lastname: 'Marin', email: 'elena.marin@acme.example', phone: '+40 21 555 0100', title: 'CISO' },
  /*
   * A distribution list with two roles on it, so a Test render proves both the `recipients`
   * loop and the `signatories` one — a template that only ever sees one role would pass its
   * test and print an empty acceptance block for a real engagement.
   */
  /*
   * Two of the three carry a phone number, and the third does not on purpose: a template that
   * prints `{{#phone}} — {{ phone }}{{/phone}}` has to be seen doing both. With no number
   * anywhere on the list, a Test render could only report the tag as empty, which reads as a
   * misspelling of a field that was in fact written correctly.
   */
  recipients: [
    { _id: 'c1', firstname: 'Elena', lastname: 'Marin', email: 'elena.marin@acme.example', title: 'CISO', phone: '+40 21 555 0100' },
    { _id: 'c2', firstname: 'Radu', lastname: 'Ionescu', email: 'radu.ionescu@acme.example', title: 'Head of Engineering', phone: '+40 21 555 0118' },
    { _id: 'c3', firstname: 'Ana', lastname: 'Dobre', email: 'ana.dobre@acme.example', title: 'Procurement' },
  ],
  recipientRoles: [
    { client: 'c1', role: 'signatory' },
    { client: 'c2', role: 'technical' },
    { client: 'c3', role: 'cc' },
  ],
  creator: { username: 'ischifirnet', firstname: 'Iulian', lastname: 'Schifirnet', email: 'iulian@engy.example', title: 'Lead Penetration Tester' },
  collaborators: [
    { username: 'ischifirnet', firstname: 'Iulian', lastname: 'Schifirnet', email: 'iulian@engy.example', title: 'Lead Penetration Tester' },
    { username: 'aion', firstname: 'Andrei', lastname: 'Ion', email: 'andrei@engy.example', title: 'Security Consultant' },
  ],
  reviewers: [{ username: 'qa', firstname: 'Maria', lastname: 'Pop', email: 'maria@engy.example', title: 'QA Reviewer' }],
  approvals: [],
  customFields: [{ key: 'classification', label: 'Classification', value: 'CONFIDENTIAL' }],
  scope: [
    {
      name: 'Production web tier',
      hosts: [
        { hostname: 'www.acme.example', ip: '203.0.113.10', os: 'Ubuntu 22.04', services: [{ port: 443, protocol: 'tcp', name: 'https', product: 'nginx 1.24' }] },
        { hostname: 'api.acme.example', ip: '203.0.113.11', os: 'Ubuntu 22.04', services: [{ port: 443, protocol: 'tcp', name: 'https', product: 'nginx 1.24' }] },
      ],
    },
  ],
  /*
   * Three test checks, because the tag catalogue is checked against this fixture and an
   * engagement with none left `testChecks`, `checkGroups` and everything inside them unexercised
   * — which is how `blockedReason` came to be produced by the app and documented nowhere.
   *
   * One of each state on purpose: verified, not tested, and blocked with a reason. "We did not
   * get to it" and "the client never opened the firewall" are different sentences, and a fixture
   * that only has the first cannot catch a template that conflates them.
   */
  testChecks: [
    {
      title: 'Authentication: password policy',
      description: 'Minimum length, complexity and lockout.',
      category: 'Authentication',
      done: true,
      doneAt: '2026-07-22',
      order: 1,
    },
    {
      title: 'Authentication: session fixation',
      description: 'Session identifier rotates on login.',
      category: 'Authentication',
      done: false,
      order: 2,
    },
    {
      title: 'Network: internal segmentation',
      description: 'Reachability between the DMZ and the database tier.',
      category: 'Network',
      done: false,
      blocked: true,
      blockedReason: 'The client never opened the jump host, so the internal tier was unreachable.',
      order: 3,
    },
  ],
  sections: [
    { field: 'executive_summary', name: 'Executive Summary', text: '<p>The Acme web platform was assessed between 20 and 31 July 2026.</p><h3>Key outcomes</h3><ul><li>One <strong>critical</strong> SQL injection allowing full database access.</li><li>Two medium-severity access-control weaknesses.</li></ul><p>The critical issue should be remediated <strong>before the next release</strong>.</p>', customFields: [] },
    { field: 'scope_and_approach', name: 'Scope and Approach', text: '<p>Grey-box testing against two production hostnames, with a low-privileged account supplied by Acme.</p>', customFields: [] },
    { field: 'methodology', name: 'Methodology', text: '<p>Testing followed the OWASP Web Security Testing Guide v4.2.</p><ol><li>Reconnaissance</li><li>Mapping</li><li>Exploitation</li><li>Reporting</li></ol>', customFields: [] },
    { field: 'risk_rating', name: 'Risk Rating Methodology', text: '<p>Severities are derived from CVSS v3.1 base scores.</p>', customFields: [] },
    { field: 'conclusion', name: 'Conclusion', text: '<p>The platform is reasonably hardened apart from the injection flaw.</p>', customFields: [] },
    { field: 'appendix', name: 'Appendix', text: '<p>Tooling: Burp Suite Professional, sqlmap, nmap.</p>', customFields: [] },
  ],
  /*
   * Enumeration, as a red team would record it.
   *
   * On the fixture rather than only on red team engagements on purpose: the report data exposes
   * the loop for every kind, so a template that prints it must be testable here.
   *
   * A tree, because that is how the work is actually organised — "Subdomain Enumeration" is a
   * heading, and the tools under it are the things that were run. It is awkward on purpose, in
   * the same way as the rest of this fixture: a heading with nothing of its own, a tool that came
   * back empty, a step with output and no write-up, one with a write-up and no output, and one
   * that turned into a finding.
   */
  enumeration: [
    {
      _id: 'e1',
      title: 'Subdomain Enumeration',
      phase: 'recon',
      order: 1,
      summary:
        'Establishing the name surface: every subdomain reachable from public sources, then which of them actually answer.',
      /* No tool, no output, no write-up, and children — so `isGroup` is true. */
      output: '',
      content: '',
    },
    {
      _id: 'e1a',
      parent: 'e1',
      title: 'ProjectDiscovery — subfinder',
      tool: 'subfinder',
      status: 'completed',
      target: 'acme.example',
      command: 'subfinder -d acme.example -silent',
      ranAt: '21 July 2026, 09:02',
      phase: 'recon',
      order: 1,
      output: ['www.acme.example', 'api.acme.example', 'staging.acme.example', 'old.acme.example', 'vault.acme.example'].join('\n'),
      content: '',
    },
    {
      _id: 'e1b',
      parent: 'e1',
      title: 'crt.sh — certificate transparency',
      tool: 'crt.sh',
      status: 'completed',
      /*
       * Held back. The wildcard is worth knowing internally and not worth printing, and this is
       * what proves the report drops the row *and* renumbers what is left without leaving a gap.
       */
      internal: true,
      target: 'acme.example',
      ranAt: '21 July 2026, 09:06',
      phase: 'recon',
      order: 2,
      output: ['vpn.acme.example', 'mail.acme.example', '*.acme.example'].join('\n'),
      content: '<p>The wildcard is the one worth noting: it means a name we have not guessed still resolves.</p>',
    },
    {
      _id: 'e1c',
      parent: 'e1',
      title: 'amass — N/A',
      tool: 'amass',
      /* Ran, answered nothing, and said so — the reason `status` exists as a field. */
      status: 'timeout',
      target: 'acme.example',
      phase: 'recon',
      order: 3,
      /* Nothing came back. Recorded anyway, because "we tried and it found nothing" is a result. */
      output: '',
      content: '<p>Timed out against the resolver Acme supplied. Not re-run; subfinder had already covered it.</p>',
    },
    {
      _id: 'e1d',
      parent: 'e1',
      title: 'HTTPx — server validation',
      tool: 'httpx',
      /* Its output is in httpx's bracket grammar, so the table parser reads it into four columns. */
      status: 'completed',
      /* Printed as an extract, so `outputTruncated` and the "more lines" marker are exercised. */
      printOutput: 'head',
      printLines: 3,
      target: '6 hostnames',
      command: 'httpx -l hosts.txt -sc -title -tech-detect',
      ranAt: '21 July 2026, 09:14',
      phase: 'recon',
      order: 4,
      output: [
        'https://www.acme.example      [200] [Acme — Home] [nginx:1.24.0,React]',
        'https://api.acme.example      [401] [] [nginx:1.24.0]',
        'https://staging.acme.example  [200] [Acme staging] [nginx:1.24.0,React]',
        'https://vpn.acme.example      [200] [Fortinet]  [FortiGate]',
        'https://old.acme.example      [301] [] [Apache:2.4.29]',
      ].join('\n'),
      content:
        '<p>Five of six answer. <code>staging.acme.example</code> was not in the supplied scope' +
        ' document and was raised with Acme before it was touched.</p>' +
        /*
         * A screenshot pasted into a step's write-up, with nobody captioning it — which is what an
         * enumeration tab looks like after a real day's work. It is here so the sample document
         * proves that these are numbered alongside the findings' own evidence rather than being a
         * second, unnumbered class of picture.
         */
        `<p><img src="data:image/png;base64,${PNG}" width="260" height="90" alt="httpx output"/></p>`,
    },
    {
      _id: 'e2',
      title: 'WebServer Enumeration',
      phase: 'access',
      order: 2,
      status: 'completed',
      tool: 'Burp Suite Professional',
      target: 'old.acme.example',
      ranAt: '21 July 2026, 11:02',
      /* No output at all — the point of `{{#hasOutput}}`. */
      output: '',
      /* Written up, so `hasLedTo` and the finding's `discoveredBy` are both exercised. */
      ledTo: ['f2'],
      content:
        '<p>The redirect on <code>old.acme.example</code> is served by a much older Apache than the' +
        ' rest of the estate, and answers to a <code>TRACE</code>:</p>' +
        `<pre><code>TRACE / HTTP/1.1\nHost: old.acme.example\n\nHTTP/1.1 200 OK\nServer: Apache/2.4.29 (Ubuntu)\nContent-Type: message/http</code></pre>` +
        `<p><img src="data:image/png;base64,${PNG}" width="280" height="100" alt="the response in Burp"/></p>` +
        '<figure><img src="data:image/png;base64,' +
        PNG +
        '" width="200" height="90"/><figcaption>Server header on the legacy host</figcaption></figure>',
    },
  ],
  findings: [
    {
      title: 'SQL Injection in the reporting endpoint',
      vulnType: 'Web Application',
      category: 'Injection',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H/E:F/RL:O/RC:C',
      priority: 4,
      remediationComplexity: 2,
      description: RICH,
      observation: '<p>Full read/write access to the application database, including password hashes.</p>',
      remediation: '<p>Use parameterised queries.</p><ul><li>Never concatenate input into SQL.</li><li>Reduce the database user privileges.</li></ul>',
      poc: `<p>sqlmap confirmed the injection:</p><pre><code>sqlmap -u "https://api.acme.example/report?id=1" --batch --dbs</code></pre><p><img src="data:image/png;base64,${PNG}" width="320" height="80" alt="dbs output"/></p>`,
      scope: '<ul><li>api.acme.example — <code>/api/report</code></li></ul>',
      references: ['https://owasp.org/Top10/A03_2021-Injection/', 'https://cwe.mitre.org/data/definitions/89.html'],
      customFields: [{ key: 'cwe', label: 'CWE', value: 'CWE-89' }, { key: 'environment', label: 'Environment', value: 'Production' }],
      sortIndex: 0,
    },
    {
      /* Given an id so an enumeration step can point at it — see `ledTo` above. */
      _id: 'f2',
      title: 'Insecure Direct Object Reference on invoices',
      vulnType: 'Web Application',
      category: 'Authorization',
      // Deliberately a v4.0 vector: reports must render both versions side by
      // side in one engagement, because a retest keeps whatever the original used.
      cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N/E:P/CR:H',
      priority: 3,
      remediationComplexity: 2,
      description: '<p>Invoice identifiers are sequential and unchecked.</p>',
      observation: '<p>Any user can read every invoice.</p>',
      remediation: '<p>Verify ownership server-side.</p>',
      poc: '',
      scope: '',
      references: ['https://owasp.org/Top10/A01_2021-Broken_Access_Control/'],
      customFields: [{ key: 'cwe', label: 'CWE', value: 'CWE-639' }],
      sortIndex: 1,
    },
    {
      title: 'Missing security headers',
      vulnType: 'Web Application',
      category: 'Configuration',
      cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N',
      priority: 1,
      remediationComplexity: 1,
      description: '<p>No <code>Content-Security-Policy</code> is set.</p>',
      observation: '',
      remediation: '<p>Add the header at the reverse proxy.</p>',
      poc: '',
      scope: '',
      references: [],
      customFields: [],
      sortIndex: 2,
    },
  ],
};

/**
 * Two signatures, so a Test render proves the sign-off block renders as real images.
 *
 * Shaped exactly like `signaturesFor()` returns, including the ready-made `html` — a fixture
 * that only carried the loop would let a template pass its test with `{{@rich.signatures}}`
 * printing nothing at all.
 */
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAB4AAAAKCAYAAABWCXfoAAAAKUlEQVR42mNgQAP/GfAAJgYCYFTBqIJRBaMKRhWMKhhVMKpgVMHwUQAAmB0FAY6q3ycAAAAASUVORK5CYII=';

export const sampleSignatures = {
  recorded: true,
  signatures: [
    {
      name: 'Iulian Schifirnet',
      title: 'Lead Penetration Tester',
      role: 'Tested by',
      statement: 'I confirm the testing described in this report was carried out as stated.',
      date: '01 August 2026',
      signedOn: '2026-08-01',
      image: SIGNATURE_PNG,
    },
    {
      name: 'Maria Pop',
      title: 'QA Reviewer',
      role: 'Reviewed by',
      statement: '',
      date: '02 August 2026',
      signedOn: '2026-08-02',
      image: SIGNATURE_PNG,
    },
  ],
  get html() {
    return this.signatures
      .map(
        (entry) =>
          `${entry.statement ? `<p>${entry.statement}</p>` : ''}` +
          `<p><img src="${entry.image}" alt="Signature of ${entry.name}" width="220"/></p>` +
          `<p><strong>${entry.name}</strong> — ${entry.title}</p>` +
          `<p>${[entry.role, entry.date].filter(Boolean).join(' · ')}</p>`
      )
      .join('');
  },
};

/**
 * Two scope changes, so a Test render proves the "what was agreed" table renders.
 *
 * Shaped exactly like `scopeChangesFor()` returns, dates already formatted — a fixture holding
 * raw days would let a template pass its test and print an ISO string for a client.
 */
export const sampleScopeChanges = {
  recorded: true,
  counts: { added: 1, removed: 1, clarified: 0, total: 2 },
  scopeChanges: [
    {
      kind: 'added',
      kindLabel: 'Added to scope',
      date: '22 July 2026',
      agreedOn: '2026-07-22',
      summary: 'The staging API host was brought into scope for the remainder of the window.',
      targets: ['api-staging.acme.example'],
      targetList: 'api-staging.acme.example',
      agreedBy: 'Elena Marin',
      channel: 'Email',
      note: '',
    },
    {
      kind: 'removed',
      kindLabel: 'Taken out of scope',
      date: '24 July 2026',
      agreedOn: '2026-07-24',
      summary: 'Payment flows were excluded — the sandbox was unavailable for the whole window.',
      targets: ['pay.acme.example'],
      targetList: 'pay.acme.example',
      agreedBy: 'Elena Marin',
      channel: 'Call',
      note: 'To be covered by a separate engagement.',
    },
  ],
};

/**
 * Four logged actions, so a Test render proves the detection timeline and its figures resolve.
 *
 * Built by running the real `detectionReport()` over raw rows rather than written out by hand:
 * the summary has to be derived from these exact events, and a fixture whose stated detection
 * rate disagreed with its own timeline is the one thing this block must never be. The dates are
 * formatted with the same pattern the fixture uses elsewhere, plus the clock — a detection log
 * without minutes cannot demonstrate the tags that measure minutes.
 *
 * One deliberately loud action nobody answered, one they blocked, one logged and ignored, one
 * still unconfirmed: the four outcomes a template needs to render to be worth trusting.
 */
const SAMPLE_DETECTION_ROWS = [
  {
    action: 'Password spray against the VPN portal — 400 attempts across 90 accounts.',
    target: 'vpn.acme.example',
    technique: 'T1110.003 — Password spraying',
    occurredAt: new Date('2026-03-03T09:12:00.000Z'),
    outcome: 'not-detected',
    noise: 'loud',
    detectedAt: null,
    respondedAt: null,
    source: 'Confirmed on the closeout call',
    notes: 'No lockouts, no alerts, nothing in the ticket queue.',
  },
  {
    action: 'Kerberoast against three service accounts.',
    target: 'DC01.acme.internal',
    technique: 'T1558.003 — Kerberoasting',
    occurredAt: new Date('2026-03-04T11:40:00.000Z'),
    outcome: 'logged',
    noise: 'standard',
    detectedAt: new Date('2026-03-04T11:44:00.000Z'),
    respondedAt: null,
    source: 'Found in their SIEM during the debrief',
    notes: 'The events were there four minutes later. Nobody was watching that dashboard.',
  },
  {
    action: 'Dumped LSASS on a workstation.',
    target: 'WS-014',
    technique: 'T1003.001 — LSASS memory',
    occurredAt: new Date('2026-03-05T14:05:00.000Z'),
    outcome: 'blocked',
    noise: 'loud',
    detectedAt: new Date('2026-03-05T14:05:00.000Z'),
    respondedAt: new Date('2026-03-05T14:31:00.000Z'),
    source: 'EDR console, then their SOC called',
    notes: 'Blocked outright and the host was isolated inside half an hour.',
  },
  {
    action: 'Exfiltrated 40 MB of test data over HTTPS to a controlled host.',
    target: 'files.acme.example',
    technique: 'T1048 — Exfiltration over an alternative protocol',
    occurredAt: new Date('2026-03-06T16:20:00.000Z'),
    outcome: 'unknown',
    noise: 'quiet',
    detectedAt: null,
    respondedAt: null,
    source: '',
    notes: 'Still to be checked against their proxy logs.',
  },
];

/**
 * A small phishing campaign, so a Test render proves the campaign tags and their figures resolve.
 *
 * Built by running the real `campaignSummary()` over these rows rather than written out by hand:
 * every rate and timing has to be derived from the same people the list prints, and a fixture
 * whose stated click rate disagreed with its own list is the one thing this block must never be.
 *
 * Five people covering every outcome the report can name — phished, clicked but stopped, reported
 * it, opened and did nothing, and one the mail never reached — plus a departmental split, because
 * that is the table most reports should print instead of names.
 */
const SAMPLE_PHISHING_ROWS = [
  {
    email: 'dana.whitfield@acme.example',
    name: 'Dana Whitfield',
    department: 'Finance',
    title: 'Accounts Payable',
    wave: 'Wave 1',
    sent: true,
    opened: true,
    clicked: true,
    phished: true,
    reported: false,
    sentAt: new Date('2026-03-04T09:00:00.000Z'),
    clickedAt: new Date('2026-03-04T09:06:00.000Z'),
    phishedAt: new Date('2026-03-04T09:08:00.000Z'),
  },
  {
    email: 'marcus.ellery@acme.example',
    name: 'Marcus Ellery',
    department: 'Finance',
    wave: 'Wave 1',
    sent: true,
    opened: true,
    clicked: true,
    phished: false,
    reported: false,
    sentAt: new Date('2026-03-04T09:00:00.000Z'),
    clickedAt: new Date('2026-03-04T09:41:00.000Z'),
  },
  {
    email: 'priya.raman@acme.example',
    name: 'Priya Raman',
    department: 'IT',
    wave: 'Wave 1',
    sent: true,
    opened: true,
    clicked: false,
    phished: false,
    reported: true,
    sentAt: new Date('2026-03-04T09:00:00.000Z'),
    reportedAt: new Date('2026-03-04T09:04:00.000Z'),
  },
  {
    email: 'sam.doyle@acme.example',
    name: 'Sam Doyle',
    department: 'Operations',
    wave: 'Wave 2',
    sent: true,
    opened: true,
    clicked: false,
    phished: false,
    reported: false,
    sentAt: new Date('2026-03-04T09:00:00.000Z'),
  },
  {
    email: 'left.thecompany@acme.example',
    name: 'Alex Kerr',
    department: 'Operations',
    wave: 'Wave 2',
    // Never reached, so every rate below is out of four rather than five.
    sent: false,
  },
];

export const samplePhishing = {
  recorded: true,
  targets: SAMPLE_PHISHING_ROWS.map((row) => ({
    ...row,
    outcome: outcomeOf(row),
    sentAt: row.sentAt ? formatDate(row.sentAt, 'd MMMM yyyy HH:mm') : '',
    clickedAt: row.clickedAt ? formatDate(row.clickedAt, 'd MMMM yyyy HH:mm') : '',
    phishedAt: row.phishedAt ? formatDate(row.phishedAt, 'd MMMM yyyy HH:mm') : '',
    reportedAt: row.reportedAt ? formatDate(row.reportedAt, 'd MMMM yyyy HH:mm') : '',
    name: row.name ?? '',
    department: row.department ?? '',
    title: row.title ?? '',
    wave: row.wave ?? '',
    note: '',
  })),
  phishedTargets: SAMPLE_PHISHING_ROWS.filter((row) => row.phished).map((row) => ({
    ...row,
    outcome: 'phished',
  })),
  summary: campaignSummary(SAMPLE_PHISHING_ROWS),
};

export const sampleDetection = detectionReport(SAMPLE_DETECTION_ROWS, (value) =>
  formatDate(value, 'd MMMM yyyy HH:mm')
);

/**
 * Hours against the fixture, so a Test render proves the effort tags resolve.
 *
 * Shaped exactly like `effortFor()` returns — including the two-decimal rounding — because
 * a fixture that is *nearly* the real thing is how a template passes its test and fails on
 * a real engagement. Two people, one of them part-time on it, which is the ordinary case.
 */
export const sampleEffort = {
  hours: 52,
  days: 6.5,
  hoursPerDay: 8,
  recorded: true,
  entries: 9,
  people: [
    { name: 'Alex Turner', title: 'Senior Security Consultant', hours: 38, days: 6, effortDays: 4.75 },
    { name: 'Priya Nair', title: 'Security Consultant', hours: 14, days: 3, effortDays: 1.75 },
  ],
  firstDay: '2026-03-02',
  lastDay: '2026-03-11',
};

/**
 * Two deliveries, so a Test render proves a document-control table renders.
 *
 * Shaped exactly like `deliveriesFor()` returns, dates included as already-formatted
 * strings — the service formats them with the instance's pattern, and a fixture holding raw
 * dates would let a template pass its test and print "Mon Mar 09 2026" for a client.
 */
export const sampleDeliveries = {
  recorded: true,
  deliveries: [
    {
      version: '1.0',
      date: '09 March 2026',
      sentAt: '2026-03-09T16:20:00.000Z',
      channel: 'email',
      recipients: [{ name: 'Dana Whitfield', email: 'dana.whitfield@example.com' }],
      recipientList: 'Dana Whitfield',
      filename: 'Example Corp — Web Application Assessment v1.0.docx',
      fileHash: '5f2b8c1d9e4a7063b1c8d5e2f9a0b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4',
      fileHashShort: '5f2b8c1d9e4a',
      hashAlgorithm: 'sha256',
      note: 'Draft for technical review',
    },
    {
      version: '1.1',
      date: '18 March 2026',
      sentAt: '2026-03-18T09:05:00.000Z',
      channel: 'portal',
      recipients: [
        { name: 'Dana Whitfield', email: 'dana.whitfield@example.com' },
        { name: '', email: 'security@example.com' },
      ],
      recipientList: 'Dana Whitfield, security@example.com',
      filename: 'Example Corp — Web Application Assessment v1.1.docx',
      fileHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b3c4d5e6f7081',
      fileHashShort: 'a1b2c3d4e5f6',
      note: 'Final, after the authentication finding was retested',
    },
  ],
  get lastDelivery() {
    return this.deliveries[this.deliveries.length - 1];
  },
};

/**
 * Only the report settings the fixture needs. A real render merges the instance's own
 * settings over these, so a Test render reflects the date format and finding prefix
 * actually configured rather than these placeholders.
 */
export const sampleReportSettings = {
  report: {
    public: {
      cvssColors: { noneColor: '4A86E8', lowColor: '008000', mediumColor: 'F9A009', highColor: 'FE6C00', criticalColor: 'D02D2D' },
      dateFormat: 'dd MMMM yyyy',
      findingIdPrefix: 'VULN-',
      captionStyle: 'Caption',
    },
    private: { imageBorder: true, imageBorderColor: 'CCCCCC' },
  },
};
