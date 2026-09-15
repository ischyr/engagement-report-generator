/**
 * Naming a paste nobody stopped to name.
 *
 * An unfiled step exists because somebody had output and no time to decide where it went. Asking
 * them for a title in the same breath would put the decision straight back, so the title is taken
 * from the output — and the first line of tool output is very often exactly the right one, because
 * tools announce themselves:
 *
 *     Starting Nmap 7.94 ( https://nmap.org ) at 2026-09-15 14:02 CEST
 *     [INF] Current httpx version v1.6.0
 *     Gobuster v3.6
 *
 * A name it can be recognised by in a tray, not a name for a report — the whole point of the tray
 * is that these get read back and retitled when they are filed.
 */

/** Lines that say nothing about what produced them. */
const NOISE = /^[\s\-=_*#~|+.]*$/;

/**
 * The tool, if the line names one it announces itself with.
 *
 * A short list rather than a clever one: these are the lines the tools this trade uses actually
 * print, and a guess that is wrong is worse than a first line quoted verbatim — which is always
 * defensible, because it is what the output says.
 */
const ANNOUNCES = [
  /\b(nmap)\b/i,
  /\b(httpx)\b/i,
  /\b(nuclei)\b/i,
  /\b(gobuster)\b/i,
  /\b(ffuf)\b/i,
  /\b(subfinder)\b/i,
  /\b(amass)\b/i,
  /\b(masscan)\b/i,
  /\b(sqlmap)\b/i,
  /\b(nikto)\b/i,
  /\b(testssl)\b/i,
  /\b(wpscan)\b/i,
  /\b(crackmapexec|netexec|nxc)\b/i,
  /\b(bloodhound)\b/i,
  /\b(responder)\b/i,
];

/** The longest a derived title may be. The schema allows 200; a tray row shows far less. */
export const TITLE_MAX = 120;

/**
 * A title for a piece of pasted output.
 *
 * @param {string} output
 * @param {Date} [now] only for tests
 * @returns {{title: string, tool: string}}
 */
export function titleFromOutput(output, now = new Date()) {
  const lines = String(output ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !NOISE.test(line));

  if (!lines.length) {
    /*
     * Nothing usable, which happens: a paste of whitespace, or of something the trimming took
     * apart. A timestamp is a poor title and an honest one, and it still sorts.
     */
    return { title: `Pasted ${now.toISOString().slice(0, 16).replace('T', ' ')}`, tool: '' };
  }

  const first = lines[0];

  /* A tool that names itself in the first few lines — banners are not always line one. */
  let tool = '';
  for (const line of lines.slice(0, 5)) {
    for (const pattern of ANNOUNCES) {
      const found = pattern.exec(line);
      if (found) {
        tool = found[1].toLowerCase();
        break;
      }
    }
    if (tool) break;
  }

  /*
   * The first line, whatever it is. Not the tool name on its own: "nmap" is a worse title than
   * the line that says which nmap and when, and the line is what the operator will recognise.
   */
  const title = first.length > TITLE_MAX ? `${first.slice(0, TITLE_MAX - 1).trimEnd()}…` : first;
  return { title, tool };
}

export default titleFromOutput;
