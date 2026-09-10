import { useRef, useState } from 'react';
import { Check, ImagePlus, Loader2, Paperclip } from 'lucide-react';

import { api } from '../../lib/api.js';
import { Button } from '../ui/Button.jsx';

/**
 * What the client says they did about a finding, and the screenshot that shows it.
 *
 * Written for somebody who has never used this application and never will again. So: no jargon, no
 * empty states explaining what an empty state is, and nothing on the screen that cannot be acted on
 * by a person with a browser and five minutes.
 *
 * ## Why this is worth the space it takes
 *
 * Marking something fixed moves a row from one column to another. It does not say what changed,
 * which is the first thing the tester needs to know and used to arrive as an email thread. One
 * sentence here — "moved the endpoint behind the session check, deployed Tuesday" — is the
 * difference between a retest that takes five minutes and one that starts with a question.
 *
 * ## Saved on blur, not on a button
 *
 * There is no Save. A client who types a sentence and closes the tab has told us; a client who has
 * to find a button has not. The status write is already optimistic for the same reason, and the same
 * failure handling applies: if it does not land, they are told plainly rather than silently.
 */
export default function RemediationClaim({ token, finding, onSaved = null }) {
  const claim = finding.claim ?? null;
  const [note, setNote] = useState(claim?.note ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [attachments, setAttachments] = useState(claim?.attachments ?? 0);
  const [problem, setProblem] = useState('');
  const fileRef = useRef(null);

  /** What was last sent, so closing the field without changing it is not a write. */
  const sentRef = useRef(claim?.note ?? '');

  const send = async () => {
    const value = note.trim();
    if (value === sentRef.current.trim()) return;

    setSaving(true);
    setProblem('');
    try {
      /*
       * The status goes with it, unchanged.
       *
       * The endpoint takes both because the commonest sequence is one action: tick the box and say
       * what you did. Sending the status this row already has makes a note-only save a no-op on the
       * status, which the server recognises and logs as a note rather than as a second fix.
       */
      await api.post(`/share/${token}/findings/${finding._id}`, {
        fixed: finding.status === 'fixed',
        note: value,
      });
      sentRef.current = value;
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
      onSaved?.();
    } catch (error) {
      setProblem(error?.message || 'That did not save. Your connection may have dropped.');
    } finally {
      setSaving(false);
    }
  };

  const attach = async (file) => {
    if (!file) return;
    setAttaching(true);
    setProblem('');
    try {
      const body = new FormData();
      body.append('file', file);
      /* api.post takes a FormData as it is and lets the browser set the boundary. */
      const answer = await api.post(`/share/${token}/findings/${finding._id}/evidence`, body);
      setAttachments(answer?.attachments ?? attachments + 1);
      onSaved?.();
    } catch (error) {
      setProblem(error?.message || 'That file could not be attached.');
    } finally {
      setAttaching(false);
      /* Cleared, so choosing the same file twice still fires a change event. */
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="rounded-lg border border-line-soft bg-canvas/40 px-3.5 py-3">
      <label
        htmlFor={`note-${finding._id}`}
        className="text-[0.6875rem] font-medium uppercase tracking-wide text-fg-subtle"
      >
        What you did about it
      </label>
      <p className="mt-0.5 text-[0.6875rem] leading-relaxed text-fg-subtle">
        Optional, and it saves itself. Anything here goes to the person who will retest it.
      </p>

      <textarea
        id={`note-${finding._id}`}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        onBlur={send}
        rows={2}
        maxLength={2000}
        placeholder="Moved the endpoint behind the session check and deployed on Tuesday."
        className="mt-2 w-full resize-y rounded-lg border border-line-soft bg-surface/60 px-3 py-2 text-sm text-fg outline-none transition placeholder:text-fg-subtle focus:border-brand-500/50"
      />

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {finding.canAttach ? (
          <>
            {/*
              A plain file input behind a button. No drag target, no preview, no gallery: this is
              one screenshot from somebody who is being helpful, and every part of that interface
              would be a part that can go wrong on a browser nobody here has tested.
            */}
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => attach(event.target.files?.[0])}
            />
            <Button
              variant="ghost"
              size="sm"
              icon={attaching ? Loader2 : ImagePlus}
              disabled={attaching}
              onClick={() => fileRef.current?.click()}
            >
              {attaching ? 'Attaching…' : 'Attach a screenshot'}
            </Button>
          </>
        ) : null}

        {attachments ? (
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-muted">
            <Paperclip size={11} />
            {attachments} attached
          </span>
        ) : null}

        {saving ? (
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-fg-subtle">
            <Loader2 size={11} className="animate-spin" />
            Saving
          </span>
        ) : null}
        {saved ? (
          <span className="flex items-center gap-1.5 text-[0.6875rem] text-low">
            <Check size={11} />
            Saved
          </span>
        ) : null}
      </div>

      {problem ? <p className="mt-2 text-[0.6875rem] text-crit">{problem}</p> : null}
    </div>
  );
}
