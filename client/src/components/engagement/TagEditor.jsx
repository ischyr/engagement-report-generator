import { useState } from 'react';
import { Tag } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import TagPicker from '../ui/TagPicker.jsx';

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

  return (
    <Card>
      <CardHeader
        icon={Tag}
        title="Tags"
        description="Whatever you want to be able to filter on later — the engagement type and client are already filters."
      />
      <CardBody>
        {/* The widget is shared with a finding's own tags — see `TagPicker`. */}
        <TagPicker
          value={tags}
          onChange={write}
          suggestions={known ?? []}
          editable={editable}
          busy={saving}
          empty="None yet. Tags are how you answer questions the other filters cannot — everything PCI this year, everything a partner ran, everything that was a retest."
        />
      </CardBody>
    </Card>
  );
}
