/**
 * Ready-made checklists, so a new engagement starts with the ground it should
 * cover rather than an empty list.
 *
 * Grouped along the OWASP Web Security Testing Guide's categories for the web
 * set, and ordinary infrastructure practice for the network one. They are a
 * starting point, not a standard: every item is editable and deletable once
 * added, and teams are expected to prune to the engagement's scope.
 */

export const TEST_CHECK_PRESETS = [
  {
    id: 'web',
    name: 'Web application',
    description: 'OWASP WSTG-shaped coverage for a web application assessment.',
    checks: [
      // Recon
      { category: 'Reconnaissance', title: 'Fingerprint web server, framework and versions' },
      { category: 'Reconnaissance', title: 'Review robots.txt, sitemaps and exposed metadata files' },
      { category: 'Reconnaissance', title: 'Enumerate application entry points and hidden endpoints' },
      { category: 'Reconnaissance', title: 'Check for exposed source control, backups and archives' },

      // Configuration
      { category: 'Configuration', title: 'Review HTTP security headers' },
      { category: 'Configuration', title: 'Check TLS versions, cipher suites and certificate validity' },
      { category: 'Configuration', title: 'Test for verbose errors and stack traces' },
      { category: 'Configuration', title: 'Check HTTP methods permitted on each endpoint' },
      { category: 'Configuration', title: 'Review cookie flags (HttpOnly, Secure, SameSite)' },

      // Authentication
      { category: 'Authentication', title: 'Test for username enumeration' },
      { category: 'Authentication', title: 'Test password policy strength' },
      { category: 'Authentication', title: 'Test for credential brute-force protection and lockout' },
      { category: 'Authentication', title: 'Test the password reset and recovery flow' },
      { category: 'Authentication', title: 'Test multi-factor authentication, where present' },
      { category: 'Authentication', title: 'Check credentials are never sent over an unencrypted channel' },

      // Session management
      { category: 'Session management', title: 'Verify session token randomness and length' },
      { category: 'Session management', title: 'Test session fixation' },
      { category: 'Session management', title: 'Verify session invalidation on logout and timeout' },
      { category: 'Session management', title: 'Test for CSRF on state-changing requests' },
      { category: 'Session management', title: 'Test concurrent session handling' },

      // Authorization
      { category: 'Authorization', title: 'Test horizontal privilege escalation (another user’s data)' },
      { category: 'Authorization', title: 'Test vertical privilege escalation (higher-privileged actions)' },
      { category: 'Authorization', title: 'Test for insecure direct object references' },
      { category: 'Authorization', title: 'Test path traversal and forced browsing' },

      // Input validation
      { category: 'Input validation', title: 'Test for SQL and NoSQL injection' },
      { category: 'Input validation', title: 'Test for reflected, stored and DOM cross-site scripting' },
      { category: 'Input validation', title: 'Test for command injection' },
      { category: 'Input validation', title: 'Test for server-side template injection' },
      { category: 'Input validation', title: 'Test for XML external entity injection' },
      { category: 'Input validation', title: 'Test for server-side request forgery' },
      { category: 'Input validation', title: 'Test for open redirects' },
      { category: 'Input validation', title: 'Test for host header injection' },

      // Business logic
      { category: 'Business logic', title: 'Test workflow steps can be skipped or replayed' },
      { category: 'Business logic', title: 'Test quantity, price and limit tampering' },
      { category: 'Business logic', title: 'Test race conditions on critical operations' },

      // Files and data
      { category: 'Files and data', title: 'Test file upload restrictions (type, size, content)' },
      { category: 'Files and data', title: 'Test file download and export for injection or traversal' },
      { category: 'Files and data', title: 'Check sensitive data is not cached or logged' },

      // API
      { category: 'API', title: 'Test API authentication and authorization per endpoint' },
      { category: 'API', title: 'Test for mass assignment and excessive data exposure' },
      { category: 'API', title: 'Test rate limiting on expensive or sensitive endpoints' },

      // Client side
      { category: 'Client side', title: 'Review client-side storage for sensitive data' },
      { category: 'Client side', title: 'Check third-party scripts and subresource integrity' },
      { category: 'Client side', title: 'Test CORS configuration' },
    ],
  },

  {
    id: 'network',
    name: 'Network / infrastructure',
    description: 'Host and service coverage for an internal or external network test.',
    checks: [
      { category: 'Discovery', title: 'Host discovery across the agreed ranges' },
      { category: 'Discovery', title: 'Full TCP port scan of in-scope hosts' },
      { category: 'Discovery', title: 'UDP scan of common services' },
      { category: 'Discovery', title: 'Service and version fingerprinting' },

      { category: 'Patching', title: 'Identify end-of-life operating systems and services' },
      { category: 'Patching', title: 'Check for missing patches on exposed services' },

      { category: 'Authentication', title: 'Test for default and weak service credentials' },
      { category: 'Authentication', title: 'Check for anonymous access to shares and services' },
      { category: 'Authentication', title: 'Test for password reuse across hosts' },

      { category: 'Protocols', title: 'Review TLS configuration on all exposed services' },
      { category: 'Protocols', title: 'Check for cleartext protocols in use (telnet, FTP, HTTP)' },
      { category: 'Protocols', title: 'Test SMB signing and legacy protocol support' },
      { category: 'Protocols', title: 'Check SNMP community strings' },

      { category: 'Exposure', title: 'Identify management interfaces reachable from the test position' },
      { category: 'Exposure', title: 'Check database services for direct exposure' },
      { category: 'Exposure', title: 'Review network segmentation between zones' },
      { category: 'Exposure', title: 'Test for unauthenticated information disclosure on services' },
    ],
  },

  {
    id: 'activedirectory',
    name: 'Active Directory',
    description: 'Domain-focused checks for an internal engagement.',
    checks: [
      { category: 'Enumeration', title: 'Enumerate domain users, groups and computers' },
      { category: 'Enumeration', title: 'Review password policy and lockout thresholds' },
      { category: 'Enumeration', title: 'Identify privileged group membership' },
      { category: 'Enumeration', title: 'Map trust relationships' },

      { category: 'Credentials', title: 'Test for AS-REP roastable accounts' },
      { category: 'Credentials', title: 'Test for Kerberoastable service accounts' },
      { category: 'Credentials', title: 'Check for credentials in SYSVOL, scripts and GPOs' },
      { category: 'Credentials', title: 'Check for LAPS coverage on workstations and servers' },

      { category: 'Escalation', title: 'Review ACLs for dangerous delegated rights' },
      { category: 'Escalation', title: 'Test for unconstrained and constrained delegation abuse' },
      { category: 'Escalation', title: 'Test for certificate services misconfiguration' },
      { category: 'Escalation', title: 'Check for privileged accounts with stale passwords' },

      { category: 'Lateral movement', title: 'Test for NTLM relay opportunities' },
      { category: 'Lateral movement', title: 'Check LLMNR/NBT-NS/mDNS response behaviour' },
      { category: 'Lateral movement', title: 'Review local administrator reuse across hosts' },
    ],
  },

  {
    id: 'reporting',
    name: 'Report quality',
    description: 'The pass over the document itself, before it goes to the client.',
    checks: [
      { category: 'Report', title: 'Every finding has evidence a reader could reproduce' },
      { category: 'Report', title: 'Severities agree with the CVSS vectors recorded' },
      { category: 'Report', title: 'Remediation advice is specific and actionable' },
      { category: 'Report', title: 'Executive summary matches the findings' },
      { category: 'Report', title: 'Client and system names are correct throughout' },
      { category: 'Report', title: 'Screenshots are redacted of unrelated sensitive data' },
      { category: 'Report', title: 'Scope and dates match the statement of work' },
      { category: 'Report', title: 'Spelling and grammar pass' },
      { category: 'Report', title: 'Peer review completed' },
    ],
  },
];

/**
 * Copies the shipped methodologies into the Checklist collection.
 *
 * Idempotent by slug: re-running leaves existing ones alone, including any edits
 * made to them, so `npm run seed` stays safe to re-run. It does restore one you
 * deleted, which is the documented way to get a shipped methodology back.
 *
 * @returns {Promise<{created: string[], existing: string[]}>}
 */
export async function seedChecklists() {
  const { Checklist } = await import('../models/checklist.model.js');
  const created = [];
  const existing = [];

  for (const preset of TEST_CHECK_PRESETS) {
    const already = await Checklist.findOne({ slug: preset.id });
    if (already) {
      existing.push(preset.name);
      continue;
    }
    await Checklist.create({
      slug: preset.id,
      builtin: true,
      name: preset.name,
      description: preset.description,
      checks: preset.checks.map((check, index) => ({ ...check, order: index })),
    });
    created.push(preset.name);
  }

  return { created, existing };
}

/**
 * Every checklist available to start an engagement from, summarised.
 *
 * Reads the collection rather than this file: the built-ins below are only the
 * seed, and a team's own methodologies have to appear in the same picker.
 */
export async function presetSummaries() {
  const { Checklist } = await import('../models/checklist.model.js');
  const checklists = await Checklist.find().sort({ builtin: -1, name: 1 });

  return checklists.map((checklist) => ({
    id: checklist._id,
    name: checklist.name,
    description: checklist.description ?? '',
    builtin: Boolean(checklist.builtin),
    count: (checklist.checks ?? []).length,
    categories: [
      ...new Set((checklist.checks ?? []).map((check) => check.category?.trim() || 'Ungrouped')),
    ],
  }));
}

/**
 * Looks a checklist up by id, or by slug so an older client — or a bookmarked
 * request — posting `preset: 'web'` still resolves.
 */
export async function findPreset(id) {
  const { Checklist } = await import('../models/checklist.model.js');
  const mongoose = (await import('mongoose')).default;

  if (mongoose.isValidObjectId(id)) {
    const byId = await Checklist.findById(id);
    if (byId) return byId;
  }
  return Checklist.findOne({ slug: String(id ?? '').toLowerCase() });
}

export default TEST_CHECK_PRESETS;
