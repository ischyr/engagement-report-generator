import { useMemo, useState } from 'react';
import { Check, ChevronDown, ChevronUp, ListChecks, Plus, Save, Trash2 } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useUnsavedWork } from '../../context/UnsavedContext.jsx';
import { isHtmlEmpty } from '../../lib/utils.js';
import { announceMentions } from '../../lib/mentions.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import ConflictDialog from '../ui/ConflictDialog.jsx';
import { EmptyState } from '../ui/Feedback.jsx';
import { Badge } from '../ui/Badge.jsx';
import { TagChip } from '../ui/Misc.jsx';
import { RichTextEditor } from '../editor/RichTextEditor.jsx';

/** One narrative block, saved independently of the others. */
function SectionCard({ section, auditId, editable, onSaved, onDelete, position, onMove }) {
  const toast = useToast();
  const [text, setText] = useState(section.text ?? '');
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [conflict, setConflict] = useState(null);

  const dirty = text !== (section.text ?? '');
  useUnsavedWork(dirty, `The "${section.name}" section`);

  const save = async ({ force = false } = {}) => {
    setSaving(true);
    try {
      const saved = await api.put(`/audits/${auditId}/sections/${section._id}`, {
        text,
        // Refuses the write if someone else has written in this section meanwhile.
        ...(section.updatedAt && !force ? { expectedUpdatedAt: section.updatedAt } : {}),
      });
      announceMentions(toast, saved);
      setSavedAt(Date.now());
      setConflict(null);
      onSaved?.();
      toast.success(`${section.name} saved`);
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  const takeTheirs = () => {
    if (conflict?.text !== undefined) setText(conflict.text ?? '');
    setConflict(null);
    onSaved?.();
    toast.info('Loaded the saved version', 'Your unsaved changes were discarded.');
  };

  return (
    <Card>
      <CardHeader
        title={section.name}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            <span>Insert in your template with</span>
            <TagChip tag={`sections.${section.field}.rich.text`} prefix="@" />
          </span>
        }
        actions={
          <div className="flex items-center gap-2">
            {/*
              Where this section sits, and how to move it.

              Up and down rather than dragging, to match how findings reorder — one gesture for
              "change the order" across the app beats two, and a card holding a rich-text editor
              is a poor drag handle anyway.
            */}
            {editable && position ? (
              <span className="flex items-center gap-1">
                <span className="font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                  {position.index + 1}/{position.total}
                </span>
                <span className="flex flex-col">
                  <button
                    type="button"
                    disabled={position.index === 0 || position.busy}
                    onClick={() => onMove?.(-1)}
                    aria-label={`Move ${section.name} earlier`}
                    title="Move earlier"
                    className="rounded p-0.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg disabled:opacity-25"
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="button"
                    disabled={position.index === position.total - 1 || position.busy}
                    onClick={() => onMove?.(1)}
                    aria-label={`Move ${section.name} later`}
                    title="Move later"
                    className="rounded p-0.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg disabled:opacity-25"
                  >
                    <ChevronDown size={13} />
                  </button>
                </span>
              </span>
            ) : null}
            {isHtmlEmpty(text) ? (
              <Badge tone="neutral">Empty</Badge>
            ) : (
              <Badge tone="success" icon={Check}>
                Written
              </Badge>
            )}
            {editable ? (
              <>
                <Button
                  variant={dirty ? 'primary' : 'ghost'}
                  size="sm"
                  icon={Save}
                  loading={saving}
                  disabled={!dirty}
                  onClick={() => save()}
                >
                  {dirty ? 'Save' : savedAt ? 'Saved' : 'No changes'}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  icon={Trash2}
                  title="Remove this section"
                  className="hover:text-crit"
                  onClick={() => onDelete?.(section)}
                />
              </>
            ) : null}
          </div>
        }
      />
      <CardBody>
        <RichTextEditor
          value={text}
          onChange={setText}
          editable={editable}
          minHeight={200}
          placeholder={`Write the ${section.name.toLowerCase()}…`}
        />
      </CardBody>

      <ConflictDialog
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onDiscard={takeTheirs}
        onOverwrite={() => save({ force: true })}
        label={`the “${section.name}” section`}
        current={conflict}
        loading={saving}
      />
    </Card>
  );
}

function AddSectionModal({ open, onClose, auditId, existingFields, onAdded }) {
  const toast = useToast();
  const definitions = useResource(open ? '/data/sections' : null, { initial: [] });
  const [adding, setAdding] = useState(null);

  const available = useMemo(
    () => (definitions.data ?? []).filter((d) => !existingFields.includes(d.field)),
    [definitions.data, existingFields]
  );

  const add = async (definition) => {
    setAdding(definition.field);
    try {
      await api.post(`/audits/${auditId}/sections`, {
        field: definition.field,
        name: definition.name,
        text: '',
      });
      toast.success(`${definition.name} added`);
      onAdded?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setAdding(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add a report section"
      description="Section types are defined once under Clients & Data, then reused across engagements."
      size="md"
    >
      {available.length === 0 ? (
        <EmptyState
          icon={ListChecks}
          title="Every section is already here"
          description="Define more section types under Clients & Data if you need additional narrative blocks."
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {available.map((definition) => (
            <li key={definition.field}>
              <button
                type="button"
                disabled={Boolean(adding)}
                onClick={() => add(definition)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/5 disabled:opacity-50"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-fg">{definition.name}</span>
                  <span className="block truncate font-mono text-[0.6875rem] text-fg-subtle">
                    {definition.field}
                  </span>
                </span>
                <Plus size={15} className="shrink-0 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export default function SectionsTab({ audit, editable, onReload }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [reordering, setReordering] = useState(false);

  const sections = audit.sections ?? [];
  const written = sections.filter((s) => !isHtmlEmpty(s.text)).length;

  /**
   * Moves one section past its neighbour.
   *
   * The whole order is sent rather than "this one moved": the server takes an order and applies
   * it, so two people reordering at once end with one of the two orders rather than an
   * interleaving neither of them asked for.
   */
  const move = async (index, direction) => {
    const next = [...sections];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setReordering(true);
    try {
      await api.put(`/audits/${audit._id}/sections-order`, {
        order: next.map((section) => section._id),
      });
      await onReload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setReordering(false);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/audits/${audit._id}/sections/${pendingDelete._id}`);
      toast.success('Section removed');
      setPendingDelete(null);
      await onReload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          {sections.length === 0
            ? 'No sections yet.'
            : `${written} of ${sections.length} section${sections.length === 1 ? '' : 's'} written.`}
          {sections.length > 1 ? (
            <span className="ml-1.5 text-fg-subtle">
              This order is the order a template’s {'{{#sections}}'} loop reads them in.
            </span>
          ) : null}
        </p>
        {editable ? (
          <Button variant="secondary" size="sm" icon={Plus} onClick={() => setAdding(true)}>
            Add section
          </Button>
        ) : null}
      </div>

      {sections.length === 0 ? (
        <Card>
          <EmptyState
            icon={ListChecks}
            title="No narrative sections"
            description="Sections hold the prose parts of the report — executive summary, methodology, conclusion. Each one gets its own placeholder in your template."
            actionLabel={editable ? 'Add section' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => setAdding(true) : undefined}
          />
        </Card>
      ) : (
        <div className="flex flex-col gap-5">
          {sections.map((section, index) => (
            <SectionCard
              key={section._id}
              section={section}
              auditId={audit._id}
              editable={editable}
              position={{ index, total: sections.length, busy: reordering }}
              onMove={(direction) => move(index, direction)}
              onSaved={() => onReload({ quiet: true })}
              onDelete={setPendingDelete}
            />
          ))}
        </div>
      )}

      <AddSectionModal
        open={adding}
        onClose={() => setAdding(false)}
        auditId={audit._id}
        existingFields={sections.map((s) => s.field)}
        onAdded={() => onReload({ quiet: true })}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Remove this section?"
        confirmLabel="Remove"
        message={`"${pendingDelete?.name}" and anything written in it will be removed from this engagement.`}
      />
    </div>
  );
}
