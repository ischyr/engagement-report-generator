/**
 * Sections you build every time, as one click.
 *
 * Enumeration is a methodology, not a series of improvisations: the same eight things get pointed
 * at every new domain, in the same order, and typing that tree out again is the tax on starting.
 * A preset is a section and the steps under it, each with the command already written.
 *
 * Deliberately editable rather than authoritative. Every step arrives as an ordinary step — nothing
 * marks it as coming from a preset — so the first thing anybody does is delete the two they do not
 * use and fix the flags on the rest, which is the point.
 *
 * The commands reference `$TARGET`, the engagement variable, rather than having a domain pasted into
 * them. A preset cannot know the domain; and once it is a variable, changing it later updates every
 * command at once instead of thirty of them individually — which is the difference between commands
 * that stay true and commands that quietly stop matching what was run.
 *
 * Modelled on `test-check-presets.js`, which does the same job for methodology checklists.
 */

/** Where $TARGET appears in a command, so the client can offer to substitute it. */
export const PRESET_TARGET = '$TARGET';

const PRESETS = [
  {
    key: 'subdomains',
    label: 'Subdomain Enumeration',
    description: 'Eight sources for one question: what names exist under this domain.',
    phase: 'recon',
    summary:
      'Establishing the name surface: every subdomain reachable from public sources, then which of them actually answer.',
    steps: [
      { title: 'PhoneBook.cz', tool: 'phonebook.cz', note: 'Web interface — no command.' },
      { title: 'crt.sh — certificate transparency', tool: 'crt.sh', command: 'curl -s "https://crt.sh/?q=%25.$TARGET&output=json" | jq -r ".[].name_value" | sort -u' },
      { title: 'ProjectDiscovery — subfinder', tool: 'subfinder', command: 'subfinder -d $TARGET -all -silent' },
      { title: 'assetfinder', tool: 'assetfinder', command: 'assetfinder --subs-only $TARGET' },
      { title: 'bbot', tool: 'bbot', command: 'bbot -t $TARGET -p subdomain-enum' },
      { title: 'amass', tool: 'amass', command: 'amass enum -passive -d $TARGET' },
      { title: 'Sorted subdomains', tool: '', note: 'The merged, deduplicated list — the input to everything below.' },
      { title: 'HTTPx — server validation', tool: 'httpx', command: 'httpx -l subdomains.txt -sc -title -tech-detect -follow-redirects' },
    ],
  },
  {
    key: 'web',
    label: 'WebServer Enumeration',
    description: 'What each host is running, and what it exposes.',
    phase: 'recon',
    summary: 'Fingerprinting the live hosts: server software, technologies, exposed paths and obvious misconfiguration.',
    steps: [
      { title: 'Technology fingerprint', tool: 'httpx', command: 'httpx -l live.txt -tech-detect -server -json' },
      { title: 'TLS configuration', tool: 'testssl.sh', command: 'testssl.sh --quiet --severity LOW $TARGET' },
      { title: 'Content discovery', tool: 'feroxbuster', command: 'feroxbuster -u https://$TARGET -w raft-medium-directories.txt -x php,txt,bak' },
      { title: 'Known issues sweep', tool: 'nuclei', command: 'nuclei -l live.txt -severity medium,high,critical' },
      { title: 'Headers and cookies', tool: 'Burp Suite Professional', note: 'Manual review of the responses collected above.' },
    ],
  },
  {
    key: 'ports',
    label: 'Port and Service Enumeration',
    description: 'Discovery, then a service scan of what answered.',
    phase: 'recon',
    summary: 'Which ports are open across the netblocks in scope, and what is listening on them.',
    steps: [
      { title: 'Host discovery', tool: 'nmap', command: 'nmap -sn $TARGET -oA discovery' },
      { title: 'Fast port sweep', tool: 'masscan', command: 'masscan $TARGET -p1-65535 --rate 1000 -oL ports.txt' },
      { title: 'Service and version scan', tool: 'nmap', command: 'nmap -sV -sC -p- -iL live.txt -oA services' },
      { title: 'UDP top ports', tool: 'nmap', command: 'nmap -sU --top-ports 100 -iL live.txt -oA udp' },
    ],
  },
  {
    key: 'email',
    label: 'Email Enumeration',
    description: 'Who works there, and what their address looks like.',
    phase: 'recon',
    summary: 'Building the people surface: valid addresses and the naming convention behind them.',
    steps: [
      { title: 'PhoneBook.cz — addresses', tool: 'phonebook.cz', note: 'Web interface — no command.' },
      { title: 'hunter.io', tool: 'hunter.io', note: 'Pattern and confidence per address.' },
      { title: 'LinkedIn — names', tool: 'linkedin2username', command: 'linkedin2username -c "$TARGET" -n' },
      { title: 'Address verification', tool: 'o365spray', command: 'o365spray --validate --domain $TARGET' },
      { title: 'Breach exposure', tool: 'dehashed', note: 'Credentials already public for this domain.' },
    ],
  },
  {
    key: 'asn',
    label: 'Autonomous System Number (ASN)',
    description: 'The netblocks the organisation actually owns.',
    phase: 'recon',
    summary: 'Establishing which ranges belong to the client rather than to their hosting provider.',
    steps: [
      { title: 'whois', tool: 'whois', command: 'whois -h whois.radb.net -- "-i origin ASxxxx" | grep route' },
      { title: 'bgp.he.net', tool: 'bgp.he.net', note: 'Prefixes and peers, by hand.' },
      { title: 'amass intel', tool: 'amass', command: 'amass intel -org "$TARGET"' },
      { title: 'Reverse DNS across the ranges', tool: 'dnsx', command: 'dnsx -ptr -l ranges.txt -resp-only' },
    ],
  },
  {
    key: 'cloud',
    label: 'Cloud Enumeration',
    description: 'Buckets, tenants and the DNS that points at them.',
    phase: 'recon',
    summary: 'What of this estate lives with a cloud provider, and what of it is reachable without credentials.',
    steps: [
      { title: 'CNAME survey', tool: 'dnsx', command: 'dnsx -cname -l subdomains.txt -resp' },
      { title: 'Storage buckets', tool: 'cloud_enum', command: 'cloud_enum -k $TARGET' },
      { title: 'Tenant discovery', tool: 'AADInternals', command: 'Get-AADIntTenantID -Domain $TARGET' },
      { title: 'Subdomain takeover check', tool: 'nuclei', command: 'nuclei -l subdomains.txt -t takeovers/' },
    ],
  },
];

/** Everything the picker needs, without the step bodies. */
export function enumerationPresets() {
  return PRESETS.map(({ key, label, description, steps }) => ({
    key,
    label,
    description,
    steps: steps.length,
  }));
}

export function enumerationPresetByKey(key) {
  return PRESETS.find((preset) => preset.key === key) ?? null;
}

/**
 * The section and its steps, ready to push onto an engagement.
 *
 * Nothing is substituted here any more. `$TARGET` travels through to the stored command and the
 * engagement's variable resolves it on the way out — so the command in the tab and the command in
 * the report are the same text, and changing the target is one edit rather than thirty.
 *
 * `target` only fills each step's own Target field, which is a label rather than part of a command.
 */
export function buildEnumerationPreset(key, { target = '' } = {}) {
  const preset = enumerationPresetByKey(key);
  if (!preset) return null;
  const fill = (value) => String(value ?? '');
  return {
    section: {
      title: preset.label,
      phase: preset.phase ?? '',
      summary: fill(preset.summary),
    },
    steps: preset.steps.map((step) => ({
      title: step.title,
      tool: step.tool ?? '',
      command: fill(step.command ?? ''),
      target: target || '',
      phase: preset.phase ?? '',
      /* A note is guidance for the operator, so it starts life as the write-up. */
      content: step.note ? `<p>${step.note}</p>` : '',
    })),
  };
}

export default PRESETS;
