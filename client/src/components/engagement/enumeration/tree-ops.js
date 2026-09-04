/**
 * The parts of the enumeration workbench that are just functions.
 *
 * Split out of `EnumerationTab.jsx`, which had grown to 2,600 lines — a file that size stops being
 * read and starts being searched. Nothing here touches React state or the network: the labels the
 * tab draws from, the rearrangement primitive every move goes through, the filter, and the two
 * halves of a step. Which makes them testable on their own, and makes the component above them
 * shorter by everything below.
 */
export const PHASES = [
  { value: '', label: 'No phase' },
  { value: 'recon', label: 'Reconnaissance' },
  { value: 'access', label: 'Initial access' },
  { value: 'escalation', label: 'Privilege escalation' },
  { value: 'lateral', label: 'Lateral movement' },
  { value: 'objective', label: 'Actions on objective' },
];
export const PHASE_LABEL = Object.fromEntries(PHASES.map((p) => [p.value, p.label]));

export const STATUSES = [
  { value: '', label: 'No outcome' },
  { value: 'completed', label: 'Completed' },
  { value: 'nothing', label: 'Nothing found' },
  { value: 'timeout', label: 'Timed out' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'abandoned', label: 'Not pursued' },
];
export const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
/** Tone per outcome, so a tree of forty rows can be read without stopping to read. */
export const STATUS_TONE = {
  completed: 'success',
  nothing: 'neutral',
  timeout: 'warning',
  blocked: 'danger',
  abandoned: 'neutral',
};

export const PRINT_MODES = [
  { value: 'all', label: 'Print all of it' },
  { value: 'head', label: 'Print the first lines only' },
  { value: 'table', label: 'Print the table only' },
  { value: 'none', label: 'Do not print the output' },
];

export const BLANK = {
  title: '',
  tool: '',
  target: '',
  command: '',
  ranAt: '',
  output: '',
  content: '',
  phase: '',
  status: '',
  summary: '',
  internal: false,
  printOutput: 'all',
  printLines: 40,
};

export const draftOf = (step) => ({
  title: step?.title ?? '',
  tool: step?.tool ?? '',
  target: step?.target ?? '',
  command: step?.command ?? '',
  ranAt: step?.ranAt ?? '',
  output: step?.output ?? '',
  content: step?.content ?? '',
  phase: step?.phase ?? '',
  status: step?.status ?? '',
  summary: step?.summary ?? '',
  internal: Boolean(step?.internal),
  printOutput: step?.printOutput ?? 'all',
  printLines: step?.printLines ?? 40,
});

export const idOf = (value) => String(value ?? '');

/**
 * An age in days, as somebody would say it.
 *
 * Words rather than a date, because the question is never "what was the date" — it is "is this still
 * current". "Today" and "yesterday" beat "0 days ago", and past a fortnight the exact figure stops
 * mattering next to the fact that it is old.
 */
export const agoInWords = (days) => {
  if (days === null || days === undefined) return '';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
};

/**
 * The fields only the detail endpoint sends.
 *
 * Naming them once, here, is what keeps the two halves of a step from drifting apart: the light row
 * is the detail row minus exactly this list, and the server builds the detail by adding exactly this
 * list to the light one. So a save's response can be split back into a row for the tree and a body
 * for the editor without either side reimplementing the other's idea of what a row is.
 */
export const BODY_FIELDS = ['output', 'content', 'previousOutput', 'table', 'notes'];

export const pickBody = (detail) =>
  Object.fromEntries(BODY_FIELDS.filter((key) => key in detail).map((key) => [key, detail[key]]));

/** A detail row with its body taken off — which is precisely a row of the tree. */
export const lightenStep = (detail) => {
  const row = { ...detail };
  for (const key of BODY_FIELDS) delete row[key];
  /* Envelope, not row: these travel with a response and have no business in the tree. */
  delete row._mentions;
  delete row.treeChanged;
  delete row.copied;
  return row;
};

/** Where the workbench splitter sits, per person rather than per engagement. */
export const PANE_KEY = 'engy.enumeration.paneWidth';
/**
 * Which sections are folded, per engagement.
 *
 * On the machine rather than the server, deliberately: how much of the tree you have open is a fact
 * about where you are working right now, not about the engagement. Two operators on the same tree
 * want different things folded, and pushing this to the record would have them fighting over it.
 */
export const FOLD_KEY = 'engy.enumeration.folded';

export const readFolds = (auditId) => {
  try {
    const all = JSON.parse(window.localStorage.getItem(FOLD_KEY) ?? '{}');
    return new Set(Array.isArray(all[auditId]) ? all[auditId].map(String) : []);
  } catch {
    /* A browser with storage switched off simply starts unfolded. */
    return new Set();
  }
};

export const writeFolds = (auditId, folded) => {
  try {
    const all = JSON.parse(window.localStorage.getItem(FOLD_KEY) ?? '{}');
    if (folded.size) all[auditId] = [...folded];
    else delete all[auditId];
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(all));
  } catch {
    /* Not worth telling anybody about: the tree is on screen either way. */
  }
};
export const MIN_PANE = 240;
export const MAX_PANE = 560;

/* ---------------------------------------------------------------- the tree ---- */

/**
 * A step and everything under it. Used to move a branch, and to refuse dropping one inside itself.
 *
 * Children indexed by parent first. The obvious version rescans every row for every id it has
 * already found and tests membership against a growing array, which is two nested scans inside a
 * third — fine for six rows, and the reason dragging felt heavy at two hundred.
 */
export function subtreeOf(rows, id) {
  const children = new Map();
  for (const row of rows) {
    const parent = idOf(row.parent);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(idOf(row._id));
  }

  const ids = new Set([idOf(id)]);
  const queue = [idOf(id)];
  while (queue.length) {
    for (const child of children.get(queue.pop()) ?? []) {
      if (ids.has(child)) continue;
      ids.add(child);
      queue.push(child);
    }
  }
  return ids;
}

/** The last row of a subtree, as an index into `rows` — where "after this branch" is. */
export function endOfBranch(rows, id) {
  const branch = subtreeOf(rows, id);
  let last = rows.findIndex((row) => idOf(row._id) === idOf(id));
  for (let i = last; i < rows.length; i += 1) {
    if (branch.has(idOf(rows[i]._id))) last = i;
  }
  return last;
}

/**
 * The one primitive behind every rearrangement.
 *
 * Drag, ▲▼, indent and outdent are all "put this branch before / after / inside that row". Writing
 * them as one function is what stops four interactions from disagreeing about edge cases — a branch
 * moved into itself, a step whose new parent is its own child, the position of a heading's children.
 *
 * Returns the whole tree in reading order, which is what the server's order endpoint takes: one
 * request describes the arrangement, so nothing can half-apply.
 */
export function relocate(rows, dragId, targetId, zone) {
  if (idOf(dragId) === idOf(targetId)) return null;
  const branch = subtreeOf(rows, dragId);
  /* Dropping a heading inside its own child would make a ring. */
  if (branch.has(idOf(targetId))) return null;

  const moving = rows.filter((row) => branch.has(idOf(row._id)));
  const rest = rows.filter((row) => !branch.has(idOf(row._id)));
  const target = rows.find((row) => idOf(row._id) === idOf(targetId));
  if (!target) return null;

  const parent = zone === 'inside' ? idOf(targetId) : idOf(target.parent);
  const at =
    zone === 'before'
      ? rest.findIndex((row) => idOf(row._id) === idOf(targetId))
      : endOfBranch(rest, targetId) + 1;

  /* Only the branch's root changes parent; everything under it keeps its own. */
  const relocated = moving.map((row, index) =>
    index === 0 ? { ...row, parent: parent || null } : row
  );
  return [...rest.slice(0, at), ...relocated, ...rest.slice(at)];
}

/**
 * Rows matching a filter, plus every ancestor of a match.
 *
 * Ancestors are kept because a step without its section is not an answer: "crt.sh" on its own does
 * not say which question it was answering. Descendants of a match are dropped unless they match too,
 * so filtering to `nmap` shows the nmap steps rather than everything under their section.
 */
export function filterRows(rows, { text, tool, phase, status, flag }) {
  const needle = text.trim().toLowerCase();
  if (!needle && !tool && !phase && !status && !flag) return rows;

  const matches = (row) => {
    if (needle) {
      /*
       * `outputPreview` rather than the output: the tree is fetched without it. The first lines are
       * where a tool says what it is and what it was pointed at, which is what somebody typing in
       * this box is usually after — and the alternative was sending 1.44MB so that a text box could
       * search it.
       */
      const haystack = [row.title, row.tool, row.target, row.command, row.outputPreview, row.summary]
        .map((value) => String(value ?? '').toLowerCase())
        .join(' ');
      if (!haystack.includes(needle)) return false;
    }
    if (tool && String(row.tool ?? '') !== tool) return false;
    if (phase && String(row.phase ?? '') !== phase) return false;
    if (status && String(row.status ?? '') !== status) return false;
    /* Counted by the server, for the same reason. */
    if (flag === 'output' && !row.hasOutput) return false;
    if (flag === 'finding' && !(row.findings ?? []).length) return false;
    if (flag === 'table' && !row.hasTable) return false;
    if (flag === 'notes' && !row.noteCount) return false;
    /* Steps whose output is over a week old, which is what a retest wants to see first. */
    if (flag === 'stale' && !row.outputStale) return false;
    return true;
  };

  const byId = new Map(rows.map((row) => [idOf(row._id), row]));
  const keep = new Set();
  for (const row of rows) {
    if (!matches(row)) continue;
    keep.add(idOf(row._id));
    let cursor = idOf(row.parent);
    while (cursor && byId.has(cursor) && !keep.has(cursor)) {
      keep.add(cursor);
      cursor = idOf(byId.get(cursor).parent);
    }
  }
  return rows.filter((row) => keep.has(idOf(row._id)));
}

/** Hostnames a person might want to add to scope, offered from the output for them to pick. */
export function hostCandidates(step) {
  const text = `${step?.output ?? ''}\n${step?.target ?? ''}`;
  const found = new Set();
  for (const match of text.matchAll(/(?:https?:\/\/)?((?:[a-z0-9_*-]+\.)+[a-z]{2,})/gi)) {
    const host = match[1].toLowerCase().replace(/\.$/, '');
    /* A version string reads like a hostname; a bare TLD is not an asset. */
    if (/^\d+(\.\d+)+$/.test(host)) continue;
    if (host.split('.').length < 2) continue;
    found.add(host);
  }
  return [...found].sort();
}

/* ------------------------------------------------------------- the component -- */

/**
 * How the ground was mapped — a red team engagement's Enumeration tab.
 *
 * A tree rather than a list, because that is how the work is organised: "Subdomain Enumeration" is
 * a heading and the six tools under it are the things that were run. A flat list loses the one
 * thing a reader needs, which is that those six were answering the same question.
 *
 * Unlike Notes, this is reportable — `{{#enumeration}}` walks it in exactly the order shown here.
 * That is the whole reason the tab exists rather than being another scratchpad.
 */
/**
 * `layout` decides the shape, not the behaviour.
 *
 *   tab   — a card beside a card, inside the engagement's tab bar. Fine for a dozen rows.
 *   page  — the workbench at /engagements/:id/enumeration: full height, a resizable tree pane and
 *           a scrolling editor. What a real operation's enumeration actually needs.
 *
 * One component for both, because everything that is hard here — the tree walk, the drag, the
 * conflict handling, eight actions — must not exist twice.
 */
