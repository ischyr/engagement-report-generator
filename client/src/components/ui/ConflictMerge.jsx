import { useMemo, useState } from 'react';
import { AlertTriangle, Check } from 'lucide-react';

import { displayName, formatDateTime, htmlToSnippet } from '../../lib/utils.js';
import { Modal } from './Modal.jsx';
import { Button } from './Button.jsx';

/**
 * Resolving a save conflict field by field, rather than choosing a whole version.
 *
 * The old dialog offered three things: keep editing, discard mine, overwrite theirs. On a shared
 * finding that is nearly always the wrong shape, because two people working on the same write-up are
 * usually in *different fields* — one wrote the impact while the other wrote the remediation. Both
 * remaining choices threw away a paragraph somebody had just typed.
 *
 * So this is a three-way merge. It knows the version that was loaded, the version on screen, and the
 * version the server refused over, which is enough to sort every field into one of three cases:
 * only they changed it (take theirs), only I changed it (keep mine), or both did (ask). Almost always
 * the third set is empty or has one field in it, and what was a lost paragraph becomes a click.
 *
 * @param {object} props
 * @param {Array<{key: string, label: string, rich?: boolean}>} props.fields Which fields to compare.
 * @param {object} props.base The version that was loaded — the common ancestor.
 * @param {object} props.mine What is on screen.
 * @param {object} props.theirs What the server holds.
 * @param {(merged: object) => void} props.onMerge Called with the field values to save.
 */

/** What a value looks like in a chooser: readable, short, and never blank-looking when it is set. */
function preview(value, rich) {
  if (value === null || value === undefined || value === '') return '(empty)';
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(none)';
  if (rich) {
    const text = htmlToSnippet(String(value), 160);
    return text || '(empty)';
  }
  return String(value);
}

/** Compared as text, because that is what "did this change" means for every field here. */
const same = (a, b) => {
  const normalise = (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join('\n');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };
  return normalise(a) === normalise(b);
};

export default function ConflictMerge({
  open,
  onClose,
  onMerge,
  onOverwrite,
  label = 'this item',
  fields,
  base,
  mine,
  theirs,
  loading = false,
}) {
  const analysis = useMemo(() => {
    const clashes = [];
    const merged = {};
    const auto = { mine: [], theirs: [] };

    for (const field of fields) {
      const ours = mine?.[field.key];
      const yours = theirs?.[field.key];
      const original = base?.[field.key];

      if (same(ours, yours)) {
        merged[field.key] = ours;
        continue;
      }
      if (same(ours, original)) {
        // We never touched it; their edit stands.
        merged[field.key] = yours;
        auto.theirs.push(field.label);
        continue;
      }
      if (same(yours, original)) {
        // They never touched it; ours stands.
        merged[field.key] = ours;
        auto.mine.push(field.label);
        continue;
      }
      clashes.push(field);
    }
    return { clashes, merged, auto };
  }, [fields, base, mine, theirs]);

  // Default a real clash to theirs: the version on the server is the one other people can already
  // see, so keeping it is the choice that surprises nobody.
  const [choices, setChoices] = useState({});
  const choiceFor = (key) => choices[key] ?? 'theirs';

  const editor = theirs?.updatedBy ?? theirs?.author ?? null;
  const when = theirs?.updatedAt ? formatDateTime(theirs.updatedAt) : null;

  const merge = () => {
    const result = { ...analysis.merged };
    for (const field of analysis.clashes) {
      result[field.key] = choiceFor(field.key) === 'mine' ? mine?.[field.key] : theirs?.[field.key];
    }
    onMerge(result);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Someone else got there first"
      description={
        editor
          ? `${displayName(editor)} saved ${label}${when ? ` at ${when}` : ''} while you were editing.`
          : `${label} changed on the server while you were editing.`
      }
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onOverwrite} disabled={loading}>
            Overwrite theirs
          </Button>
          <Button variant="primary" onClick={merge} loading={loading}>
            {analysis.clashes.length ? 'Save the merge' : 'Merge and save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {analysis.auto.mine.length || analysis.auto.theirs.length ? (
          <div className="flex flex-col gap-1.5 rounded-lg bg-low/8 p-3 text-xs ring-1 ring-low/20">
            <p className="flex items-center gap-2 font-medium text-fg">
              <Check size={13} className="text-low" />
              Merged without asking
            </p>
            {analysis.auto.mine.length ? (
              <p className="text-fg-muted">
                Kept yours, because they did not touch it:{' '}
                <span className="text-fg">{analysis.auto.mine.join(', ')}</span>
              </p>
            ) : null}
            {analysis.auto.theirs.length ? (
              <p className="text-fg-muted">
                Took theirs, because you did not touch it:{' '}
                <span className="text-fg">{analysis.auto.theirs.join(', ')}</span>
              </p>
            ) : null}
          </div>
        ) : null}

        {analysis.clashes.length === 0 ? (
          <p className="text-sm leading-relaxed text-fg-muted">
            Nothing actually clashes — you each changed different things. Saving the merge keeps both
            sets of edits.
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            <p className="flex items-start gap-2 text-sm leading-relaxed text-fg-muted">
              <AlertTriangle size={14} className="mt-0.5 shrink-0 text-med" />
              You both changed{' '}
              {analysis.clashes.length === 1 ? 'this field' : `these ${analysis.clashes.length} fields`}.
              Only one version can survive each one.
            </p>
            {analysis.clashes.map((field) => (
              <div key={field.key} className="rounded-xl bg-canvas/40 p-3 ring-1 ring-line">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                  {field.label}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {[
                    ['mine', 'Yours', mine?.[field.key]],
                    ['theirs', 'Theirs', theirs?.[field.key]],
                  ].map(([side, sideLabel, value]) => (
                    <button
                      key={side}
                      type="button"
                      onClick={() => setChoices((current) => ({ ...current, [field.key]: side }))}
                      className={`flex flex-col gap-1 rounded-lg p-2.5 text-left ring-1 transition ${
                        choiceFor(field.key) === side
                          ? 'bg-brand-500/12 ring-brand-400'
                          : 'ring-line hover:bg-white/5'
                      }`}
                    >
                      <span className="flex items-center gap-1.5 text-xs font-medium text-fg">
                        {choiceFor(field.key) === side ? (
                          <Check size={12} className="text-brand-300" />
                        ) : null}
                        {sideLabel}
                      </span>
                      <span className="line-clamp-4 whitespace-pre-wrap text-xs text-fg-muted">
                        {preview(value, field.rich)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="text-xs leading-relaxed text-fg-subtle">
          Nothing has been saved yet. “Overwrite theirs” writes your whole copy over the stored one,
          including the fields they changed.
        </p>
      </div>
    </Modal>
  );
}
