import { useEffect, useRef, useState } from 'react';
import { Download, FileWarning, RefreshCw, X } from 'lucide-react';

import { api } from '../../lib/api.js';
import { downloadBlob, filenameFromResponse } from '../../lib/utils.js';

import { Button } from '../ui/Button.jsx';
import { Alert } from '../ui/Alert.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

/**
 * The report itself, on screen, without leaving the app.
 *
 * Generating has always meant downloading a .docx and opening Word — fine when you are finishing a
 * report, and far too much when the question is "does the executive summary read right yet". So
 * this shows the thing, and the loop becomes: change a sentence, look at the page it lands on.
 *
 * **It is the same bytes.** The server renders exactly what the Generate button renders and then
 * converts them, so what is on screen is the document that would be sent. A preview built from a
 * second layout path would be a picture of something else, and would be believed anyway.
 *
 * Shown in an `<iframe>` on purpose. Every browser this app supports has a PDF viewer built in,
 * with paging, zoom, search and print already correct — and a hand-built viewer would be a worse
 * copy of it carried for ever. What this component owns is the panel around it: what is being
 * looked at, how to get the file, and how to close it.
 */
export default function ReportPreview({ audit, open, onClose }) {
  const [state, setState] = useState({ status: 'idle' });
  /* Held so it can be revoked: a blob URL keeps the whole PDF in memory until it is let go. */
  const urlRef = useRef('');

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;

    const release = () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = '';
    };

    const load = async () => {
      setState({ status: 'loading' });
      try {
        const response = await api.raw(`/audits/${audit._id}/report.pdf`);
        const blob = await response.blob();
        if (cancelled) return;
        release();
        urlRef.current = URL.createObjectURL(blob);
        setState({
          status: 'ready',
          url: urlRef.current,
          blob,
          filename: filenameFromResponse(response, `${audit.name ?? 'report'}.pdf`),
        });
      } catch (error) {
        if (!cancelled) setState({ status: 'error', message: error.message });
      }
    };

    load();
    return () => {
      cancelled = true;
      release();
    };
    /* Re-runs when the panel is opened, which is what makes it show the current draft. */
  }, [open, audit._id, audit.name]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    /*
     * A panel rather than a dialog: the engagement stays where it was, and somebody can close it,
     * fix the sentence they came to fix, and open it again without losing their place.
     */
    <aside className="fixed inset-y-0 right-0 z-40 flex w-full max-w-4xl flex-col border-l border-line bg-surface shadow-pop">
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-fg">{audit.name}</span>
          <span className="block truncate text-[0.6875rem] text-fg-subtle">
            {state.status === 'ready'
              ? `Rendered ${new Date().toLocaleString()} — the same document the Generate button produces`
              : 'The report, as it would be sent'}
          </span>
        </span>

        {state.status === 'ready' ? (
          <Button
            variant="secondary"
            size="sm"
            icon={Download}
            onClick={() => downloadBlob(state.blob, state.filename)}
          >
            Download
          </Button>
        ) : null}
        <Button
          variant="ghost"
          size="icon-sm"
          icon={X}
          aria-label="Close the preview"
          onClick={onClose}
        />
      </header>

      <div className="flex-1 overflow-hidden bg-canvas">
        {state.status === 'loading' ? (
          <LoadingBlock label="Rendering the report…" />
        ) : state.status === 'error' ? (
          <div className="p-4">
            <Alert tone="warning" icon={FileWarning} title="The preview could not be made">
              <p>{state.message}</p>
              {/*
                The commonest cause by a distance, and the one somebody can act on. Said here
                rather than left to the settings page, because this is where they are standing.
              */}
              <p className="mt-2 text-[0.6875rem]">
                A preview needs a converter — LibreOffice, or Word on a Windows server — set up
                under Administration → Settings. Without one, Generate still downloads the .docx.
              </p>
            </Alert>
          </div>
        ) : state.status === 'ready' ? (
          <iframe
            title={`${audit.name} — report preview`}
            src={state.url}
            className="h-full w-full border-0"
          />
        ) : null}
      </div>
    </aside>
  );
}

/** The button that opens it, so the page above does not have to know about any of this. */
export function ReportPreviewButton({ disabled, onClick, busy }) {
  return (
    <Button
      variant="secondary"
      icon={RefreshCw}
      loading={busy}
      disabled={disabled}
      onClick={onClick}
      title={disabled ? 'Assign a template on the Overview tab first' : 'Render it and look at it'}
    >
      Render
    </Button>
  );
}
