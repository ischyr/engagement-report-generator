/**
 * The content of the demo engagement, kept apart from the script that loads it.
 *
 * Written to look like real work rather than lorem ipsum: the findings are ones you
 * would actually report, with the impact spelled out in business terms and
 * remediation somebody could act on. That matters for a demo — a prospective client
 * reading "Test finding 1" learns nothing about the tool.
 */

export const DEMO_PREFIX = 'zz-demo';

export const DEMO_COMPANY = {
  name: 'Northwind Logistics',
  shortName: 'Northwind',
  address: '4 Quayside, Rotterdam, Netherlands',
  website: 'https://northwind-logistics.example',
};

export const DEMO_CONTACT = {
  firstname: 'Marijke',
  lastname: 'de Vries',
  email: 'marijke.devries@northwind-logistics.example',
  title: 'Head of IT',
  phone: '+31 10 555 0142',
};

/** Three demo accounts, so authorship, review and mentions all have real people. */
export const DEMO_USERS = [
  {
    username: `${DEMO_PREFIX}-lead`,
    firstname: 'Nadia',
    lastname: 'Okonjo',
    email: 'nadia.okonjo@demo.invalid',
    title: 'Lead Security Consultant',
    role: 'user',
  },
  {
    username: `${DEMO_PREFIX}-tester`,
    firstname: 'Tomás',
    lastname: 'Herrera',
    email: 'tomas.herrera@demo.invalid',
    title: 'Security Consultant',
    role: 'user',
  },
  {
    username: `${DEMO_PREFIX}-reviewer`,
    firstname: 'Grace',
    lastname: 'Bello',
    email: 'grace.bello@demo.invalid',
    title: 'Technical Director',
    // Deliberately not an admin. These accounts have a documented password, and
    // demo data should never leave a privileged one behind on a reachable
    // instance — reviewing and approving needs no admin rights anyway.
    role: 'user',
  },
];

export const DEMO_SCOPE = [
  {
    name: 'External perimeter',
    hosts: [
      {
        hostname: 'portal.northwind-logistics.example',
        ip: '203.0.113.24',
        os: 'Ubuntu 22.04',
        services: [
          { port: 443, protocol: 'tcp', name: 'https', product: 'nginx 1.24.0' },
          { port: 80, protocol: 'tcp', name: 'http', product: 'nginx 1.24.0' },
        ],
      },
      {
        hostname: 'api.northwind-logistics.example',
        ip: '203.0.113.25',
        os: 'Ubuntu 22.04',
        services: [{ port: 443, protocol: 'tcp', name: 'https', product: 'nginx 1.24.0' }],
      },
      {
        hostname: 'mail.northwind-logistics.example',
        ip: '203.0.113.26',
        os: 'Debian 12',
        services: [
          { port: 25, protocol: 'tcp', name: 'smtp', product: 'Postfix 3.7' },
          { port: 993, protocol: 'tcp', name: 'imaps', product: 'Dovecot' },
        ],
      },
    ],
  },
  {
    name: 'Staging (in scope by agreement)',
    hosts: [
      {
        hostname: 'staging.northwind-logistics.example',
        ip: '203.0.113.60',
        os: 'Ubuntu 22.04',
        services: [
          { port: 443, protocol: 'tcp', name: 'https', product: 'nginx 1.24.0' },
          { port: 8080, protocol: 'tcp', name: 'http-alt', product: 'Jetty 11' },
        ],
      },
    ],
  },
];

export const DEMO_SECTIONS = [
  {
    field: 'executive_summary',
    name: 'Executive summary',
    text: `<p>Northwind Logistics engaged us to assess the security of its customer shipment portal and the API behind it. Testing ran for five days against the production perimeter, with a staging host included by agreement so that destructive checks could be carried out safely.</p>
<p>The portal is in reasonable shape. Authentication is sound, the platform is patched, and the team's use of a managed database removes a whole class of problem. Two issues, however, would let an attacker read data belonging to other customers, and one of those requires no account at all. Both stem from the same root cause: authorisation decided by the identifier in the request rather than by the session making it.</p>
<p>We rated one issue <strong>critical</strong> and one <strong>high</strong>. Neither is difficult to fix — both are a server-side ownership check — and we would expect a developer familiar with the codebase to close them within a day. The remaining findings are hardening items that reduce the value of a future foothold rather than open one now.</p>
<p>Northwind's staff were responsive throughout, and a staging environment that mirrored production made verification straightforward. We would recommend a retest of the two authorisation findings once fixed, and a follow-up assessment of the internal network, which was out of scope here.</p>`,
  },
  {
    field: 'scope_and_approach',
    name: 'Scope and approach',
    text: `<p>The assessment covered the shipment portal, its JSON API, and the mail perimeter, as listed in the scope table. Testing was performed from the internet as an unauthenticated user, and then as two authenticated customers on separate accounts — the second account being what made the data-access issues visible.</p>
<p>Work followed our standard web application methodology, itself shaped by the OWASP Web Security Testing Guide. Every item on that checklist is listed in this report with its outcome, so the ground covered is visible and not only the issues found.</p>
<p><strong>Out of scope:</strong> the internal corporate network, staff endpoints, physical security, and social engineering. Denial-of-service testing was explicitly excluded. The staging host was used for checks that risked writing data.</p>`,
  },
  {
    field: 'methodology',
    name: 'Methodology',
    text: `<p>Testing was manual, supported by tooling for coverage rather than for findings. Reconnaissance established the technology stack and the application's entry points; from there each area — configuration, authentication, session handling, authorisation, input validation and business logic — was worked through in turn.</p>
<p>Findings were verified by reproducing them at least twice, and where a proof of concept could affect data it was carried out on staging. Each finding was scored with CVSS, and the vector is printed alongside it so the reasoning behind the rating is open to challenge.</p>`,
  },
  {
    field: 'risk_rating',
    name: 'Risk rating methodology',
    text: `<p>Severities are derived from CVSS base scores: 9.0–10.0 critical, 7.0–8.9 high, 4.0–6.9 medium, 0.1–3.9 low, and 0.0 informational. The base score describes the flaw itself, independent of Northwind's environment.</p>
<p>Where a score understates or overstates the real risk to Northwind, we say so in the finding rather than adjusting the number silently. Remediation priority is a separate judgement and considers effort as well as severity.</p>`,
  },
  {
    field: 'conclusion',
    name: 'Conclusion',
    text: `<p>The portal's foundations are sound; the problems we found are specific and fixable. Both data-access issues share one root cause, so a single change in how the application authorises requests closes them together and prevents the pattern recurring.</p>
<p>Once the two authorisation findings are fixed we would be glad to retest and reissue this report with them confirmed closed. The internal network remains untested and would be the natural next step.</p>`,
  },
];

/**
 * Findings, worst first. `evidence` names the screenshots the loader generates and
 * stores, and the placeholder is replaced with the real reference once uploaded.
 */
export const DEMO_FINDINGS = [
  {
    title: 'Shipment documents readable without authentication',
    vulnType: 'Web Application',
    category: 'Authorization',
    cvssv3: 'CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N/E:P',
    priority: 4,
    remediationComplexity: 1,
    remediationStatus: 'open',
    author: 0,
    cwe: 'CWE-639',
    owasp: 'A01:2021 – Broken Access Control',
    scope: '<p><code>portal.northwind-logistics.example</code> — <code>/documents/{id}/download</code></p>',
    description: `<p>The document download endpoint returns a shipment's paperwork to anyone who requests it. No session cookie, bearer token or signed parameter is required: the identifier in the URL is the only thing that decides what comes back.</p>
<p>Identifiers are sequential integers, so the whole archive can be walked from a single starting point. We confirmed the issue on 20 consecutive identifiers and stopped there deliberately; nothing in the application's behaviour suggests the range is bounded.</p>`,
    observation: `<p>Shipment paperwork contains the consignor and consignee, their addresses, declared contents and commercial value. Read across the identifier range this is a bulk export of Northwind's customer base and its clients' trading relationships — commercially sensitive to them and, because it includes named individuals at delivery addresses, personal data under the GDPR.</p>
<p>Exploitation needs no account, no phishing and no privileged position. A single script and an afternoon is the whole attack.</p>`,
    remediation: `<p>Require an authenticated session on the endpoint, and authorise the request against that session rather than against the identifier: load the document, then confirm the signed-in customer owns it before returning any bytes.</p>
<p>As defence in depth, replace sequential integers with unguessable identifiers (UUIDv4). That alone does not fix the flaw — obscurity is not authorisation — but it removes the ability to enumerate should a check be missed again in future.</p>
<p>We would also recommend an access-control test in the CI suite that asserts one customer cannot fetch another's document, so a regression fails the build rather than the next assessment.</p>`,
    poc: `<p>Requesting a document identifier belonging to another customer, with no credentials of any kind:</p>
<pre><code>$ curl -s -o waybill.pdf -w '%{http_code} %{content_type} %{size_download}\\n' \\
    https://portal.northwind-logistics.example/documents/48120/download
200 application/pdf 184320</code></pre>
<p>The response is the shipment's waybill:</p>
<p>{{evidence:waybill}}</p>
<p>Walking the identifier range returns a different customer's paperwork each time:</p>
<pre><code>$ for id in $(seq 48115 48134); do
    code=$(curl -s -o "/tmp/$id.pdf" -w '%{http_code}' \\
      "https://portal.northwind-logistics.example/documents/$id/download")
    echo "$id -> $code $(stat -c%s "/tmp/$id.pdf") bytes"
  done
48115 -> 200 179244 bytes
48116 -> 200 181903 bytes
48117 -> 200 176618 bytes
[...]
48134 -> 200 188410 bytes</code></pre>
<p>{{evidence:enumeration}}</p>`,
    references: [
      'https://owasp.org/Top10/A01_2021-Broken_Access_Control/',
      'https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html',
      'https://cwe.mitre.org/data/definitions/639.html',
    ],
    comments: [
      {
        author: 2,
        body: 'Did we establish an upper bound on the identifier range? If the archive really is unbounded I would like the executive summary to say so explicitly rather than implying it.',
      },
      {
        author: 0,
        body: 'We stopped at 20 on purpose — enumerating the lot would have meant downloading other customers\' data at volume, which is past what the engagement authorised. I will word it as "no evidence of a bound" so we are not claiming more than we tested.',
      },
    ],
  },
  {
    title: 'A customer can read another customer’s invoices',
    vulnType: 'Web Application',
    category: 'Authorization',
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
    priority: 3,
    remediationComplexity: 1,
    remediationStatus: 'retesting',
    author: 1,
    cwe: 'CWE-639',
    owasp: 'A01:2021 – Broken Access Control',
    scope: '<p><code>api.northwind-logistics.example</code> — <code>GET /v2/invoices/{id}</code></p>',
    description: `<p>The invoice endpoint checks that the caller is signed in, but not that the invoice belongs to them. Any authenticated customer can substitute another customer's invoice identifier and receive the full record.</p>
<p>This is the same root cause as the document finding, in a place where the authentication check succeeded and therefore looked correct. It is worth treating them as one problem with two symptoms.</p>`,
    observation: `<p>Invoices carry billing addresses, line items, negotiated rates and payment status. Rates in particular are commercially sensitive: a competitor holding a Northwind account could read what other customers pay.</p>
<p>The barrier is a free customer account, so the population able to exploit this is everyone Northwind does business with, plus anyone who can sign up.</p>`,
    remediation: `<p>Scope the query to the session's customer instead of filtering after the fact — <code>WHERE id = ? AND customer_id = ?</code> — so an invoice belonging to somebody else is simply not found. Return 404 rather than 403, which avoids confirming that an identifier exists.</p>
<p>Because this shares a root cause with the document finding, the durable fix is a single authorisation layer every record lookup passes through, rather than a check added to each endpoint by hand.</p>`,
    poc: `<p>Signed in as customer 8871, requesting an invoice belonging to customer 4402:</p>
<pre><code>$ curl -s -H "Authorization: Bearer $TOKEN_8871" \\
    https://api.northwind-logistics.example/v2/invoices/220914 | jq '{id, customer_id, total, billing_name}'
{
  "id": 220914,
  "customer_id": 4402,
  "total": "18450.00",
  "billing_name": "Baltic Freight Handling BV"
}</code></pre>
<p>The <code>customer_id</code> in the response does not match the token used to request it:</p>
<p>{{evidence:invoice}}</p>`,
    references: [
      'https://owasp.org/Top10/A01_2021-Broken_Access_Control/',
      'https://cwe.mitre.org/data/definitions/639.html',
    ],
    comments: [
      {
        author: 0,
        body: 'Northwind pushed a fix to staging on Thursday and it looks right — scoped query, 404 on a foreign id. Moving this to retesting; @zz-demo-reviewer could you confirm before we reissue?',
        mentions: [2],
      },
    ],
  },
  {
    title: 'Session cookie missing the Secure and SameSite attributes',
    vulnType: 'Web Application',
    category: 'Configuration',
    cvssv3: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N',
    priority: 2,
    remediationComplexity: 1,
    remediationStatus: 'open',
    author: 1,
    cwe: 'CWE-1004',
    scope: '<p><code>portal.northwind-logistics.example</code></p>',
    description: `<p>The session cookie is set without <code>Secure</code> and without <code>SameSite</code>. HSTS is in place, which limits the first problem to a client that has never visited the site over HTTPS, and modern browsers default <code>SameSite</code> to <code>Lax</code>, which limits the second.</p>
<p>The finding therefore describes a weakened defence rather than a live route in — but both attributes are one line of configuration, and the protection they provide is exactly what stops a future flaw elsewhere from becoming account takeover.</p>`,
    observation: `<p>On its own this does not let an attacker in. Combined with a cross-site scripting flaw or a network position it lowers the effort required to ride a customer's session. We rated it low for that reason: real, worth fixing, not urgent.</p>`,
    remediation: `<p>Set <code>Secure</code>, <code>HttpOnly</code> and <code>SameSite=Lax</code> on the session cookie. <code>Strict</code> is preferable if the portal has no cross-site entry flows; test the login redirect before committing to it.</p>`,
    poc: `<pre><code>$ curl -sI https://portal.northwind-logistics.example/login | grep -i set-cookie
set-cookie: NWSESSION=eyJhbGciOi...; Path=/; HttpOnly</code></pre>
<p>Neither <code>Secure</code> nor <code>SameSite</code> is present.</p>`,
    references: [
      'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html',
    ],
  },
  {
    title: 'Stack traces returned to the client on error',
    vulnType: 'Web Application',
    category: 'Configuration',
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N',
    priority: 2,
    remediationComplexity: 1,
    remediationStatus: 'fixed',
    author: 0,
    cwe: 'CWE-209',
    scope: '<p><code>api.northwind-logistics.example</code> — several endpoints on malformed input</p>',
    description: `<p>Malformed input to the API produced an unhandled exception whose stack trace was returned in the response body, naming the framework and its version, internal file paths and the ORM in use.</p>
<p>Northwind corrected this during the engagement; we confirmed on the final day that errors now return a generic message with the detail logged server-side.</p>`,
    observation: `<p>The information helped us narrow which library versions were in play, which is exactly its value to an attacker: it shortens reconnaissance. No secrets were exposed.</p>`,
    remediation: `<p>Return a generic error with a correlation id and log the detail server-side. Ensure the framework's debug mode cannot be enabled in production — a deployment check is more reliable than remembering.</p>`,
    poc: `<pre><code>$ curl -s -X POST https://api.northwind-logistics.example/v2/shipments \\
    -H 'Content-Type: application/json' -d '{"weight": "not-a-number"}' | head -6
{"error":"Internal Server Error","trace":"TypeError: Cannot read properties of undefined
    at ShipmentService.calculateFreight (/srv/nw-api/src/services/shipment.js:212:31)
    at ShipmentController.create (/srv/nw-api/src/controllers/shipment.js:88:20)
    ..."}</code></pre>
<p>Retested on the final day, after Northwind's fix:</p>
<pre><code>$ curl -s -X POST https://api.northwind-logistics.example/v2/shipments \\
    -H 'Content-Type: application/json' -d '{"weight": "not-a-number"}'
{"error":"The request could not be processed","correlationId":"b41f8c2e"}</code></pre>`,
    references: ['https://cwe.mitre.org/data/definitions/209.html'],
  },
  {
    title: 'Mail perimeter accepts TLS 1.0',
    vulnType: 'Network',
    category: 'Cryptography',
    cvssv3: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:L/I:N/A:N',
    priority: 1,
    remediationComplexity: 1,
    remediationStatus: 'open',
    author: 1,
    scope: '<p><code>mail.northwind-logistics.example</code> — 25/tcp, 993/tcp</p>',
    description: `<p>The mail host negotiates TLS 1.0 and 1.1 in addition to 1.2 and 1.3. Both older versions are deprecated (RFC 8996) and carry known weaknesses in cipher construction.</p>`,
    observation: `<p>Exploitation requires a privileged network position and, in practice, a great deal of traffic. The realistic impact is compliance rather than compromise: PCI DSS and most customer security questionnaires now ask for TLS 1.2 as a minimum.</p>`,
    remediation: `<p>Disable TLS 1.0 and 1.1 on the submission and IMAPS listeners. Check mail logs for legacy clients before doing so — an old scanner or MFP is the usual thing that breaks.</p>`,
    poc: `<pre><code>$ openssl s_client -connect mail.northwind-logistics.example:993 -tls1 2>/dev/null | grep -E 'Protocol|Cipher'
    Protocol  : TLSv1.0
    Cipher    : AES256-SHA</code></pre>`,
    references: ['https://datatracker.ietf.org/doc/rfc8996/'],
  },
  {
    title: 'Staging host indexed by search engines',
    vulnType: 'Web Application',
    category: 'Configuration',
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N',
    priority: 1,
    remediationComplexity: 1,
    remediationStatus: 'open',
    author: 0,
    scope: '<p><code>staging.northwind-logistics.example</code></p>',
    description: `<p>The staging host is reachable from the internet and serves no <code>robots.txt</code>, and pages from it appear in search results. The data on it is synthetic, so this is informational — we raise it because staging environments tend to accumulate real data over time, and this one would then be exposed without anybody deciding to expose it.</p>`,
    observation: `<p>No sensitive data was present. The risk is future: the next copy of production data onto this host becomes publicly indexable.</p>`,
    remediation: `<p>Put staging behind IP allow-listing or authentication, and serve <code>X-Robots-Tag: noindex</code>. Treat "is this host public?" as part of the checklist when refreshing staging data.</p>`,
    poc: `<pre><code>$ curl -sI https://staging.northwind-logistics.example/robots.txt | head -1
HTTP/2 404</code></pre>`,
    references: [],
  },
];

/** Which shipped checklists the demo engagement is set up with. */
export const DEMO_CHECKLIST_SLUGS = ['web', 'reporting'];

/**
 * Checks that get ticked, by the wording used in the shipped checklists.
 *
 * A partially-worked checklist is what a real engagement looks like mid-flight, and
 * it makes the coverage numbers on Insights and in the report meaningful.
 */
export const DEMO_TICKED = [
  ['Fingerprint web server, framework and versions', 1],
  ['Review robots.txt, sitemaps and exposed metadata files', 1],
  ['Enumerate application entry points and hidden endpoints', 0],
  ['Check for exposed source control, backups and archives', 1],
  ['Review HTTP security headers', 1],
  ['Check TLS versions, cipher suites and certificate validity', 1],
  ['Test for verbose errors and stack traces', 0],
  ['Review cookie flags (HttpOnly, Secure, SameSite)', 1],
  ['Test for username enumeration', 0],
  ['Check password policy and lockout behaviour', 0],
  ['Test horizontal privilege escalation between accounts', 0],
  ['Test vertical privilege escalation to admin functions', 0],
  ['Test for insecure direct object references', 0],
  ['Test for SQL injection on every parameter', 1],
  ['Test for cross-site scripting (reflected, stored, DOM)', 1],
  ['Spelling and grammar pass', 2],
  ['Scope and dates match the statement of work', 2],
];

export const DEMO_ENGAGEMENT = {
  name: 'Northwind Logistics — Shipment Portal Assessment',
  reference: 'PT-2026-041',
  auditType: 'Web Application Penetration Test',
  language: 'en',
  date: '2026-07-31',
  date_start: '2026-07-20',
  date_end: '2026-07-24',
  state: 'REVIEW',
};
