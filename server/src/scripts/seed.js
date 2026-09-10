/**
 * Bootstraps a usable database: an admin account, the reference taxonomies and
 * a handful of library vulnerabilities. Safe to run repeatedly — every step is
 * an upsert.
 *
 *   npm run seed
 */

import env from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { log } from '../utils/logger.js';
import { User } from '../models/user.model.js';
import { Company } from '../models/company.model.js';
import { Settings } from '../models/settings.model.js';
import { CustomField } from '../models/custom-field.model.js';
import {
  Language,
  AuditType,
  VulnerabilityType,
  VulnerabilityCategory,
  SectionDefinition,
} from '../models/taxonomy.model.js';
import { Vulnerability } from '../models/vulnerability.model.js';
import { seedChecklists } from '../services/test-check-presets.js';

const LANGUAGES = [
  { language: 'English', locale: 'en' },
  { language: 'Română', locale: 'ro' },
  { language: 'Français', locale: 'fr' },
  { language: 'Deutsch', locale: 'de' },
];

const SECTIONS = [
  { field: 'executive_summary', name: 'Executive Summary', icon: 'FileText' },
  { field: 'scope_and_approach', name: 'Scope and Approach', icon: 'Target' },
  { field: 'methodology', name: 'Methodology', icon: 'ListChecks' },
  { field: 'findings_overview', name: 'Findings Overview', icon: 'BarChart3' },
  { field: 'risk_rating', name: 'Risk Rating Methodology', icon: 'Gauge' },
  { field: 'conclusion', name: 'Conclusion', icon: 'CheckCircle2' },
  { field: 'appendix', name: 'Appendix', icon: 'Paperclip' },
];

const VULN_TYPES = [
  'Web Application',
  'Internal Network',
  'External Network',
  'Active Directory',
  'Mobile Application',
  'API',
  'Cloud Configuration',
  'Wireless',
  'Physical',
  'Social Engineering',
  'Source Code Review',
];

const CATEGORIES = [
  'Access Control',
  'Authentication',
  'Authorization',
  'Configuration',
  'Cryptography',
  'Injection',
  'Input Validation',
  'Information Disclosure',
  'Patch Management',
  'Session Management',
  'Business Logic',
  'Denial of Service',
];

const AUDIT_TYPES = [
  {
    name: 'Web Application Penetration Test',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion'],
  },
  {
    name: 'Internal Network Penetration Test',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion'],
  },
  {
    name: 'External Network Penetration Test',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion'],
  },
  {
    name: 'Red Team Engagement',
    // Picking this type is how somebody asks for the Enumeration tab; the app should not need
    // telling a second time in a different dropdown.
    kind: 'redteam',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion', 'appendix'],
  },
  {
    name: 'Cloud Security Assessment',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion'],
  },
  {
    /*
     * The one type that is a different shape of work rather than a different subject.
     *
     * `kind` is what gives a new engagement of this type a sending list instead of a scope of
     * hosts, so choosing it from the type list is all anybody has to do.
     */
    name: 'Phishing Campaign',
    kind: 'phishing',
    sections: ['executive_summary', 'scope_and_approach', 'methodology', 'conclusion'],
  },
];

const LIBRARY = [
  {
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
    category: 'Injection',
    priority: 4,
    remediationComplexity: 2,
    details: [
      {
        locale: 'en',
        title: 'SQL Injection',
        vulnType: 'Web Application',
        description:
          '<p>The application builds SQL statements by concatenating user-controlled input directly into the query string. An attacker can therefore alter the structure of the query rather than merely supplying data to it.</p>',
        observation:
          '<p>Exploitation grants read and write access to the entire database, including credential material and personal data. Depending on the database privileges it may also allow command execution on the underlying host.</p>',
        remediation:
          '<p>Use parameterised statements (prepared statements) for every query that incorporates external input.</p><ul><li>Never concatenate input into SQL, not even after escaping.</li><li>Apply allow-list validation to values used in ORDER BY or table-name positions, which cannot be parameterised.</li><li>Run the application database user with the least privilege it needs.</li></ul>',
        references: [
          'https://owasp.org/Top10/A03_2021-Injection/',
          'https://cheatsheetseries.owasp.org/cheatsheets/SQL_Injection_Prevention_Cheat_Sheet.html',
          'https://cwe.mitre.org/data/definitions/89.html',
        ],
      },
    ],
  },
  {
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N',
    category: 'Input Validation',
    priority: 3,
    remediationComplexity: 2,
    details: [
      {
        locale: 'en',
        title: 'Reflected Cross-Site Scripting',
        vulnType: 'Web Application',
        description:
          '<p>User-supplied input is reflected into the HTTP response without contextual output encoding, allowing an attacker to inject script that executes in the browser of anyone following a crafted link.</p>',
        observation:
          '<p>An attacker can execute JavaScript in the victim\'s session context: stealing session tokens, performing actions on the victim\'s behalf, or presenting a convincing phishing form on the legitimate origin.</p>',
        remediation:
          '<p>Encode all untrusted data at the point of output, using an encoder appropriate to the context (HTML body, attribute, JavaScript, URL, CSS).</p><ul><li>Prefer a template engine that escapes by default.</li><li>Deploy a Content-Security-Policy that forbids inline script.</li><li>Set the <code>HttpOnly</code> flag on session cookies to blunt token theft.</li></ul>',
        references: [
          'https://owasp.org/www-community/attacks/xss/',
          'https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html',
        ],
      },
    ],
  },
  {
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N',
    category: 'Authorization',
    priority: 4,
    remediationComplexity: 2,
    details: [
      {
        locale: 'en',
        title: 'Insecure Direct Object Reference',
        vulnType: 'Web Application',
        description:
          '<p>Endpoints accept an object identifier from the client and return the corresponding record without verifying that the authenticated user is entitled to it. Incrementing or substituting the identifier exposes other users\' data.</p>',
        observation:
          '<p>Any authenticated user can enumerate and read records belonging to every other user, which is a direct confidentiality breach and, where personal data is involved, a reportable incident.</p>',
        remediation:
          '<p>Enforce an ownership or role check on the server for every object access, keyed on the session identity rather than on a parameter.</p><ul><li>Centralise the check so new endpoints inherit it.</li><li>Consider opaque, unguessable identifiers as defence in depth — but never as the control itself.</li></ul>',
        references: [
          'https://owasp.org/Top10/A01_2021-Broken_Access_Control/',
          'https://cwe.mitre.org/data/definitions/639.html',
        ],
      },
    ],
  },
  {
    cvssv3: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N',
    category: 'Cryptography',
    priority: 2,
    remediationComplexity: 1,
    details: [
      {
        locale: 'en',
        title: 'Weak TLS Configuration',
        vulnType: 'External Network',
        description:
          '<p>The service negotiates deprecated protocol versions and cipher suites that no longer meet current guidance, including suites without forward secrecy.</p>',
        observation:
          '<p>An attacker positioned on the network path has a materially better chance of downgrading or decrypting sessions. The finding also commonly fails compliance baselines such as PCI DSS.</p>',
        remediation:
          '<p>Restrict the service to TLS 1.2 and 1.3 with forward-secret suites only.</p><ul><li>Disable SSLv3, TLS 1.0 and TLS 1.1.</li><li>Remove RC4, 3DES, and any suite using static RSA key exchange.</li><li>Enable HSTS on HTTPS services.</li></ul>',
        references: [
          'https://cheatsheetseries.owasp.org/cheatsheets/Transport_Layer_Protection_Cheat_Sheet.html',
          'https://ssl-config.mozilla.org/',
        ],
      },
    ],
  },
  {
    cvssv3: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N',
    category: 'Configuration',
    priority: 1,
    remediationComplexity: 1,
    details: [
      {
        locale: 'en',
        title: 'Missing Security Headers',
        vulnType: 'Web Application',
        description:
          '<p>Responses omit several hardening headers, notably <code>Content-Security-Policy</code>, <code>X-Content-Type-Options</code> and <code>Referrer-Policy</code>.</p>',
        observation:
          '<p>No issue is directly exploitable through this finding alone, but the absence of these headers removes defence-in-depth that would otherwise limit the impact of injection and content-sniffing bugs.</p>',
        remediation:
          '<p>Add the missing headers at the reverse proxy or application framework so they apply uniformly.</p><ul><li><code>Content-Security-Policy</code> — start in report-only mode, then enforce.</li><li><code>X-Content-Type-Options: nosniff</code></li><li><code>Referrer-Policy: strict-origin-when-cross-origin</code></li></ul>',
        references: ['https://owasp.org/www-project-secure-headers/'],
      },
    ],
  },
];

const CUSTOM_FIELDS = [
  {
    label: 'Affected Environment',
    key: 'environment',
    fieldType: 'select',
    display: 'finding',
    size: 6,
    position: 1,
    options: [
      { locale: 'en', value: 'Production' },
      { locale: 'en', value: 'Staging' },
      { locale: 'en', value: 'Development' },
    ],
    description: 'Where the issue was reproduced. Available in templates as {{ .custom.environment }}',
  },
  {
    label: 'CWE',
    key: 'cwe',
    fieldType: 'input',
    display: 'finding',
    size: 6,
    position: 2,
    description: 'e.g. CWE-89. Available in templates as {{ .custom.cwe }}',
  },
  {
    label: 'Report Classification',
    key: 'classification',
    fieldType: 'select',
    display: 'audit',
    size: 6,
    position: 1,
    options: [
      { locale: 'en', value: 'CONFIDENTIAL' },
      { locale: 'en', value: 'INTERNAL' },
      { locale: 'en', value: 'PUBLIC' },
    ],
    description: 'Available in templates as {{ .custom.classification }}',
  },
];

async function upsertMany(model, docs, uniqueKey) {
  let created = 0;
  for (const doc of docs) {
    const filter =
      typeof uniqueKey === 'function' ? uniqueKey(doc) : { [uniqueKey]: doc[uniqueKey] };
    const result = await model.updateOne(filter, { $setOnInsert: doc }, { upsert: true });
    if (result.upsertedCount) created += 1;
  }
  return created;
}

async function main() {
  await connectDatabase();

  /* --------------------------------- admin --------------------------------- */
  let admin = await User.findOne({ username: env.seed.username });
  if (!admin) {
    admin = await User.create({
      username: env.seed.username,
      email: env.seed.email,
      password: env.seed.password,
      firstname: 'Engy',
      lastname: 'Administrator',
      role: 'admin',
      // The account the instance is built with. There is nobody to approve it.
      approvedAt: new Date(),
    });
    log.info(`Created admin "${admin.username}" with password from SEED_ADMIN_PASSWORD`);
    if (env.seed.password === 'Admin123!') {
      log.warn('That is the default seed password — change it after your first login.');
    }
  } else {
    log.info(`Admin "${admin.username}" already exists, leaving it alone`);
  }

  /* ------------------------------- taxonomies ------------------------------ */
  log.info(`Languages: +${await upsertMany(Language, LANGUAGES, 'locale')}`);
  log.info(`Sections: +${await upsertMany(SectionDefinition, SECTIONS, 'field')}`);
  log.info(
    `Vulnerability types: +${await upsertMany(
      VulnerabilityType,
      VULN_TYPES.map((name) => ({ name, locale: 'en' })),
      (doc) => ({ name: doc.name, locale: doc.locale })
    )}`
  );
  log.info(
    `Categories: +${await upsertMany(
      VulnerabilityCategory,
      CATEGORIES.map((name) => ({ name })),
      'name'
    )}`
  );
  log.info(`Audit types: +${await upsertMany(AuditType, AUDIT_TYPES, 'name')}`);
  log.info(
    `Custom fields: +${await upsertMany(CustomField, CUSTOM_FIELDS, (doc) => ({
      key: doc.key,
      display: doc.display,
    }))}`
  );

  /* ------------------------------- checklists ------------------------------- */
  // The shipped methodologies, as editable data. Idempotent by slug: existing ones
  // keep any edits made to them, and a deleted one comes back.
  const checklists = await seedChecklists();
  log.info(
    `Checklists: +${checklists.created.length}` +
      (checklists.existing.length ? ` (${checklists.existing.length} already present)` : '')
  );

  /* -------------------------------- company -------------------------------- */
  const companyCount = await Company.countDocuments();
  if (companyCount === 0) {
    await Company.create({
      name: 'Example Client Ltd.',
      shortName: 'Example',
      address: '1 Example Street, Bucharest, Romania',
      website: 'https://example.com',
      // Owned by the admin, so it stays visible before it has any engagement.
      createdBy: admin._id,
    });
    log.info('Created a sample company');
  }

  /* -------------------------------- library -------------------------------- */
  let libraryAdded = 0;
  for (const entry of LIBRARY) {
    const exists = await Vulnerability.findOne({ 'details.title': entry.details[0].title });
    if (exists) continue;
    await Vulnerability.create({ ...entry, createdBy: admin._id });
    libraryAdded += 1;
  }
  log.info(`Library vulnerabilities: +${libraryAdded}`);

  await Settings.getSettings();
  log.info('Settings document ready');

  await disconnectDatabase();
  log.info('Seed complete.');
}

main().catch(async (err) => {
  log.error(err.stack ?? err.message);
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
