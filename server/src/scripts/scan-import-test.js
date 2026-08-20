/**
 * Checks the Nmap importer against realistic `-oX` output, including the awkward
 * cases: hosts that are down, closed ports, no reverse DNS, several addresses,
 * competing OS guesses, and XML entities in service banners.
 */

import { parseNmapXml, mergeHostsIntoScope } from '../services/scan-import.service.js';

let pass = 0;
let fail = 0;
const check = (label, ok, got) => {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${got !== undefined ? ` — got ${JSON.stringify(got)}` : ''}`);
  }
};

const SCAN = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="nmap -sV -O -oX out.xml 203.0.113.0/29" start="1785000000"
         startstr="Sat Aug  2 10:00:00 2026" version="7.94">
  <host starttime="1785000001">
    <status state="up" reason="echo-reply"/>
    <address addr="203.0.113.10" addrtype="ipv4"/>
    <address addr="00:0c:29:aa:bb:cc" addrtype="mac" vendor="VMware"/>
    <hostnames>
      <hostname name="portal.acme.example" type="PTR"/>
      <hostname name="acme-portal" type="user"/>
    </hostnames>
    <ports>
      <extraports state="closed" count="996"/>
      <port protocol="tcp" portid="22">
        <state state="open" reason="syn-ack"/>
        <service name="ssh" product="OpenSSH" version="8.9p1 Ubuntu" method="probed"/>
      </port>
      <port protocol="tcp" portid="80">
        <state state="open" reason="syn-ack"/>
        <service name="http" product="nginx" version="1.24.0"/>
      </port>
      <port protocol="tcp" portid="443">
        <state state="open" reason="syn-ack"/>
        <service name="https" product="nginx &amp; mod_ssl" version="1.24.0"/>
      </port>
      <port protocol="tcp" portid="3306">
        <state state="filtered" reason="no-response"/>
        <service name="mysql"/>
      </port>
    </ports>
    <os>
      <osmatch name="Linux 4.15 - 5.8" accuracy="92"/>
      <osmatch name="Linux 5.0 - 5.14" accuracy="96"/>
    </os>
  </host>
  <host>
    <status state="down" reason="no-response"/>
    <address addr="203.0.113.11" addrtype="ipv4"/>
  </host>
  <host>
    <status state="up"/>
    <address addr="203.0.113.12" addrtype="ipv4"/>
    <ports>
      <port protocol="udp" portid="161">
        <state state="open"/>
        <service name="snmp"/>
      </port>
    </ports>
  </host>
  <runstats><finished time="1785000200" elapsed="199.12"/></runstats>
</nmaprun>`;

console.log('parsing:');
const parsed = parseNmapXml(SCAN);
check('scanner metadata read', parsed.meta.version === '7.94', parsed.meta);
check('command line preserved', parsed.meta.args.includes('-sV'), parsed.meta.args);
check('two live hosts imported', parsed.hosts.length === 2, parsed.hosts.length);
check('down host skipped', parsed.stats.hostsDown === 1, parsed.stats);

const [first, second] = parsed.hosts;
check('ipv4 address taken, MAC ignored', first.ip === '203.0.113.10', first.ip);
check('user-supplied hostname preferred over PTR', first.hostname === 'acme-portal', first.hostname);
check('highest-accuracy OS chosen', first.os === 'Linux 5.0 - 5.14', first.os);
check('only open ports kept', first.services.length === 3, first.services.map((s) => s.port));
check('ports sorted', first.services.map((s) => s.port).join(',') === '22,80,443');
check('product and version joined', first.services[0].product === 'OpenSSH 8.9p1 Ubuntu', first.services[0].product);
check('XML entity decoded in banner', first.services[2].product === 'nginx & mod_ssl 1.24.0', first.services[2].product);
check('filtered port excluded', !first.services.some((s) => s.port === 3306));
check('udp protocol recorded', second.services[0].protocol === 'udp', second.services[0]);
check('host with no reverse DNS has empty hostname', second.hostname === '', second.hostname);

console.log('\noptions:');
const withDown = parseNmapXml(SCAN, { includeDown: true });
check('includeDown adds the dead host', withDown.hosts.length === 3, withDown.hosts.length);
const allPorts = parseNmapXml(SCAN, { onlyOpen: false });
check('onlyOpen=false keeps the filtered port', allPorts.hosts[0].services.length === 4, allPorts.hosts[0].services.length);

console.log('\nrejections:');
for (const [label, input] of [
  ['plain text', 'this is not xml'],
  ['other XML', '<?xml version="1.0"?><report><issue/></report>'],
  ['empty string', ''],
]) {
  let threw = false;
  try {
    parseNmapXml(input);
  } catch (error) {
    threw = /Nmap XML/i.test(error.message);
  }
  check(`${label} rejected with guidance`, threw);
}
let noHosts = false;
try {
  parseNmapXml('<nmaprun scanner="nmap"></nmaprun>');
} catch (error) {
  noHosts = /No hosts found/i.test(error.message);
}
check('scan with no hosts reports that clearly', noHosts);

console.log('\nmerging into existing scope:');
const existing = [
  {
    name: 'Production',
    hosts: [
      { hostname: '', ip: '203.0.113.10', os: '', services: [] },
      { hostname: 'legacy.acme.example', ip: '198.51.100.5', os: 'Windows', services: [] },
    ],
  },
];
const merged = mergeHostsIntoScope(existing, parsed.hosts, 'Production');
check('existing host updated, not duplicated', merged.updated === 1, merged);
check('new host added', merged.added === 1, merged);
check('no duplicate rows', merged.scope[0].hosts.length === 3, merged.scope[0].hosts.length);
const updatedHost = merged.scope[0].hosts.find((h) => h.ip === '203.0.113.10');
check('gap filled in from the scan', updatedHost.hostname === 'acme-portal', updatedHost.hostname);
check('OS filled in from the scan', updatedHost.os === 'Linux 5.0 - 5.14', updatedHost.os);
check('services attached', updatedHost.services.length === 3);
const untouched = merged.scope[0].hosts.find((h) => h.ip === '198.51.100.5');
check('unrelated host left alone', untouched.os === 'Windows' && untouched.hostname === 'legacy.acme.example');

const newGroup = mergeHostsIntoScope(existing, parsed.hosts, 'External');
check('a new group is created when named', newGroup.scope.length === 2, newGroup.scope.map((g) => g.name));
check(
  'a host already known elsewhere is not duplicated into the new group',
  newGroup.scope.find((g) => g.name === 'External').hosts.length === 1,
  newGroup.scope.find((g) => g.name === 'External').hosts.length
);

// Re-importing the same scan must be a no-op.
const twice = mergeHostsIntoScope(merged.scope, parsed.hosts, 'Production');
check('re-importing adds nothing', twice.added === 0 && twice.updated === 2, twice);

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
