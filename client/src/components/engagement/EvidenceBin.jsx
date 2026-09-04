import { useCallback, useRef, useState } from 'react';
import { Highlighter, ImagePlus, Trash2, Upload } from 'lucide-react';

import { api } from '../../lib/api.js';
import { shrinkImage, shrinkImages } from '../../lib/images.js';
import { useAuth } from '../../context/AuthContext.jsx';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { formatBytes, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../ui/Feedback.jsx';
import { ConfirmDialog } from '../ui/Modal.jsx';
import Annotator from '../editor/Annotator.jsx';

/**
 * Evidence captured for an engagement that no finding uses yet.
 *
 * Testing and writing up are different activities and rarely the same hour. Until now a screenshot
 * could only be attached to a finding that already existed, so a tester mid-test had to invent an
 * empty finding to park it in or keep it on the desktop — and the desktop is where evidence goes to
 * be lost. This is the drawer: capture into it all day, caption what is not obvious, and insert it
 * when the write-up happens.
 *
 * Nothing here is a separate store. It is the same GridFS media the findings use, filtered to what
 * this engagement uploaded and nothing references — so an image "leaves" the bin by being used,
 * with no flag to keep in step and nothing to strand it here if some field forgets to clear one.
 *
 * @param {{auditId: string, onInsert?: (item) => void, compact?: boolean}} props
 *   `onInsert` is what makes it useful inside a finding; without it this is a read-only drawer.
 */
export default function EvidenceBin({ auditId, onInsert, compact = false }) {
  const toast = useToast();
  const { canWrite } = useAuth();
  const fileRef = useRef(null);
  const { data, error, loading, reload } = useResource(`/media/bin/${auditId}`, {
    initial: null,
    // Two people capturing during one test is normal; a bin that only updates on reload is not.
    poll: 8_000,
  });
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [editingCaption, setEditingCaption] = useState(null);
  const [captionDraft, setCaptionDraft] = useState('');
  /** The capture being marked up, before anything has used it. */
  const [annotating, setAnnotating] = useState(null);
  const [savingMarks, setSavingMarks] = useState(false);

  const items = data?.items ?? [];

  const upload = useCallback(
    async (files) => {
      const images = [...files].filter((file) => file.type.startsWith('image/'));
      if (!images.length) {
        toast.error('Those are not images');
        return;
      }
      setUploading(true);
      try {
        /*
         * Deliberate and in bulk, so what was done is worth saying — unlike a paste into the
         * editor, where a toast per screenshot would be noise.
         */
        const { files: prepared, changed, saved } = await shrinkImages(images);
        for (const file of prepared) {
          const body = new FormData();
          body.append('file', file, file.name || 'evidence.png');
          // What ties it to the engagement rather than to a finding.
          body.append('audit', auditId);
          await api.post('/media', body);
        }
        toast.success(
          images.length === 1 ? 'Captured' : `${images.length} captured`,
          changed
            ? `${changed === 1 ? 'One was' : `${changed} were`} scaled to what the page can print, saving ${formatBytes(saved)}.`
            : undefined
        );
        reload({ quiet: true });
      } catch (err) {
        toast.fromError(err, 'Could not store that');
      } finally {
        setUploading(false);
      }
    },
    [auditId, reload, toast]
  );

  const saveCaption = async (item) => {
    const caption = captionDraft.trim();
    setEditingCaption(null);
    if (caption === (item.caption ?? '')) return;
    try {
      await api.patch(`/media/${item.id}/caption`, { caption });
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    }
  };

  /**
   * Annotating something still in the bin.
   *
   * A capture nothing references yet can simply be superseded: the marked-up version is stored as a
   * new one, carrying the caption over, and the original is discarded. Nowhere points at either, so
   * there is nothing to repoint — which is why marking up *before* writing the finding is the
   * cheaper order to work in.
   */
  const saveMarks = async (file) => {
    setSavingMarks(true);
    try {
      const body = new FormData();
      /* The annotator draws at the capture's own size, so the marked-up copy needs it too. */
      const marked = (await shrinkImage(file)).file;
      body.append('file', marked, 'annotated.png');
      body.append('audit', auditId);
      const stored = await api.post('/media', body);
      if (annotating.caption) {
        await api.patch(`/media/${stored.id}/caption`, { caption: annotating.caption });
      }
      await api.del(`/media/${annotating.id}`);
      setAnnotating(null);
      toast.success('Marked up', 'The unmarked capture has been discarded.');
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setSavingMarks(false);
    }
  };

  const confirmDelete = async () => {
    try {
      await api.del(`/media/${pendingDelete.id}`);
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Evidence bin"
        icon={ImagePlus}
        description="Screenshots captured for this engagement that no finding uses yet. Paste or drop them here while you test; insert them when you write up."
        actions={
          canWrite ? (
            <>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                  upload(event.target.files ?? []);
                  event.target.value = '';
                }}
              />
              <Button
                variant="secondary"
                size="sm"
                icon={Upload}
                loading={uploading}
                onClick={() => fileRef.current?.click()}
              >
                Add
              </Button>
            </>
          ) : null
        }
      />
      <CardBody>
        {/*
          * The whole body is the drop target and the paste target. A tester with a screenshot on the
          * clipboard should not have to find a button — Ctrl+V anywhere in here is the interaction
          * they already use in the finding editor.
          */}
        <div
          tabIndex={canWrite ? 0 : undefined}
          onDragOver={(event) => {
            if (!canWrite) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            if (!canWrite) return;
            event.preventDefault();
            setDragging(false);
            upload(event.dataTransfer?.files ?? []);
          }}
          onPaste={(event) => {
            if (!canWrite) return;
            const files = [...(event.clipboardData?.items ?? [])]
              .filter((entry) => entry.type.startsWith('image/'))
              .map((entry) => entry.getAsFile())
              .filter(Boolean);
            if (!files.length) return;
            event.preventDefault();
            upload(files);
          }}
          className={`rounded-xl border border-dashed p-3 transition focus:outline-none ${
            dragging ? 'border-brand-400 bg-brand-500/5' : 'border-line'
          }`}
        >
          {loading && !data ? (
            <SkeletonRows rows={2} columns={3} />
          ) : error ? (
            <ErrorState error={error} onRetry={reload} />
          ) : items.length === 0 ? (
            <EmptyState
              icon={ImagePlus}
              title="Nothing waiting"
              description={
                canWrite
                  ? 'Paste a screenshot, drop a file, or press Add. It stays here until a finding uses it.'
                  : 'Nothing has been captured for this engagement.'
              }
            />
          ) : (
            <ul
              className={`grid gap-3 ${
                compact ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3 lg:grid-cols-4'
              }`}
            >
              {items.map((item) => (
                <li
                  key={item.id}
                  className="flex flex-col gap-1.5 rounded-lg bg-canvas/40 p-2 ring-1 ring-line"
                >
                  <img
                    src={item.url}
                    alt={item.caption || item.filename}
                    loading="lazy"
                    className="h-28 w-full rounded bg-black/30 object-contain"
                  />

                  {editingCaption === item.id ? (
                    <input
                      autoFocus
                      value={captionDraft}
                      onChange={(event) => setCaptionDraft(event.target.value)}
                      onBlur={() => saveCaption(item)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') saveCaption(item);
                        if (event.key === 'Escape') setEditingCaption(null);
                      }}
                      placeholder="What does this show?"
                      className="w-full rounded bg-canvas/70 px-2 py-1 text-xs text-fg ring-1 ring-line focus:ring-2 focus:ring-brand-500 focus:outline-none"
                    />
                  ) : (
                    <button
                      type="button"
                      disabled={!canWrite}
                      onClick={() => {
                        setEditingCaption(item.id);
                        setCaptionDraft(item.caption ?? '');
                      }}
                      title={canWrite ? 'Caption it' : undefined}
                      className="truncate text-left text-xs text-fg-muted transition hover:text-fg disabled:hover:text-fg-muted"
                    >
                      {item.caption || <span className="italic text-fg-subtle">Add a caption</span>}
                    </button>
                  )}

                  <p className="flex items-center gap-1.5 text-[0.625rem] text-fg-subtle">
                    <span>{formatBytes(item.bytes)}</span>
                    {item.width ? (
                      <span>
                        · {item.width}×{item.height}
                      </span>
                    ) : null}
                    {item.uploadedAt ? <span>· {timeAgo(item.uploadedAt)}</span> : null}
                  </p>

                  <div className="mt-auto flex items-center gap-1">
                    {onInsert ? (
                      <Button
                        variant="secondary"
                        size="sm"
                        className="flex-1"
                        onClick={() => onInsert(item)}
                      >
                        Insert
                      </Button>
                    ) : null}
                    {canWrite ? (
                      <>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Highlighter}
                          title="Annotate or redact"
                          onClick={() => setAnnotating(item)}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Discard"
                          className="hover:text-crit"
                          onClick={() => setPendingDelete(item)}
                        />
                      </>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardBody>

      {annotating ? (
        <Annotator
          open
          src={annotating.url}
          busy={savingMarks}
          onClose={() => setAnnotating(null)}
          onSave={saveMarks}
        />
      ) : null}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        title="Discard this capture?"
        confirmLabel="Discard"
        message="It has not been used in the report, so nothing will change there. This deletes the file."
      />
    </Card>
  );
}
