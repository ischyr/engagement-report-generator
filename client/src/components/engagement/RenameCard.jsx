import { useMemo, useState } from 'react';
import { Lock, Replace, Search } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Checkbox, Field, Input } from '../ui/Field.jsx';
import { Modal } from '../ui/Modal.jsx';

/**
 * Renaming one thing everywhere it appears in this engagement.
 *
 * The client renames the staging host on day four and it is in six findings, two write-ups and a
 * section. There was no way to do that but to open each one and retype it.
 *
 * The whole design of this card is the second step. A substitution across forty fields is not the
 * shape of thing the app's undo can hold — `replace.service.js` argues that at length — so nothing
 * is written until the person has seen every hit in context with its field named. The preview is
 * not a courtesy, it is the safety, and it is why the commit button is inside the dialog rather
 * than here beside the inputs.
 *
 * What it deliberately cannot reach — tool output, commands, the structured scope list, anything
 * inside an HTML attribute — is stated on the card rather than left to be discovered, because the
 * first question anybody sensible asks is whether this is about to edit their evidence.
 */
export default function RenameCard({ audit, editable, onReload }) {
  const toast = useToast();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [matchCase, setMatchCase] = useState(true);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState('');

  if (!editable) return null;

  const ready = find.trim().length >= 2 && find !== replace;

  const look = async () => {
    setBusy('preview');
    try {
      const data = await api.post(`/audits/${audit._id}/replace/preview`, {
        find,
        replace,
        matchCase,
      });
      /* The terms are frozen into the preview: editing the boxes behind an open dialog must not
       * change what the commit button is about to do. */
      setPreview({ ...data, find, replace, matchCase });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy('');
    }
  };

  const commit = async () => {
    setBusy('replace');
    try {
      const data = await api.post(`/audits/${audit._id}/replace`, {
        find: preview.find,
        replace: preview.replace,
        matchCase: preview.matchCase,
        expectedTotal: preview.total,
      });
      setPreview(null);
      setFind('');
      setReplace('');
      await onReload?.({ quiet: true });
      toast.success(
        `Replaced ${data.changed} occurrence${data.changed === 1 ? '' : 's'}`,
        data.skipped?.length
          ? `Left alone: ${data.skipped.join(', ')} — somebody else is holding ${
              data.skipped.length === 1 ? 'it' : 'them'
            }.`
          : 'Tool output, commands and the scope list were not touched.'
      );
    } catch (error) {
      toast.fromError(error);
      /* A conflict means somebody changed the engagement while this list was open, so the list is
       * now a lie. Drop it and make them look again rather than offering a stale commit. */
      if (error?.status === 409) setPreview(null);
    } finally {
      setBusy('');
    }
  };

  return (
    <>
      <Card>
        <CardHeader
          icon={Replace}
          title="Rename across this engagement"
          description="A host, a product, a client's name — changed everywhere it appears in the writing, in one go."
        />
        <CardBody className="grid gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Find" htmlFor="rename-find">
              <Input
                id="rename-find"
                value={find}
                onChange={(event) => setFind(event.target.value)}
                placeholder="api.acme.example"
                spellCheck={false}
              />
            </Field>
            <Field label="Replace with" htmlFor="rename-replace" hint="Leave empty to delete it.">
              <Input
                id="rename-replace"
                value={replace}
                onChange={(event) => setReplace(event.target.value)}
                placeholder="api.northwind.test"
                spellCheck={false}
              />
            </Field>
          </div>

          <Checkbox
            checked={matchCase}
            onChange={setMatchCase}
            label="Match case"
            id="rename-case"
          />

          <p className="text-[0.6875rem] leading-relaxed text-fg-subtle">
            Searches finding titles and prose, sections, notes and enumeration write-ups. It will
            not touch tool output, the commands beside it, or the scope list — those are records of
            what was run and what came back, and editing them would make the report say something
            that never happened.
          </p>

          <div className="flex items-center gap-3">
            <Button
              variant="secondary"
              icon={Search}
              disabled={!ready}
              loading={busy === 'preview'}
              onClick={look}
            >
              Show me every hit
            </Button>
            {find.trim().length === 1 ? (
              <span className="text-xs text-fg-subtle">Two characters at least.</span>
            ) : find && find === replace ? (
              <span className="text-xs text-fg-subtle">Those are the same text.</span>
            ) : null}
          </div>
        </CardBody>
      </Card>

      <PreviewDialog
        preview={preview}
        busy={busy === 'replace'}
        onClose={() => setPreview(null)}
        onCommit={commit}
      />
    </>
  );
}

/** Where a hit is, in words an operator uses rather than the field name on the model. */
const KINDS = {
  'finding.title': 'Finding',
  'finding.description': 'Finding',
  'finding.scope': 'Finding',
  'finding.poc': 'Finding',
  'finding.observation': 'Finding',
  'finding.remediation': 'Finding',
  'section.text': 'Section',
  'note.content': 'Note',
  'step.title': 'Enumeration',
  'step.summary': 'Enumeration',
  'step.content': 'Enumeration',
};

/**
 * One excerpt with the change shown in it — the old text struck through, the new immediately after.
 *
 * Deliberately not a highlight. "Here is where it matches" leaves the reader to imagine the result;
 * showing both halves means the thing being approved is the sentence that will exist afterwards,
 * which is the only question worth asking before a bulk write.
 */
function Excerpt({ text, find, replace, matchCase }) {
  const parts = useMemo(() => {
    const hay = matchCase ? text : text.toLowerCase();
    const pin = matchCase ? find : find.toLowerCase();
    const out = [];
    let from = 0;
    let at = hay.indexOf(pin);
    while (at !== -1) {
      if (at > from) out.push({ plain: text.slice(from, at) });
      out.push({ was: text.slice(at, at + pin.length) });
      from = at + pin.length;
      at = hay.indexOf(pin, from);
    }
    if (from < text.length) out.push({ plain: text.slice(from) });
    return out;
  }, [text, find, matchCase]);

  return (
    <p className="text-xs leading-relaxed text-fg-muted">
      {parts.map((part, index) =>
        part.plain !== undefined ? (
          <span key={index}>{part.plain}</span>
        ) : (
          <span key={index}>
            <span className="rounded bg-crit/12 px-0.5 text-crit line-through">{part.was}</span>
            {replace ? (
              <span className="rounded bg-low/12 px-0.5 text-low">{replace}</span>
            ) : null}
          </span>
        )
      )}
    </p>
  );
}

function PreviewDialog({ preview, busy, onClose, onCommit }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const hit of preview?.hits ?? []) {
      const kind = KINDS[hit.where] ?? 'Elsewhere';
      if (!map.has(kind)) map.set(kind, []);
      map.get(kind).push(hit);
    }
    return [...map.entries()];
  }, [preview]);

  const nothing = preview && !preview.total;

  return (
    <Modal
      open={Boolean(preview)}
      onClose={onClose}
      size="lg"
      title={
        nothing
          ? 'Nothing to rename'
          : `${preview?.total} occurrence${preview?.total === 1 ? '' : 's'} in ${
              preview?.hits.length
            } place${preview?.hits.length === 1 ? '' : 's'}`
      }
      description={
        nothing
          ? undefined
          : `Every one of these will change. There is no undo for a rename, so this is the moment to check it.`
      }
      footer={
        nothing ? (
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" icon={Replace} loading={busy} onClick={onCommit}>
              Replace all {preview?.total}
            </Button>
          </>
        )
      }
    >
      {nothing ? (
        <p className="text-sm text-fg-muted">
          <span className="font-mono text-fg">{preview?.find}</span> does not appear in the writing
          on this engagement. It may still be in tool output or the scope list, neither of which this
          changes.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {grouped.map(([kind, hits]) => (
            <div key={kind} className="flex flex-col gap-2">
              <h4 className="text-[0.6875rem] font-semibold uppercase tracking-wide text-fg-subtle">
                {kind}
              </h4>
              <ul className="divide-y divide-line-soft rounded-lg border border-line">
                {hits.map((hit, index) => (
                  <li key={`${hit.where}:${index}`} className="flex flex-col gap-1.5 px-3 py-2.5">
                    <span className="flex items-center gap-2">
                      <span className="min-w-0 flex-1 truncate text-xs font-medium text-fg">
                        {hit.label}
                      </span>
                      {hit.count > 1 ? <Badge tone="neutral">{hit.count}×</Badge> : null}
                    </span>
                    {hit.excerpts.map((excerpt, spot) => (
                      <Excerpt
                        key={spot}
                        text={excerpt}
                        find={preview.find}
                        replace={preview.replace}
                        matchCase={preview.matchCase}
                      />
                    ))}
                    {hit.count > hit.excerpts.length ? (
                      <p className="text-[0.6875rem] text-fg-subtle">
                        …and {hit.count - hit.excerpts.length} more in the same field.
                      </p>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ))}

          <p className="flex items-start gap-2 rounded-lg border border-line bg-white/[0.02] px-3 py-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
            <Lock size={13} className="mt-0.5 shrink-0" />
            <span>
              A finding somebody else is editing right now is left exactly as it is, and named
              afterwards so you can go and ask them. Everything else is written in one go.
            </span>
          </p>
        </div>
      )}
    </Modal>
  );
}
