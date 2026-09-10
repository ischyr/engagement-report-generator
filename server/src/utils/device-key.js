/**
 * A stable name for the browser a session came from.
 *
 * The raw user-agent string cannot answer "have I seen this device before": Chrome bumps its
 * version every few weeks, so comparing the whole string would call every sign-in unfamiliar
 * and the warning would be worth nothing within a month.
 *
 * So this reduces it to the parts that identify a *machine and browser* rather than a build:
 * the browser family and the platform. Two different laptops running the same Chrome on the
 * same Windows version therefore look alike — which is the right way round for a warning. A
 * false "this is familiar" is a missed notice; a false "this is new" trains people to ignore
 * the notice altogether, which is worse.
 *
 * Never used for authentication. It is a label for a human to recognise, and every byte of it
 * is client-controlled.
 */

const BROWSERS = [
  // Order matters: Edge and Opera both claim to be Chrome, and Chrome claims to be Safari.
  [/\bEdg(?:e|A|iOS)?\//, 'Edge'],
  [/\bOPR\/|\bOpera\b/, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/\bcurl\//, 'curl'],
  [/\bnode\b|\bundici\b|\baxios\b/i, 'a script'],
];

const PLATFORMS = [
  [/Windows NT 10\.0/, 'Windows'],
  [/Windows/, 'Windows'],
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/CrOS/, 'ChromeOS'],
  [/Linux/, 'Linux'],
];

const match = (list, agent, fallback) => {
  for (const [pattern, name] of list) if (pattern.test(agent)) return name;
  return fallback;
};

/**
 * @param {string} userAgent
 * @returns {{key: string, label: string}} `key` for comparison, `label` for a person to read
 */
export function describeDevice(userAgent) {
  const agent = String(userAgent ?? '').trim();
  if (!agent) return { key: 'unknown', label: 'an unidentified browser' };

  const browser = match(BROWSERS, agent, 'a browser');
  const platform = match(PLATFORMS, agent, 'an unknown platform');
  return {
    key: `${browser}|${platform}`.toLowerCase(),
    label: `${browser} on ${platform}`,
  };
}

export default describeDevice;
