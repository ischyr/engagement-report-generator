import { useRef, useState } from 'react';
import { FileJson, Upload } from 'lucide-react';

import { cn } from '../../lib/utils.js';
import { Button } from '../ui/Button.jsx';
import { Modal } from '../ui/Modal.jsx';

/**
 * What the file has to look like, before anybody goes looking for one.
 *
 * The picker opened straight away before this, which is fine if you already have a file this app
 * wrote and useless in the case that matters: somebody with a methodology in a spreadsheet, a wiki
 * or another tool, who is willing to shape it into JSON and has no idea what shape. They would pick
 * a file, be told it could not be read, and have learned nothing about what to fix.
 *
 * So the format comes first and the picker second. The example is the real thing — the same shape
 * `exportFile` writes — rather than a prose description of it, because a description of JSON is
 * strictly worse than the JSON.
 *
 * ## The simpler shapes are here too, and they are not a footnote
 *
 * The reader accepts a bare list of titles, which is most of what anybody actually has to hand.
 * Somebody who reads the full example and concludes this is more work than retyping has been
 * misled by the documentation rather than the feature — so the smallest thing that works is shown
 * beside the fullest, at the same size.
 */

const FULL = `{
  "format": "engy.checklist",
  "version": 1,
  "checklists": [
    {
      "name": "Web application",
      "description": "What we check on every web test",
      "checks": [
        {
          "title": "Session cookie flags",
          "description": "Secure, HttpOnly and SameSite.",
          "category": "Authentication"
        },
        {
          "title": "Directory listing",
          "category": "Configuration"
        }
      ]
    }
  ]
}`;

const MINIMAL = `[
  "Session cookie flags",
  "Password reset tokens",
  "Directory listing"
]`;

function Example({ title, hint, code }) {
  return (
    <div>
      <p className="text-xs font-medium text-fg">{title}</p>
      <p className="mb-1.5 text-[0.6875rem] text-fg-subtle">{hint}</p>
      <pre className="max-h-64 overflow-auto rounded-lg border border-line-soft bg-canvas/60 p-3 font-mono text-[0.6875rem] leading-relaxed text-fg-muted">
        {code}
      </pre>
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} [props.into] the name of the checklist the checks will join, if any
 * @param {(file: File) => void} props.onPick
 */
export default function ChecklistImportModal({ open, onClose, into, onPick, busy }) {
  const fileRef = useRef(null);
  const [over, setOver] = useState(false);

  const take = (file) => {
    if (!file) return;
    onPick(file);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={into ? `Import checks into “${into}”` : 'Import checklists'}
      description={
        into
          ? 'The checks in the file are added to this checklist. Anything already on it is left alone.'
          : 'Each checklist in the file becomes a new one. Nothing already here is changed.'
      }
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <p className="text-[0.6875rem] text-fg-subtle">
            The quickest way to see the format is to export what you already have.
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button icon={Upload} disabled={busy} onClick={() => fileRef.current?.click()}>
              Choose a file
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {/*
          A drop target as well as a button. Somebody who has the file in a folder already is one
          drag away, and the box is also what makes the dialog look like somewhere a file goes.
        */}
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault();
            setOver(false);
            take(event.dataTransfer?.files?.[0]);
          }}
          className={cn(
            'flex flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center transition',
            over ? 'border-brand-400 bg-brand-500/10' : 'border-line'
          )}
        >
          <FileJson size={20} className="text-fg-subtle" />
          <p className="text-sm text-fg">Drop a .json file here</p>
          <p className="text-[0.6875rem] text-fg-subtle">or choose one below</p>
        </div>

        <Example
          title="What the file looks like"
          hint="This is exactly what Export writes, so a file from any instance of this app will do."
          code={FULL}
        />

        <Example
          title="Or, if all you have is a list of titles"
          hint="This works too. Groups and descriptions are optional — you can add them later, here."
          code={MINIMAL}
        />

        <div className="rounded-lg border border-line-soft p-3 text-[0.6875rem] text-fg-muted">
          <p className="font-medium text-fg">Worth knowing</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>
              <strong>Nothing is overwritten.</strong> A check already on the list, by group and
              wording, is skipped — so importing the same file twice changes nothing.
            </li>
            <li>
              <strong>A file cannot claim to be a built-in.</strong> Ids, slugs and authorship are
              ignored; an imported checklist belongs to you.
            </li>
            <li>
              <strong>A bad line does not lose the file.</strong> Anything unreadable is named and
              counted, and the rest still comes in.
            </li>
          </ul>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          /* Cleared so picking the same file again fires — it usually means somebody fixed it. */
          event.target.value = '';
          take(file);
        }}
      />
    </Modal>
  );
}
