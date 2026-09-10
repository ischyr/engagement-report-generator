import { useRef, useState } from 'react';
import { BadgeCheck, FileClock, GitCompareArrows, ShieldQuestion, TriangleAlert } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { formatDateTime, sha256OfFile, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Every document this engagement has produced, and what was different about each one.
 *
 * The question this answers is the one a client asks: "the last report had a table of contents" —
 * did it? Until now nobody could say. The template has been saved twice since, the settings are a
 * singleton anybody may edit, and the file itself said nothing about which version of either made
 * it.
 *
 * So each render is recorded with the template version, the app build and the settings that were in
 * force, and each row shows what changed since the one below it. The `renderId` is also written
 * inside the .docx as a custom document property — File → Info → Properties → Advanced — so a file
 * on somebody's desk can be traced back to its row here.
 *
 * Nothing in this list is a document you can download. It is a record of what was produced, not a
 * copy of it: keeping every render would be gigabytes of near-identical Word files, and the delivery
 * record already keeps the hash of the one that actually went out.
 */

const bytes = (size) =>
  size === null || size === undefined
    ? ''
    : size > 1024 * 1024
      ? `${(size / 1024 / 1024).toFixed(1)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;

/**
 * How many rows to show before asking.
 *
 * A long engagement generates dozens of documents, and the interesting ones are always the last
 * few — the one that went out, and the two before it that explain what changed. The rest is
 * history somebody occasionally wants and never wants first.
 */
const PAGE = 5;

/** A settings value as a person reads it, not as JSON. */
const said = (value) => {
  if (value === true) return 'on';
  if (value === false) return 'off';
  if (value === null || value === undefined || value === '') return 'empty';
  return String(value);
};

export default function RenderHistory({ audit }) {
  const { data, loading } = useResource(`/renders?audit=${audit._id}`, { initial: null });
  const [open, setOpen] = useState(null);
  /** The answer to "is this file one of these?": { name, hash, match } or an error. */
  const [checked, setChecked] = useState(null);
  const [checking, setChecking] = useState(false);
  const [shown, setShown] = useState(PAGE);
  const filePicker = useRef(null);

  const rows = data?.renders ?? [];
  /*
   * Sliced for display only. Checking a file still looks through every render the server sent —
   * a document generated a fortnight ago is exactly the one somebody cannot identify by eye, and
   * "not one of ours" would be a lie if it only meant "not one of the five on screen".
   */
  const listed = rows.slice(0, shown);

  /*
   * Hashing the file the person is holding and looking for it in the record.
   *
   * The digest of every generated document is already stored, and until now nothing read it — a
   * record that cannot be checked is a record you have to take on trust. The file never leaves the
   * machine: the hash is computed in the browser and compared against a list already on the page.
   *
   * A file that matches nothing is the interesting answer, not an error. It means the document was
   * edited after it was generated, or came from somewhere else entirely, and both are things
   * somebody needs to be told plainly.
   */
  const verify = async (file) => {
    if (!file) return;
    setChecking(true);
    try {
      const hash = await sha256OfFile(file);
      const match = rows.find((row) => row.outputHash && row.outputHash === hash) ?? null;
      setChecked({ name: file.name, hash, match });
    } catch (error) {
      setChecked({
        name: file.name,
        error:
          error.message === 'insecure-context'
            ? 'This browser will only hash a file over https or on localhost.'
            : 'That file could not be read.',
      });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Card>
      <CardHeader
        icon={FileClock}
        title="How each document was generated"
        description="The template version, the build and the settings behind every report this engagement has produced. Each row says what changed since the one before it."
        actions={
          rows.length ? (
            <>
              <input
                ref={filePicker}
                type="file"
                accept=".docx"
                className="hidden"
                onChange={(event) => {
                  verify(event.target.files?.[0]);
                  /* Cleared, so checking the same file twice fires the change event again. */
                  event.target.value = '';
                }}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={ShieldQuestion}
                loading={checking}
                onClick={() => filePicker.current?.click()}
              >
                Check a file
              </Button>
            </>
          ) : null
        }
      />

      {/* The verdict, above the list, because it is the answer to a question just asked. */}
      {checked ? (
        <div
          className={`mx-4 mt-3 flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-xs ${
            checked.error
              ? 'border-line-soft text-fg-muted'
              : checked.match
                ? 'border-low/30 bg-low/[0.06] text-fg'
                : 'border-warn/30 bg-warn/[0.06] text-fg'
          }`}
        >
          {checked.error ? (
            <ShieldQuestion size={15} className="mt-0.5 shrink-0 text-fg-subtle" />
          ) : checked.match ? (
            <BadgeCheck size={15} className="mt-0.5 shrink-0 text-low" />
          ) : (
            <TriangleAlert size={15} className="mt-0.5 shrink-0 text-warn" />
          )}
          <div className="min-w-0 flex-1">
            {checked.error ? (
              <p>{checked.error}</p>
            ) : checked.match ? (
              <>
                <p>
                  <span className="font-medium">{checked.name}</span> is exactly the document
                  generated {timeAgo(checked.match.at)} by {checked.match.by || 'somebody'}, from{' '}
                  {checked.match.template || 'a template since removed'}
                  {checked.match.templateVersion ? ` (${checked.match.templateVersion})` : ''}.
                </p>
                <p className="mt-0.5 break-all font-mono text-[0.625rem] text-fg-subtle">
                  {checked.hash}
                </p>
              </>
            ) : (
              <>
                <p>
                  <span className="font-medium">{checked.name}</span> does not match any document
                  this engagement produced. It has been edited since it was generated, or it came
                  from somewhere else.
                </p>
                <p className="mt-0.5 break-all font-mono text-[0.625rem] text-fg-subtle">
                  {checked.hash}
                </p>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={() => setChecked(null)}
            className="shrink-0 text-[0.6875rem] text-fg-subtle transition hover:text-fg"
          >
            dismiss
          </button>
        </div>
      ) : null}
      {loading && !data ? (
        <LoadingBlock label="Reading the record…" />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={FileClock}
          title="Nothing generated yet"
          description="Generate a report and it will read back from here — including which template version made it."
        />
      ) : (
        <CardBody className="flex flex-col divide-y divide-line-soft">
          {listed.map((row) => (
            <div key={row.renderId} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-sm text-fg">{row.template || 'a template since removed'}</span>
                {row.templateVersion ? (
                  <span
                    className="font-mono text-[0.625rem] text-fg-subtle"
                    title="A fingerprint of the template file itself. Two renders with different values used different templates, whatever the name says."
                  >
                    {row.templateVersion}
                  </span>
                ) : null}
                {row.changedSincePrevious?.length ? (
                  <button
                    type="button"
                    onClick={() => setOpen(open === row.renderId ? null : row.renderId)}
                    className="inline-flex items-center gap-1 rounded-full bg-warn/12 px-1.5 py-0.5 text-[0.625rem] text-warn transition hover:bg-warn/20"
                  >
                    <GitCompareArrows size={10} />
                    {row.changedSincePrevious.length} change
                    {row.changedSincePrevious.length === 1 ? '' : 's'}
                  </button>
                ) : (
                  <Badge tone="neutral">same as the one before</Badge>
                )}
                <span className="ml-auto whitespace-nowrap text-[0.6875rem] text-fg-subtle" title={formatDateTime(row.at)}>
                  {timeAgo(row.at)}
                </span>
              </div>

              <p className="flex flex-wrap gap-x-3 text-[0.6875rem] text-fg-subtle">
                <span>{row.by || 'somebody'}</span>
                {/* The house style, which the template's own version cannot show — see the model. */}
                {row.inheritedFrom ? (
                  <span title={`Took ${(row.inheritedParts ?? []).join(', ')} from it`}>
                    house style: {row.inheritedFrom}
                  </span>
                ) : null}
                {row.counts?.findings !== null && row.counts?.findings !== undefined ? (
                  <span>{row.counts.findings} findings</span>
                ) : null}
                {row.counts?.images ? <span>{row.counts.images} images</span> : null}
                <span>{bytes(row.size)}</span>
                {row.ms ? <span>{(row.ms / 1000).toFixed(1)}s</span> : null}
                <span className="font-mono">{row.build}</span>
              </p>

              {/* Opened rather than always shown: on a long job this list is dozens of rows. */}
              {open === row.renderId ? (
                <ul className="mt-1 flex flex-col gap-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2">
                  {row.changedSincePrevious.map((change) => (
                    <li key={change.what} className="flex flex-wrap items-baseline gap-x-2 text-xs">
                      <span className="text-fg-muted">{change.what}</span>
                      <span className="text-fg-subtle line-through">{said(change.from)}</span>
                      <span className="text-fg-subtle">→</span>
                      <span className="text-fg">{said(change.to)}</span>
                    </li>
                  ))}
                  <li className="mt-1 border-t border-line-soft pt-1.5 text-[0.625rem] text-fg-subtle">
                    Render id <span className="font-mono">{row.renderId}</span> — also inside the
                    file, under File → Info → Properties → Advanced.
                  </li>
                </ul>
              ) : null}
            </div>
          ))}

          {shown < rows.length ? (
            <div className="flex justify-center pt-3">
              <Button size="sm" variant="ghost" onClick={() => setShown((count) => count + PAGE)}>
                Show {Math.min(PAGE, rows.length - shown)} more
                <span className="ml-1 text-fg-subtle">
                  ({rows.length - shown} older)
                </span>
              </Button>
            </div>
          ) : null}
        </CardBody>
      )}
    </Card>
  );
}
