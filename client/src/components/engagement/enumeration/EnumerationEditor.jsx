/**
 * One enumeration step, open for editing.
 *
 * Lifted out of `EnumerationTab.jsx` unchanged. It was four hundred and sixty lines of the fourteen
 * hundred that file had left, and it is a single coherent thing: everything about the step somebody
 * is looking at, and nothing about the tree it sits in.
 *
 * The prop list is long and deliberately explicit. It is long because this editor genuinely depends
 * on that much of the workbench's state — writing it as one opaque bag would hide the coupling
 * rather than reduce it, and the list is the honest measure of what a future split would have to
 * untangle.
 */
import {
  Bug,
  ChevronDown,
  ChevronUp,
  Clock,
  CopyPlus,
  Crosshair,
  FileUp,
  Indent,
  Outdent,
  Paperclip,
  Save,
  Sparkles,
  Star,
  Trash2,
} from 'lucide-react';

import { useUnsaved } from '../../../context/UnsavedContext.jsx';
import { api } from '../../../lib/api.js';
import { cn, displayName, timeAgo } from '../../../lib/utils.js';
import { Card, CardBody, CardHeader } from '../../ui/Card.jsx';
import { Button } from '../../ui/Button.jsx';
import { Input, Select, Textarea } from '../../ui/Field.jsx';
import { Badge } from '../../ui/Badge.jsx';
import { RichTextEditor } from '../../editor/RichTextEditor.jsx';
import OutputPane from '../OutputPane.jsx';
import AssistantAction from '../../assistant/AssistantAction.jsx';
import { PHASES, PRINT_MODES, STATUSES, agoInWords, idOf } from './tree-ops.js';

export default function EnumerationEditor({
  selected,
  draft,
  draftFor,
  patch,
  dirty,
  saving,
  save,
  editable,
  runVisible,
  setShowRunFields,
  isSection,
  position,
  siblings,
  move,
  indent,
  outdent,
  duplicate,
  moving,
  setPendingDelete,
  setPromoting,
  setScoping,
  setSavingPreset,
  openVars,
  attach,
  detach,
  uploading,
  markLine,
  editNote,
  removeNote,
  audit,
  asPage,
}) {
  /*
    Read here rather than passed down.

    The four tree buttons below were lifted out of `EnumerationTab` with their `guard(...)` calls
    intact, and `guard` stayed behind in the tab's scope — so every one of them threw a
    ReferenceError on click and outdent, indent and both move buttons silently did nothing. A
    context hook cannot be left behind by a move the way a closure can.
  */
  const { guard } = useUnsaved();

  if (!selected) return null;

  return (
          <Card
            /*
              `min-w-0` is load-bearing. This is the `1fr` column of a grid, and a grid item's
              default `min-width: auto` means it will not shrink below its widest content — so one
              long line of tool output stretched the column and took the page with it.
            */
            className={cn('min-w-0', asPage ? 'ml-4' : '')}
          >
            <CardHeader
              title={
                <Input
                  value={draft.title}
                  disabled={!editable}
                  placeholder="Subdomain Enumeration"
                  onChange={(event) => patch('title', event.target.value)}
                  className="h-8 border-0 bg-transparent px-0 text-sm font-semibold ring-0 focus:ring-0"
                  wrapperClassName="w-full"
                />
              }
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <span>
                    {selected.depth > 0 ? `Level ${selected.depth + 1}` : 'Top level'}
                    {siblings.length > 1 ? ` · ${position + 1} of ${siblings.length} here` : ''}
                  </span>
                  {selected.author ? <span>· {displayName(selected.author)}</span> : null}
                  <span>· edited {timeAgo(selected.updatedAt)}</span>
                  {dirty ? <Badge tone="warning">Unsaved</Badge> : null}
                  {selected.findings?.map((finding) => (
                    <Badge key={idOf(finding._id)} tone="success" icon={Bug}>
                      {finding.identifier || finding.title}
                    </Badge>
                  ))}
                </span>
              }
              actions={
                editable ? (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Outdent}
                      title="Move out one level"
                      disabled={!selected.parent || moving}
                      onClick={() => guard(outdent)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Indent}
                      title="Nest under the step above"
                      disabled={position <= 0 || moving}
                      onClick={() => guard(indent)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={ChevronUp}
                      title="Move one earlier"
                      disabled={position <= 0 || moving}
                      onClick={() => guard(() => move(-1))}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={ChevronDown}
                      title="Move one later"
                      disabled={position >= siblings.length - 1 || moving}
                      onClick={() => guard(() => move(1))}
                    />
                    {selected.hasChildren ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        icon={Star}
                        title="Save this section as a preset to build again"
                        onClick={() => setSavingPreset(selected)}
                      />
                    ) : null}
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Crosshair}
                      title="Add hosts this step found to the scope"
                      onClick={() => setScoping(selected)}
                    >
                      Scope
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Bug}
                      title="Start a finding from this step"
                      onClick={() => setPromoting(selected)}
                    >
                      Write up
                    </Button>
                    <Button
                      variant={dirty ? 'primary' : 'ghost'}
                      size="sm"
                      icon={Save}
                      loading={saving}
                      disabled={!dirty}
                      onClick={() => save()}
                    >
                      {dirty ? 'Save' : 'Saved'}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={CopyPlus}
                      title={
                        selected.hasChildren
                          ? 'Duplicate this section and everything under it'
                          : 'Duplicate this step — the command, not the output'
                      }
                      loading={moving}
                      onClick={() => duplicate(Boolean(selected.hasChildren))}
                    />
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Delete step"
                      className="hover:text-crit"
                      onClick={() => setPendingDelete(selected)}
                    />
                  </>
                ) : null
              }
            />
            {/*
              No scroller of its own. The write-up on a step can be pages long, and a box that
              scrolls inside a page that does not is the worst of both — the window scrolls instead.
            */}
            <CardBody className="flex flex-col gap-4">
              {/*
                A section leads with what it was for. On a step this row is the phase alone, and
                the four-column grid below carries the rest.
              */}
              {isSection ? (
                <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
                  <Input
                    label="What this section was for"
                    hint="Printed above the steps in the report."
                    value={draft.summary}
                    disabled={!editable}
                    placeholder="Establishing the name surface: every subdomain reachable from public sources."
                    onChange={(event) => patch('summary', event.target.value)}
                  />
                  <Select
                    label="Phase"
                    value={draft.phase}
                    disabled={!editable}
                    options={PHASES}
                    onChange={(event) => patch('phase', event.target.value)}
                  />
                </div>
              ) : null}

              {isSection && !runVisible ? (
                <button
                  type="button"
                  onClick={() => setShowRunFields(true)}
                  className="self-start rounded-lg border border-line-soft px-2.5 py-1.5 text-[0.6875rem] text-fg-muted transition hover:border-brand-500/40 hover:text-fg"
                >
                  This section also ran something — show the tool, command and output
                </button>
              ) : null}

              <div
                className={cn(
                  'grid gap-3 sm:grid-cols-2 lg:grid-cols-4',
                  !runVisible && 'hidden'
                )}
              >
                <Input
                  label="Tool"
                  value={draft.tool}
                  disabled={!editable}
                  placeholder="httpx"
                  onChange={(event) => patch('tool', event.target.value)}
                />
                <Input
                  label="Target"
                  value={draft.target}
                  disabled={!editable}
                  placeholder="acme.example"
                  onChange={(event) => patch('target', event.target.value)}
                />
                <Input
                  label="When"
                  value={draft.ranAt}
                  disabled={!editable}
                  placeholder="21 July 2026, 09:14"
                  onChange={(event) => patch('ranAt', event.target.value)}
                />
                <Select
                  label="Phase"
                  value={draft.phase}
                  disabled={!editable}
                  options={PHASES}
                  onChange={(event) => patch('phase', event.target.value)}
                />
              </div>

              <div
                className={cn(
                  'grid gap-3',
                  isSection ? 'sm:grid-cols-[12rem]' : 'sm:grid-cols-[12rem_1fr]',
                  !runVisible && 'hidden'
                )}
              >
                <Select
                  label="Outcome"
                  hint="Countable, unlike “N/A” in a title."
                  value={draft.status}
                  disabled={!editable}
                  options={STATUSES}
                  onChange={(event) => patch('status', event.target.value)}
                />
                {/*
                  A step's own line. A section has this field above instead, where it leads —
                  rendering it in both places would be two inputs bound to one value.
                */}
                {isSection ? null : (
                  <Input
                    label="One-line summary"
                    hint="Printed above the step in the report."
                    value={draft.summary}
                    disabled={!editable}
                    placeholder="Three live hosts; staging was not in the scope document."
                    onChange={(event) => patch('summary', event.target.value)}
                    actions={
                      editable ? (
                        /*
                         * Drawn only when the instance has an assistant, and disabled while the
                         * step has unsaved changes: the output it reads is the one in the
                         * database, and summarising last week's paste while this week's sits
                         * unsaved in the box above would be worse than no button at all.
                         */
                        <AssistantAction
                          job="enumeration"
                          label="Summarise"
                          icon={Sparkles}
                          variant="ghost"
                          disabled={dirty || !draft.output?.trim()}
                          title={
                            dirty
                              ? 'Save the step first — this reads the saved output'
                              : draft.output?.trim()
                                ? 'One line saying what this run established'
                                : 'Paste the output first'
                          }
                          dialogTitle="One line for this step"
                          dialogDescription="From the saved output, with anything that looked like a credential taken out first."
                          request={() =>
                            api.post('/assistant/enumeration', {
                              auditId: idOf(audit._id),
                              stepId: idOf(selected._id),
                            })
                          }
                          preview={(result) => <p className="italic">“{result.text}”</p>}
                          applyLabel="Use it"
                          onApply={(result) => patch('summary', result.text)}
                        />
                      ) : undefined
                    }
                  />
                )}
              </div>

              <div className="flex flex-wrap items-center gap-4 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2">
                {/*
                  Internal is the reason the Notes tab is no longer the only place for the parts of
                  an operation a client should not read. It takes the children with it, so the
                  label says so rather than leaving somebody to find out from the document.
                */}
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft.internal}
                    disabled={!editable}
                    onChange={(event) => patch('internal', event.target.checked)}
                    className="size-3.5 accent-brand-500"
                  />
                  <span className="text-xs text-fg">
                    Internal
                    <span className="ml-1.5 text-[0.625rem] text-fg-subtle">
                      {selected.heldBack && !selected.internal
                        ? 'already held back — a section above this one is internal'
                        : selected.hasChildren
                          ? 'kept out of the report, along with everything under it'
                          : 'kept out of the report'}
                    </span>
                  </span>
                </label>

                <div className="ml-auto flex items-center gap-2">
                  <span className="text-[0.6875rem] text-fg-muted">Output in the report</span>
                  <select
                    value={draft.printOutput}
                    disabled={!editable}
                    onChange={(event) => patch('printOutput', event.target.value)}
                    className="h-8 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg-muted focus:outline-none"
                  >
                    {PRINT_MODES.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                  {draft.printOutput === 'head' ? (
                    <input
                      type="number"
                      min={1}
                      max={5000}
                      value={draft.printLines}
                      disabled={!editable}
                      onChange={(event) => patch('printLines', Number(event.target.value) || 40)}
                      className="h-8 w-16 rounded-lg border border-line-soft bg-canvas/60 px-2 text-xs text-fg focus:outline-none"
                      title="How many lines to print"
                    />
                  ) : null}
                </div>
              </div>

              {/*
                What the command becomes, when it is not already that.
                Shown rather than substituted in place: the field holds the authored text so one
                edit to a variable updates every command, and this line is what will be printed.
              */}
              <Textarea
                wrapperClassName={cn(!runVisible && 'hidden')}
                label="Command"
                hint="The exact invocation, so somebody can run it again and get the same answer."
                rows={2}
                value={draft.command}
                disabled={!editable}
                placeholder="subfinder -d acme.example -silent | httpx -sc -title -tech-detect"
                onChange={(event) => patch('command', event.target.value)}
                className="font-mono text-[0.75rem]"
                spellCheck={false}
              />

              {/*
                Output is a plain textarea, not the rich editor, and that is deliberate.
                It is preformatted text whose value is being exactly what the tool printed —
                column alignment included. A rich editor would offer to reflow it, smart-quote
                it and spell-check it. The pane below shows it the way the report will.
              */}
              <Textarea
                wrapperClassName={cn(!runVisible && 'hidden')}
                label="Output"
                hint="Pasted as-is. Printed in the report as a monospaced pane, line breaks intact."
                rows={8}
                value={draft.output}
                disabled={!editable}
                placeholder={'https://www.acme.example   [200] [Acme — Home] [nginx:1.24.0]'}
                onChange={(event) => patch('output', event.target.value)}
                className="whitespace-pre-wrap break-words bg-canvas/60 font-mono text-[0.75rem] leading-[1.45]"
                spellCheck={false}
                wrap="off"
              />

              {runVisible && selected.commandResolved && selected.commandResolved !== draft.command ? (
                <div className="-mt-2 flex flex-wrap items-start gap-2 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2">
                  <span className="shrink-0 pt-0.5 text-[0.625rem] text-fg-subtle">Resolves to</span>
                  <code className="min-w-0 flex-1 break-all font-mono text-[0.75rem] text-fg-muted">
                    {selected.commandResolved}
                  </code>
                  {selected.varsMissing?.length ? (
                    <button
                      type="button"
                      onClick={openVars}
                      className="shrink-0 rounded px-1.5 py-0.5 text-[0.625rem] text-med underline decoration-dotted"
                      title="Define them"
                    >
                      {selected.varsMissing.join(', ')} not set
                    </button>
                  ) : null}
                </div>
              ) : null}

              {/* Artefacts: the machine-readable output of this run, filed beside it. */}
              {runVisible ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    <p className="text-[0.6875rem] font-medium text-fg-muted">Artefacts</p>
                    <span className="text-[0.625rem] text-fg-subtle">
                      The nmap XML, the httpx JSONL — the file a client can load into their own tools.
                    </span>
                    {editable ? (
                      <label className="ml-auto inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-line-soft px-2 text-[0.6875rem] text-fg-muted transition hover:border-brand-500/40 hover:text-fg">
                        <FileUp size={12} />
                        {uploading ? 'Uploading…' : 'Attach'}
                        <input
                          type="file"
                          className="hidden"
                          disabled={uploading}
                          onChange={(event) => {
                            const file = event.target.files?.[0];
                            event.target.value = '';
                            attach(file);
                          }}
                        />
                      </label>
                    ) : null}
                  </div>
                  {selected.documents?.length ? (
                    <ul className="divide-y divide-line-soft overflow-hidden rounded-lg border border-line-soft">
                      {selected.documents.map((doc) => (
                        <li key={doc._id} className="flex items-center gap-2 px-3 py-1.5">
                          <Paperclip size={11} className="shrink-0 text-fg-subtle" />
                          <a
                            href={`/api/audits/${audit._id}/documents/${doc._id}/download`}
                            className="min-w-0 flex-1 truncate font-mono text-[0.6875rem] text-brand-200 hover:underline"
                          >
                            {doc.filename}
                          </a>
                          <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                            {Math.max(1, Math.round(doc.bytes / 1024))} KB
                          </span>
                          {editable ? (
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              icon={Trash2}
                              title="Remove this artefact"
                              className="hover:text-crit"
                              onClick={() => detach(doc)}
                            />
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}

              {/*
                When this was actually run.
                Distinct from "edited 2 minutes ago" in the header, which moves when somebody
                fixes a typo in the title. A step whose output is a fortnight old during a retest
                is the single most useful thing the page can point out.
              */}
              {!dirty && runVisible && selected.outputAge !== null && selected.outputAge !== undefined ? (
                <p
                  className={cn(
                    'flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[0.625rem]',
                    selected.outputStale ? 'text-med' : 'text-fg-subtle'
                  )}
                >
                  <span className="inline-flex items-center gap-1">
                    <Clock size={10} />
                    Output pasted {agoInWords(selected.outputAge)}
                  </span>
                  {selected.reRun ? (
                    <span>· the run before it was replaced {agoInWords(selected.reRunAge)}</span>
                  ) : null}
                  {selected.outputStale ? <span>· worth re-running before this ships</span> : null}
                </p>
              ) : null}

              {/* What is saved, read the way the report prints it — numbered, foldable, diffable. */}
              {!dirty && runVisible ? (
                <OutputPane
                  output={selected.output}
                  previous={selected.previousOutput}
                  previousAt={selected.previousOutputAt}
                  table={selected.table}
                  notes={selected.notes ?? []}
                  onMark={markLine}
                  onEditNote={editNote}
                  onRemoveNote={removeNote}
                  editable={editable}
                />
              ) : null}

              <div className="flex flex-col gap-1.5">
                <p className="text-[0.6875rem] font-medium text-fg-muted">Write-up</p>
                <p className="text-[0.625rem] text-fg-subtle">
                  Screenshots, an HTTP request and response, and the prose around them.
                </p>
                {draftFor === idOf(selected._id) ? (
                  <RichTextEditor
                    key={selected._id}
                    value={draft.content}
                    onChange={(html) => patch('content', html)}
                    editable={editable}
                    minHeight={240}
                    placeholder="Drop a screenshot, paste a request, say what it meant…"
                  />
                ) : (
                  <div
                    className="flex items-center rounded-lg border border-line-soft bg-canvas/40 px-3 text-xs text-fg-subtle"
                    style={{ minHeight: 240 }}
                  >
                    Loading the write-up…
                  </div>
                )}
              </div>
            </CardBody>
          </Card>
  );
}
