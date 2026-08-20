import { useMemo, useState } from 'react';
import { Combine } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { htmlToSnippet } from '../../lib/utils.js';
import { calculateCvss } from '../../lib/cvss.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { SeverityBadge } from '../ui/Badge.jsx';
import { SearchInput } from '../ui/Misc.jsx';

/**
 * Folding one finding into another.
 *
 * Two testers on one engagement write the same issue under two names — "IDOR on document download"
 * and "missing authorisation on /documents" — and it is normally noticed while assembling the report,
 * which is both the worst moment and the one where somebody quietly deletes an hour of writing to
 * tidy up. Merging keeps both halves: the text is concatenated with a rule between them, the
 * references are unioned, and the higher severity wins.
 *
 * The candidate list is ordered by how similar the titles are, so the finding somebody is looking for
 * is usually the first one — the same idea as the template playground's "did you mean", and for the
 * same reason: the whole list is not the answer, the closest one is.
 */

/** Levenshtein, on short strings, for ordering candidates by resemblance. */
function distance(a, b) {
  if (a === b) return 0;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/** 0 to 1, so titles of different lengths compare fairly. */
const similarity = (a, b) => {
  const left = String(a ?? '').toLowerCase();
  const right = String(b ?? '').toLowerCase();
  if (!left || !right) return 0;
  return 1 - distance(left, right) / Math.max(left.length, right.length);
};

export default function MergeFindingDialog({ open, onClose, auditId, target, findings, onMerged }) {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [chosen, setChosen] = useState(null);
  const [titleChoice, setTitleChoice] = useState('keep');
  const [merging, setMerging] = useState(false);

  const candidates = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (findings ?? [])
      .filter((finding) => String(finding._id) !== String(target?._id))
      .filter((finding) => !needle || (finding.title ?? '').toLowerCase().includes(needle))
      .map((finding) => ({ finding, score: similarity(finding.title, target?.title) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 40);
  }, [findings, target, search]);

  const merge = async () => {
    if (!chosen) return;
    setMerging(true);
    try {
      const result = await api.post(`/audits/${auditId}/findings/${target._id}/merge`, {
        from: chosen._id,
        title: titleChoice,
      });
      toast.success(
        'Merged',
        `“${result.mergedTitle}” was folded in and can be restored for ${result.restorableForDays} days.`
      );
      onMerged?.(result.finding);
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setMerging(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Merge another finding into this one"
      description={`Both write-ups are kept: the text is joined with a rule between them, the references are combined, and the higher severity wins. The other finding goes to the trash, where it can be restored.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={merging}>
            Cancel
          </Button>
          <Button variant="primary" icon={Combine} disabled={!chosen} loading={merging} onClick={merge}>
            {chosen ? 'Merge them' : 'Choose a finding'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-fg-muted">
          Keeping <span className="font-medium text-fg">“{target?.title}”</span>. Ordered by how
          closely the titles match.
        </p>

        <SearchInput value={search} onChange={setSearch} placeholder="Search this engagement's findings…" />

        <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {candidates.length === 0 ? (
            <li className="px-2 py-6 text-center text-sm text-fg-muted">
              Nothing else to merge into this one.
            </li>
          ) : (
            candidates.map(({ finding, score }) => {
              const cvss = calculateCvss(finding.cvssv3);
              const picked = chosen?._id === finding._id;
              return (
                <li key={finding._id}>
                  <button
                    type="button"
                    onClick={() => setChosen(picked ? null : finding)}
                    className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left ring-1 transition ${
                      picked ? 'bg-brand-500/12 ring-brand-400' : 'ring-transparent hover:bg-white/5'
                    }`}
                  >
                    <SeverityBadge
                      severity={cvss.baseSeverity}
                      score={cvss.baseScore}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{finding.title}</span>
                      <span className="mt-0.5 block truncate text-xs text-fg-subtle">
                        {htmlToSnippet(finding.description, 100) || 'No description'}
                      </span>
                    </span>
                    {/* Only when it is worth remarking on; every list would otherwise carry a number
                        nobody asked for. */}
                    {score > 0.6 ? (
                      <span className="mt-0.5 shrink-0 rounded-full bg-med/15 px-2 py-0.5 text-[0.625rem] text-med">
                        similar title
                      </span>
                    ) : null}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        {chosen ? (
          <div className="flex flex-col gap-2 rounded-xl bg-canvas/40 p-3 ring-1 ring-line">
            <p className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
              Which title survives
            </p>
            {[
              ['keep', target?.title],
              ['take', chosen.title],
            ].map(([value, label]) => (
              <label key={value} className="flex cursor-pointer items-start gap-2.5 text-sm text-fg">
                <input
                  type="radio"
                  name="merge-title"
                  checked={titleChoice === value}
                  onChange={() => setTitleChoice(value)}
                  className="mt-1 accent-brand-500"
                />
                <span className="min-w-0 flex-1 truncate">{label}</span>
              </label>
            ))}
            <p className="text-xs text-fg-subtle">
              The other title is recorded in the merged description, so this write-up can still be
              found under the name somebody remembers.
            </p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
