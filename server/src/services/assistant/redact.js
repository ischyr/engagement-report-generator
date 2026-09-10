/**
 * What is taken out before anything leaves this machine.
 *
 * The assistant is the first feature in this app that sends a client's material to somebody else's
 * computer, and the material in question is a penetration test. A finding's proof of concept holds
 * the working exploit; an enumeration step's output holds whatever the tool printed, which on a
 * real engagement is session cookies, hashes out of a dump, an API key somebody left in a header,
 * and the password that worked. None of that helps write a summary, and all of it is the thing you
 * would least like to have posted to an endpoint an administrator typed into a settings form.
 *
 * So there are two defences, and this file is the second one.
 *
 * The first is that the proof of concept is never sent at all — the same decision, for the same
 * reason, as `share.service.js` refusing to show it to the client. Whole fields are excluded by
 * name in `jobs.js`, which is a whitelist and cannot be defeated by a pattern that did not match.
 *
 * The second is this: the text that *is* sent — tool output, a description, a remediation — is run
 * through a small set of patterns for the shapes secrets actually take, and each hit is replaced
 * with a marker naming what it was. The count comes back with the answer and is shown to the person
 * who asked, because "14 secrets were removed before this was sent" is the only honest way to tell
 * somebody what left the building.
 *
 * This is not a guarantee and is not written as though it were. A pattern list cannot recognise a
 * password that looks like an English word, and nothing here would spot a customer's name. It is a
 * floor, not a ceiling: the ceiling is that the whole feature is off until somebody switches it on,
 * per job, and refuses to touch a restricted engagement unless that is explicitly allowed too.
 */

/**
 * The shapes, narrowest first.
 *
 * Deliberately tight. An over-eager pattern that eats every long word costs the summary its
 * meaning and teaches people to switch redaction off, which is worse than the leak it prevented.
 * Everything here is anchored on a keyword, a known prefix, or a structure — never on "looks
 * random", because on a page of tool output almost everything does.
 */
const PATTERNS = [
  {
    kind: 'private key',
    /* The whole armoured block, not just the header: half a key is still a key. */
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  {
    kind: 'authorization header',
    re: /\b(authorization|proxy-authorization)\s*[:=]\s*["']?(basic|bearer|negotiate|ntlm|digest)\s+[^\s"'&;]+/gi,
  },
  {
    kind: 'cookie',
    re: /\b(cookie|set-cookie)\s*[:=]\s*[^\r\n]{8,}/gi,
  },
  {
    kind: 'json web token',
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{6,}/g,
  },
  {
    kind: 'api key',
    /* The prefixes that identify themselves: nothing else looks like these. */
    re: /\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{30,})/g,
  },
  {
    kind: 'password',
    /*
     * `password=hunter2`, `"pass": "hunter2"`, `pwd: hunter2`.
     *
     * Stops at whitespace, a quote or a shell separator, so it takes the value and not the rest
     * of the command — the rest of the command is exactly what makes the step readable.
     *
     * A separator is required. Without one this would also eat the sentence "the password was
     * weak" out of a finding's description, which is the kind of over-reach that gets a redactor
     * switched off. The space-separated form has its own pattern below, anchored on a flag.
     */
    re: /\b(passwo?r?d|passwd|pwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*["']?\s*[:=]\s*["']?([^\s"'&;,}\]]{3,})/gi,
    /* Keep the name, drop the value: "password=<removed>" still tells the reader what was there. */
    replace: (match, name) => `${name}=<${'removed'}>`,
  },
  {
    kind: 'password on the command line',
    /*
     * `-p Summer2024!`, `--password 'hunter2'`, `-P hunter2`.
     *
     * The shape a pentest command actually takes, and the one the pattern above cannot see because
     * there is no separator to anchor on. A flag is required, which is what keeps it away from
     * ordinary prose — and the flag itself is kept, so the step still reads as a command somebody
     * ran rather than a mystery.
     *
     * `-u` and `-H` are deliberately not here: a username is not a secret, and losing it costs the
     * step its meaning, while `-H` is a header on half the curl invocations ever written.
     *
     * Whitespace only, never `=`: the pattern above has already dealt with `--password=x`, and
     * letting this one match it as well would redact the marker the first one left behind.
     *
     * And `-p 80,443` is nmap asking for ports, not a password — the one collision that matters,
     * because it is on half the enumeration steps in the app. A value that is only digits, commas
     * and dashes is left alone, which does mean a numeric password on `-p` survives. That is the
     * right way round: a redactor that mangles every port list is one people switch off, and the
     * shape it lets through is rare enough to name here rather than pretend away.
     */
    re: /(^|\s)(--?(?:p|P|pw|pass|passwd|password)\b)\s+(["']?)([^\s"']{3,})\3/g,
    replace: (match, lead, flag, quote, value) =>
      /^[\d,\-]+$/.test(value) ? match : `${lead}${flag} <removed>`,
  },
  {
    kind: 'ntlm hash',
    /* The pwdump line: user:rid:lm:nt::: — the one shape a hash dump always takes. */
    re: /^[^\s:]{1,64}:\d+:[a-fA-F0-9]{32}:[a-fA-F0-9]{32}:::.*$/gm,
  },
  {
    kind: 'password hash',
    /* Unix crypt: $6$salt$hash and friends. */
    re: /\$[1256][aby]?\$[^\s:$]{1,64}\$[A-Za-z0-9./]{20,}/g,
  },
  {
    kind: 'credential in a url',
    re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi,
    replace: (match, scheme) => `${scheme}<removed>@`,
  },
];

/**
 * One pass over a piece of text, removing what it recognises.
 *
 * Pure, so the tests can hold it to specific inputs, and so the same function is used for
 * everything that goes out rather than each job growing its own idea of what is safe.
 *
 * @param {string} text
 * @returns {{text: string, removed: number, kinds: string[]}}
 */
export function redact(text) {
  let out = String(text ?? '');
  if (!out) return { text: '', removed: 0, kinds: [] };

  let removed = 0;
  const kinds = [];

  for (const pattern of PATTERNS) {
    let hits = 0;
    out = out.replace(pattern.re, (...args) => {
      const replacement = pattern.replace ? pattern.replace(...args) : `<${pattern.kind} removed>`;
      /*
       * Counted only when something actually changed. A pattern may match and then decide the
       * match was innocent — a port list on `-p` — and reporting "1 secret removed" for a
       * replacement that did not happen would be a lie told to the person who pressed the button.
       */
      if (replacement !== args[0]) hits += 1;
      return replacement;
    });
    if (hits) {
      removed += hits;
      kinds.push(pattern.kind);
    }
  }

  return { text: out, removed, kinds };
}

/**
 * Redaction plus a size limit, which is the pair every caller actually wants.
 *
 * The limit takes the head *and* the tail rather than the first N characters. A tool's output
 * announces itself at the top and concludes at the bottom — "1,412 hosts scanned, 9 up" is the
 * last line, and a naive truncation throws away the sentence the summary is meant to be about.
 *
 * @param {string} text
 * @param {number} budget characters to keep
 */
export function redactAndTrim(text, budget = 12_000) {
  const cleaned = redact(text);
  if (cleaned.text.length <= budget) return { ...cleaned, truncated: false };

  const head = Math.floor(budget * 0.7);
  const tail = budget - head;
  const middle = cleaned.text.length - head - tail;
  return {
    ...cleaned,
    truncated: true,
    text: `${cleaned.text.slice(0, head)}\n\n… ${middle.toLocaleString(
      'en-GB'
    )} characters omitted from the middle …\n\n${cleaned.text.slice(-tail)}`,
  };
}

export default { redact, redactAndTrim };
