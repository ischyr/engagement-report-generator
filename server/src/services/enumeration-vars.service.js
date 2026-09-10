/**
 * Engagement variables, so a command is written once and stays right.
 *
 * Every command in an enumeration names the same three or four things — the domain, the wordlist,
 * the output directory — and before this they were typed into each one. Changing the target meant
 * editing thirty commands, which nobody does, so the commands in the report slowly stopped matching
 * what was actually run.
 *
 * The stored command keeps its `$TARGET`; resolving happens on the way out. That is the whole point:
 * one edit to the variable updates every command, in the tab and in the document, and the authored
 * text stays the thing somebody can reason about.
 */

/**
 * What a variable may be called.
 *
 * Upper case and underscores only, because a command line is full of `$` and the ones this should
 * touch have to be unmistakable. `$1`, `$?`, `$HOME` and `$(date)` are shell, not ours — the first
 * two fail the pattern, and `HOME` only resolves if somebody deliberately defined it.
 */
export const VAR_NAME = /^[A-Z][A-Z0-9_]{0,39}$/;

/** `$NAME` or `${NAME}`. The braces exist for `${TARGET}s` — a name followed by a letter. */
const REFERENCE = /\$\{([A-Z][A-Z0-9_]{0,39})\}|\$([A-Z][A-Z0-9_]{0,39})\b/g;

const asMap = (vars) => {
  const map = new Map();
  for (const entry of vars ?? []) {
    const name = String(entry?.name ?? '').trim();
    if (VAR_NAME.test(name)) map.set(name, String(entry?.value ?? ''));
  }
  return map;
};

/**
 * The text with its variables filled in.
 *
 * An unknown name is left exactly as written rather than blanked. A command that still says
 * `$WORDLIST` is visibly unfinished; one where the word silently vanished is a command that looks
 * complete and is not — and that difference is the whole reason to be careful here.
 */
export function resolveVars(text, vars) {
  const map = asMap(vars);
  if (!map.size) return String(text ?? '');
  return String(text ?? '').replace(REFERENCE, (whole, braced, bare) => {
    const name = braced ?? bare;
    return map.has(name) ? map.get(name) : whole;
  });
}

/** Every variable the text refers to, in the order it first mentions them. */
export function varsUsedIn(text) {
  const seen = [];
  for (const match of String(text ?? '').matchAll(REFERENCE)) {
    const name = match[1] ?? match[2];
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Names the shell owns, which are not this feature's business.
 *
 * `echo $HOME` in a command is correct and complete, and warning that HOME is undefined would be
 * noise that teaches people to ignore the warning. Only the *warning* skips them: somebody who
 * deliberately defines HOME as a variable still gets it resolved, because that was a choice.
 */
const SHELL_OWNED = new Set([
  'HOME', 'PATH', 'PWD', 'OLDPWD', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR',
  'RANDOM', 'HOSTNAME', 'EDITOR', 'PAGER', 'IFS', 'PS1', 'UID', 'EUID', 'BASH', 'SHLVL',
]);

/** The ones it refers to that are not defined — what the editor warns about. */
export function missingVars(text, vars) {
  const map = asMap(vars);
  return varsUsedIn(text).filter((name) => !map.has(name) && !SHELL_OWNED.has(name));
}

export default resolveVars;
