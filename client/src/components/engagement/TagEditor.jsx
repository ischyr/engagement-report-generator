import { useState } from 'react';
import { Tag, X } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Input } from '../ui/Field.jsx';

/**
 * Free labels on an engagement — "red team", "pci", "q3", "subcontracted".
 *
 * Every filter in the app is by client, state or engagement type, so the cross-cutting questions
 * a firm actually asks had no answer at all. Free text rather than a managed vocabulary, because
 * a tag list somebody has to curate is a tag list nobody uses; they are lower-cased on the way in
 * so "PCI" and "pci" cannot both exist.
 */
export default function TagEditor({ audit, editable, onPatch }) {
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  /** Tags already in use elsewhere, so the second engagement spells it the same way. */
  const { data: known } = useResource('/audits/tags', { initial: [] });
  const tags = audit.tags ?? [];

  const write = async (next) => {
    setSaving(true);
    try {
      const updated = await api.put(`/audits/${audit._id}`, { tags: next });
      onPatch?.({ tags: updated.tags ?? next });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const add = (raw) => {
    const tag = String(raw ?? '').trim().toLowerCase();
    if (!tag || tags.includes(tag)) {
      setDraft('');
      return;
    }
    setDraft('');
    write([...tags, tag]);
  };

  const suggestions = (known ?? [])
    .filter((entry) => !tags.includes(entry.tag))
    .filter((entry) => (draft ? entry.tag.includes(draft.trim().toLowerCase()) : true))
    .slice(0, 8);

  return (
    <Card>
      <CardHeader
        icon={Tag}
        title="Tags"
        description="Whatever you want to be able to filter on later — the engagement type and client are already filters."
      />
      <CardBody className="flex flex-col gap-3">
        {tags.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <li key={tag}>
                <span className="inline-flex items-center gap-1 rounded-md bg-brand-500/12 px-2 py-1 text-[0.6875rem] font-medium text-brand-300 ring-1 ring-inset ring-brand-500/25">
                  {tag}
                  {editable ? (
                    <button
                      type="button"
                      aria-label={`Remove the tag ${tag}`}
                      disabled={saving}
                      className="transition hover:text-fg"
                      onClick={() => write(tags.filter((entry) => entry !== tag))}
                    >
                      <X size={11} />
                    </button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs leading-relaxed text-fg-subtle">
            None yet. Tags are how you answer questions the other filters cannot — everything PCI
            this year, everything a partner ran, everything that was a retest.
          </p>
        )}

        {editable ? (
          <>
            <Input
              placeholder="Add a tag and press enter"
              value={draft}
              disabled={saving}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  add(draft);
                }
              }}
            />
            {/* What other engagements already use, so the same idea is not spelled three ways. */}
            {suggestions.length ? (
              <div className="flex flex-wrap gap-1.5">
                {suggestions.map((entry) => (
                  <button
                    key={entry.tag}
                    type="button"
                    disabled={saving}
                    onClick={() => add(entry.tag)}
                    className="rounded-md bg-canvas/60 px-2 py-1 text-[0.625rem] text-fg-muted ring-1 ring-line transition hover:text-fg hover:ring-brand-500/30"
                  >
                    {entry.tag}
                    <span className="ml-1 text-fg-subtle">{entry.count}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </>
        ) : null}
      </CardBody>
    </Card>
  );
}
