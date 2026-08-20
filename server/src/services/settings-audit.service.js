/**
 * Turning two versions of the settings into a record of what somebody changed.
 *
 * Kept out of the route so the diffing and the redaction can be tested on their own, and so
 * that anything else that ever writes settings has one obvious way to record it.
 */

import { SettingsChange } from '../models/settings-change.model.js';

/**
 * Values that must never be written into the log, by dotted path.
 *
 * Empty today — settings hold presentation and policy, and the vault key lives in the
 * environment rather than here. It exists because the *next* setting somebody adds might be a
 * token, and a log that quietly recorded it would be the worst possible place to find out.
 */
const SECRET_PATHS = [/token/i, /secret/i, /password/i, /apiKey/i];

/** Anything longer than this is described rather than quoted. */
const MAX_VALUE = 120;

/**
 * A setting as a short piece of text.
 *
 * The logo is a 300 kB data URI; recording it twice per change would make the log bigger than
 * everything it describes, and nobody reading "who changed the branding" wants base64. So the
 * value is summarised in a way that still answers the question — it changed, and to roughly
 * what.
 */
export function describeValue(path, value) {
  if (SECRET_PATHS.some((pattern) => pattern.test(path))) return '[hidden]';
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (typeof value === 'number') return String(value);

  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text.startsWith('data:image/')) {
    const kb = Math.max(1, Math.round((text.length * 0.75) / 1024));
    return `[image, about ${kb} kB]`;
  }
  if (text.length > MAX_VALUE) return `[${text.length} characters]`;
  return text;
}

/** Plain objects are walked into; everything else is a value. */
const isBranch = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);

/**
 * Every leaf that differs between two settings objects, as dotted paths.
 *
 * Driven by the *incoming* shape, not the stored one: a save sends only the fields the form
 * holds, and walking the stored document instead would report every untouched default as a
 * change the first time anybody pressed Save.
 */
export function diffSettings(before, after, prefix = '') {
  const changes = [];
  for (const [key, next] of Object.entries(after ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    const previous = before?.[key];

    if (isBranch(next)) {
      changes.push(...diffSettings(previous ?? {}, next, path));
      continue;
    }

    // Compared as the text that gets stored, so a change the log cannot express is not
    // recorded as a change — two different 300 kB logos still differ by length or size.
    const from = describeValue(path, previous);
    const to = describeValue(path, next);
    if (from === to) continue;
    changes.push({ path, from, to });
  }
  return changes;
}

/**
 * Records a settings change, unless nothing actually changed.
 *
 * Silent when the diff is empty: the settings form posts every field it holds on every save, so
 * pressing Save with nothing edited is the common case and must not fill the log with entries
 * that say nothing.
 */
export async function recordSettingsChange({ actor, action = 'update', before, after, req }) {
  const changes = action === 'reset' ? [] : diffSettings(before, after);
  if (action !== 'reset' && changes.length === 0) return null;

  return SettingsChange.create({
    actor: actor?._id ?? actor ?? null,
    action,
    changes,
    // Trusted only as a hint: behind a proxy this is whatever the proxy says it is.
    ip: req?.ip ?? '',
  });
}

export default recordSettingsChange;
