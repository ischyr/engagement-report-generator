/**
 * Tool output, as a table.
 *
 * A code pane is honest but it is not a deliverable. Five hundred lines of httpx in a monospaced
 * block is something a client scrolls past; the same data as four columns is something they read.
 * So for the tools whose output has a knowable shape, this parses it into rows and the report
 * prints a real Word table.
 *
 * Conservative on purpose. Every parser must either be confident or return nothing: a table with
 * the columns misaligned is worse than the raw output, because it looks authoritative. When nothing
 * matches, the report falls back to the pane, which always works.
 *
 * The raw output is never replaced — `{{@rich.output}}` still prints it. This is an additional way
 * to show the same bytes, which is what makes getting it wrong cheap.
 */

/** Below this share of lines parsed, the shape was probably not what we guessed. */
const CONFIDENCE = 0.6;

const clean = (value) => String(value ?? '').trim();

const usableLines = (output) =>
  String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/, ''))
    .filter((line) => line.trim().length > 0);

/**
 * httpx, in its default human-readable form:
 *
 *   https://www.acme.example      [200] [Acme — Home] [nginx:1.24.0,React]
 *
 * The brackets are the grammar. Their count varies with the flags used, so they are read
 * positionally only as far as they go: a run with `-sc` alone yields one, and that is still a table.
 */
function parseHttpx(output) {
  const rows = [];
  let seen = 0;
  for (const line of usableLines(output)) {
    seen += 1;
    const match = line.match(/^(\S+)\s+(\[[^\]]*\](?:\s*\[[^\]]*\])*)\s*$/);
    if (!match) continue;
    const fields = [...match[2].matchAll(/\[([^\]]*)\]/g)].map((m) => clean(m[1]));
    rows.push([clean(match[1]), fields[0] ?? '', fields[1] ?? '', fields[2] ?? '']);
  }
  if (!seen || rows.length / seen < CONFIDENCE) return null;
  return { columns: ['URL', 'Status', 'Title', 'Technology'], rows };
}

/**
 * nmap's normal output, the port table only:
 *
 *   22/tcp   open  ssh     OpenSSH 8.2p1 Ubuntu
 *
 * Everything else in the file — the banner, the host lines, the timing summary — is skipped rather
 * than parsed, so a whole scan can be pasted in and the table is still just the ports.
 */
function parseNmap(output) {
  const rows = [];
  let host = '';
  for (const line of usableLines(output)) {
    const hostLine = line.match(/^Nmap scan report for\s+(.+?)\s*$/i);
    if (hostLine) {
      host = clean(hostLine[1]);
      continue;
    }
    if (/^PORT\s+STATE\s+SERVICE/i.test(line)) continue;
    const port = line.match(/^(\d{1,5})\/(tcp|udp|sctp)\s+(\S+)\s+(\S+)\s*(.*)$/i);
    if (!port) continue;
    rows.push([
      host,
      `${port[1]}/${port[2].toLowerCase()}`,
      clean(port[3]),
      clean(port[4]),
      clean(port[5]),
    ]);
  }
  if (!rows.length) return null;
  /* Confidence is not a ratio here: a scan is mostly prose with a few port lines in it. */

  /*
   * The host column is dropped when there was only ever one host, which is the usual case — a
   * column repeating the same value four hundred times is a column nobody reads.
   */
  const oneHost = rows.every((row) => row[0] === rows[0][0]);
  if (oneHost) {
    return {
      columns: ['Port', 'State', 'Service', 'Version'],
      rows: rows.map((row) => row.slice(1)),
    };
  }
  return { columns: ['Host', 'Port', 'State', 'Service', 'Version'], rows };
}

/**
 * dnsx and anything else that answers `name [TYPE] [value]`, plus plain delimited output.
 *
 * The last resort, and the one most likely to be wrong, so it demands the most: every usable line
 * must split into the same number of columns on tabs or on runs of two or more spaces. One ragged
 * line and it declines.
 */
function parseDelimited(output) {
  const lines = usableLines(output);
  if (lines.length < 2) return null;
  const split = (line) => line.split(/\t+|\s{2,}/).map(clean).filter((cell) => cell.length > 0);
  const first = split(lines[0]);
  if (first.length < 2 || first.length > 8) return null;
  const rows = [];
  for (const line of lines) {
    const cells = split(line);
    if (cells.length !== first.length) return null;
    rows.push(cells);
  }
  return {
    columns: first.map((_, index) => `Column ${index + 1}`),
    rows,
  };
}

const PARSERS = [
  { name: 'httpx', match: /httpx/i, parse: parseHttpx },
  { name: 'nmap', match: /nmap|masscan/i, parse: parseNmap },
];

/**
 * The output of one step as a table, or null when nothing could be read confidently.
 *
 * The tool name picks the parser; failing that, and failing the generic delimited reader, the answer
 * is null and the caller prints the pane.
 */
export function parseToolOutput(tool, output) {
  if (!String(output ?? '').trim()) return null;

  /* The named tool first — it is the strongest signal about the shape. */
  for (const { name, match, parse } of PARSERS) {
    if (match.test(String(tool ?? ''))) {
      const table = parse(output);
      if (table?.rows?.length) return { ...table, parser: name };
    }
  }

  /*
   * Then every parser regardless of the name.
   *
   * The Tool field is often blank, or says "recon" rather than the binary. The bracket grammar of
   * httpx and the port lines of nmap are distinctive enough to recognise on their own, and getting
   * "URL / Status / Title" beats getting "Column 1 / Column 2" from the generic reader below.
   */
  for (const { name, parse } of PARSERS) {
    const table = parse(output);
    if (table?.rows?.length) return { ...table, parser: name };
  }

  /*
   * And last, anything consistently delimited. A person who pasted a tidy two-column list gets a
   * table without having to tell the app what produced it.
   */
  const generic = parseDelimited(output);
  if (generic?.rows?.length) return { ...generic, parser: 'delimited' };
  return null;
}

/** The same table as HTML, for the one path in this codebase that turns HTML into a Word table. */
export function tableToHtml(table) {
  if (!table?.rows?.length) return '';
  const cell = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  const head = `<thead><tr>${table.columns.map((c) => `<th>${cell(c)}</th>`).join('')}</tr></thead>`;
  const body = `<tbody>${table.rows
    .map((row) => `<tr>${row.map((c) => `<td>${cell(c)}</td>`).join('')}</tr>`)
    .join('')}</tbody>`;
  return `<table>${head}${body}</table>`;
}

/* ------------------------------------------------------------------- cache ---- */

/**
 * The same parse, remembered.
 *
 * Recognising a table means walking every line of the output, and the callers ask for the same
 * answer over and over: the tree asks whether each step *has* a table every time the list is
 * fetched, and the report asks again for every preview and every render. On an operation with sixty
 * steps and four hundred lines each that is the single most expensive thing either does — measured
 * at 33ms of a 34ms report build, which is to say all of it.
 *
 * Keyed by the step and the moment it was last written, so the entry cannot outlive the output it
 * describes: any save bumps `updatedAt` and the old parse becomes unreachable rather than wrong.
 * Bounded and oldest-out, because a long-running server must not accumulate every step of every
 * engagement anybody has opened this month.
 */
const CACHE_MAX = 400;
const cache = new Map();

/** The key for a step's parse: its id and the write that produced this output. */
export function stepParseKey(step) {
  const id = String(step?._id ?? '');
  if (!id) return '';
  const stamp = step?.updatedAt ? new Date(step.updatedAt).getTime() : 0;
  return `${id}:${stamp}:${step?.tool ?? ''}`;
}

/**
 * `parseToolOutput`, memoised against a key from `stepParseKey`.
 *
 * Falls through to a plain parse when there is no key — a step that has never been saved has nothing
 * stable to key on, and a wrong cache hit would be far worse than a slow one.
 */
export function parseToolOutputCached(key, tool, output) {
  if (!key) return parseToolOutput(tool, output);

  if (cache.has(key)) {
    /* Re-inserted so the eviction below takes the genuinely least recent, not merely the oldest. */
    const hit = cache.get(key);
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }

  const parsed = parseToolOutput(tool, output);
  cache.set(key, parsed);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return parsed;
}

export default parseToolOutput;
