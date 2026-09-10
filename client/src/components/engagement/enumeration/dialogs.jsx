/**
 * Every dialog the enumeration workbench opens.
 *
 * Six of them, and together they were a fifth of `EnumerationTab.jsx`. None holds engagement state
 * of its own — each takes what it needs and hands back what the person chose — so they were the
 * cleanest thing to lift out, and lifting them makes the component that opens them legible.
 */
import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';

import { api } from '../../../lib/api.js';
import { formatDate } from '../../../lib/utils.js';
import { useToast } from '../../../context/ToastContext.jsx';
import { Button } from '../../ui/Button.jsx';
import { Input, Select } from '../../ui/Field.jsx';
import Modal from '../../ui/Modal.jsx';
import { hostCandidates } from './tree-ops.js';

export function VarsDialog({ open, vars, onClose, onSave, editable }) {
  const [rows, setRows] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRows(vars ? vars.map((entry) => ({ ...entry })) : []);
  }, [open, vars]);

  const submit = async () => {
    setBusy(true);
    try {
      await onSave(
        rows
          .filter((row) => row.name.trim())
          .map((row) => ({ name: row.name.trim(), value: row.value ?? '' }))
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Engagement variables"
      description="Write a command once against a variable and change the target in one place. The stored command keeps the variable; the report prints it filled in."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {editable ? (
            <Button variant="primary" loading={busy} onClick={submit}>
              Save
            </Button>
          ) : null}
        </>
      }
    >
      {vars === null ? (
        <p className="text-xs text-fg-muted">Loading…</p>
      ) : (
        <div className="flex flex-col gap-3">
          <ul className="flex flex-col gap-2">
            {rows.map((row, index) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={index} className="flex items-start gap-2">
                <span className="pt-2 font-mono text-xs text-fg-subtle">$</span>
                <Input
                  value={row.name}
                  disabled={!editable}
                  placeholder="TARGET"
                  wrapperClassName="w-40"
                  className="font-mono"
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index
                          ? {
                              ...entry,
                              name: event.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ''),
                            }
                          : entry
                      )
                    )
                  }
                />
                <Input
                  value={row.value}
                  disabled={!editable}
                  placeholder="acme.example"
                  wrapperClassName="flex-1"
                  className="font-mono"
                  onChange={(event) =>
                    setRows((current) =>
                      current.map((entry, i) =>
                        i === index ? { ...entry, value: event.target.value } : entry
                      )
                    )
                  }
                />
                {editable ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    title="Remove"
                    className="mt-1 hover:text-crit"
                    onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                  />
                ) : null}
              </li>
            ))}
          </ul>

          {editable ? (
            <Button
              variant="ghost"
              size="sm"
              icon={Plus}
              className="self-start"
              onClick={() => setRows((current) => [...current, { name: '', value: '' }])}
            >
              Add a variable
            </Button>
          ) : null}

          <p className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-[0.6875rem] text-fg-muted">
            A name that is not defined is left exactly as written, so a half-finished command looks
            half-finished rather than quietly losing a word. Shell variables are left alone.
          </p>
        </div>
      )}
    </Modal>
  );
}

/* ---------------------------------------------------------- preview dialog ---- */

/**
 * The chapter, as the report will print it.
 *
 * Built from the report's own data on the server — internal rows already dropped, print policy
 * already applied, numbering already closed over the gaps — so this answers the question actually
 * being asked rather than a nearby one. Deliberately plain beyond readability: imitating the
 * template's fonts would invite somebody to trust it about things it cannot know.
 */
export function PreviewDialog({ open, preview, full, onFull, onClose }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="How this chapter will read"
      description={
        preview
          ? `${preview.steps} rows will print${preview.internal ? `, ${preview.internal} held back` : ''}.`
          : 'Rendering from the same data the report uses…'
      }
      size="xl"
      footer={
        <>
          {!full ? (
            <Button variant="ghost" onClick={onFull}>
              Show whole panes
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {preview === null ? (
        <p className="text-xs text-fg-muted">Rendering…</p>
      ) : (
        <div
          className="enum-preview max-h-[60vh] overflow-auto rounded-lg border border-line-soft bg-canvas/40 px-4 py-3 text-sm text-fg-muted"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: preview.html }}
        />
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------- jump dialog ---- */

/**
 * Straight to a step by name.
 *
 * At sixty rows scrolling the tree is the slow way, and the tree is not always on screen — the
 * workbench can hide it. Substring rather than fuzzy matching: these titles are things somebody
 * typed minutes ago, and fuzzy matching earns its keep on names you only half remember.
 */
export function JumpDialog({ open, rows, onClose, onPick }) {
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const pool = needle
      ? rows.filter((row) =>
          [row.title, row.tool, row.target, row.path]
            .map((value) => String(value ?? '').toLowerCase())
            .join(' ')
            .includes(needle)
        )
      : rows;
    return pool.slice(0, 40);
  }, [rows, query]);

  return (
    <Modal open={open} onClose={onClose} title="Jump to a step" size="lg">
      <div className="flex flex-col gap-3">
        <Input
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          value={query}
          placeholder="Title, tool, target or number…"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && matches[0]) onPick(matches[0]._id);
          }}
        />
        <ul className="max-h-[50vh] divide-y divide-line-soft overflow-auto rounded-lg border border-line-soft">
          {matches.map((row) => (
            <li key={row._id}>
              <button
                type="button"
                onClick={() => onPick(row._id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left transition hover:bg-white/[0.05]"
              >
                <span className="w-12 shrink-0 font-mono text-[0.625rem] text-fg-subtle">
                  {row.path}
                </span>
                <span
                  className="min-w-0 flex-1 truncate text-xs text-fg"
                  style={{ paddingLeft: `${row.depth * 0.6}rem` }}
                >
                  {row.title || 'Untitled step'}
                </span>
                {row.tool ? (
                  <span className="shrink-0 font-mono text-[0.625rem] text-brand-200/70">
                    {row.tool}
                  </span>
                ) : null}
              </button>
            </li>
          ))}
          {matches.length === 0 ? (
            <li className="px-3 py-2 text-xs text-fg-muted">Nothing matches that.</li>
          ) : null}
        </ul>
        <p className="text-[0.625rem] text-fg-subtle">
          Ctrl+Shift+E opens this from anywhere on the page. Enter takes the first match.
        </p>
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- preset dialog ---- */

/**
 * Saves a section as a preset.
 *
 * The name is the whole interaction, so it is the only required field. What gets saved is structure
 * and commands — never the output, which is said out loud here because it is the one thing somebody
 * might otherwise assume, and carrying one client's sweep into another engagement is the mistake
 * this must not make easy.
 */
export function SavePresetDialog({ step, onClose, onSave }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!step) return;
    setName(step.title && step.title !== 'Untitled step' ? step.title : '');
    setDescription('');
  }, [step?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      await onSave(name.trim(), description.trim());
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(step)}
      onClose={onClose}
      title="Save this section as a preset"
      description="It will be offered alongside the built-in ones, on every engagement."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={submit}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Input
          label="Name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Subdomain Enumeration — our way"
        />
        <Input
          label="Description"
          hint="Shown under the name in the preset list."
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Eight sources, in the order we run them."
        />
        <p className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-[0.6875rem] text-fg-muted">
          The titles, tools, commands, phases and write-ups are saved, and so is the shape of the
          branch. <strong className="text-fg">The output is not.</strong> A preset is the question
          you ask, not last time&rsquo;s answer.
        </p>
      </div>
    </Modal>
  );
}

/* ---------------------------------------------------------- history dialog ---- */

/**
 * What was enumerated for this client before, and a way to bring a section forward.
 *
 * Two buttons per section rather than one, because they answer different questions. *Structure*
 * brings the commands to run again — the retest case. *With last time's output* brings the answers
 * too, for when the point is to compare.
 */
export function HistoryDialog({ open, history, onClose, onCopy }) {
  const [busy, setBusy] = useState('');

  const copy = async (auditId, stepId, withOutput) => {
    setBusy(`${stepId}:${withOutput}`);
    try {
      await onCopy(auditId, stepId, withOutput);
    } finally {
      setBusy('');
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Earlier work for this client"
      description="Sections from this client's other engagements. Copying one brings its shape and its commands."
      size="lg"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      {history === null ? (
        <p className="text-xs text-fg-muted">Loading…</p>
      ) : history.length === 0 ? (
        <p className="text-xs text-fg-muted">
          Nothing yet. This is the first engagement for this client with any enumeration recorded —
          or the others are ones you cannot open.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {history.map((earlier) => (
            <div key={earlier._id} className="overflow-hidden rounded-card border border-line-soft">
              <div className="flex flex-wrap items-baseline gap-2 border-b border-line-soft bg-surface/60 px-3 py-2">
                <span className="text-xs font-medium text-fg">{earlier.name}</span>
                {earlier.reference ? (
                  <span className="font-mono text-[0.625rem] text-fg-subtle">{earlier.reference}</span>
                ) : null}
                {earlier.date ? (
                  <span className="ml-auto text-[0.625rem] text-fg-subtle">
                    {formatDate(earlier.date)}
                  </span>
                ) : null}
              </div>
              <ul className="divide-y divide-line-soft">
                {earlier.sections.map((section) => (
                  <li
                    key={section._id}
                    className="flex flex-wrap items-center gap-2 px-3 py-2"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-fg">{section.title}</span>
                      <span className="text-[0.625rem] text-fg-subtle">
                        {section.steps} step{section.steps === 1 ? '' : 's'} under it
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === `${section._id}:false`}
                      onClick={() => copy(earlier._id, section._id, false)}
                    >
                      Structure
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      loading={busy === `${section._id}:true`}
                      onClick={() => copy(earlier._id, section._id, true)}
                      title="Bring the commands and last time's output, to compare against"
                    >
                      With output
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

/* ------------------------------------------------------------ scope dialog ---- */

/**
 * Puts hosts a step found into the scope.
 *
 * The candidates are offered, not applied. Deciding which lines of a sweep are assets is a
 * judgement — a wildcard, a CDN edge, somebody else's domain in a certificate — and it belongs to
 * the operator. Everything starts unticked for the same reason.
 */
export function ScopeDialog({ step, auditId, scope, onClose, onDone }) {
  const toast = useToast();
  const candidates = useMemo(() => (step ? hostCandidates(step) : []), [step]);
  const groups = useMemo(
    () => (scope ?? []).map((entry) => entry.name).filter(Boolean),
    [scope]
  );

  const [picked, setPicked] = useState(() => new Set());
  const [group, setGroup] = useState('');
  const [status, setStatus] = useState('pending');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!step) return;
    setPicked(new Set());
    setGroup(groups[0] ?? 'Discovered by enumeration');
    setStatus('pending');
  }, [step?._id]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async () => {
    if (!picked.size || !group.trim()) return;
    setBusy(true);
    try {
      const result = await api.post(`/audits/${auditId}/enumeration/${step._id}/to-scope`, {
        group: group.trim(),
        hosts: [...picked],
        status,
      });
      await onDone(
        `${result.added.length} host${result.added.length === 1 ? '' : 's'} in "${result.group}"${
          result.skipped ? `, ${result.skipped} already there` : ''
        }.`
      );
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={Boolean(step)}
      onClose={onClose}
      title="Add discovered hosts to the scope"
      description="Enumeration finds things the scope document never mentioned. Recording them here is what lets the closeout table account for them."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} disabled={!picked.size} onClick={submit}>
            {picked.size ? `Add ${picked.size}` : 'Add'}
          </Button>
        </>
      }
    >
      {candidates.length === 0 ? (
        <p className="text-xs text-fg-muted">
          No hostnames in this step&rsquo;s output or target. Paste the output first, or add the
          asset from the Scope tab.
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              label="Scope group"
              hint="An existing group, or a new name to create one."
              value={group}
              list="enum-scope-groups"
              onChange={(event) => setGroup(event.target.value)}
            />
            <datalist id="enum-scope-groups">
              {groups.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Select
              label="Status"
              hint="Excluded records an asset you found but agreed not to touch."
              value={status}
              onChange={(event) => setStatus(event.target.value)}
              options={[
                { value: 'pending', label: 'Not tested yet' },
                { value: 'tested', label: 'Tested' },
                { value: 'excluded', label: 'Excluded' },
              ]}
            />
          </div>

          <div className="flex items-center justify-between gap-3">
            <p className="text-[0.6875rem] text-fg-muted">
              {candidates.length} hostname{candidates.length === 1 ? '' : 's'} found in the output
            </p>
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => setPicked(new Set(candidates))}>
                All
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setPicked(new Set())}>
                None
              </Button>
            </div>
          </div>

          <ul className="max-h-64 overflow-auto rounded-lg border border-line-soft divide-y divide-line-soft">
            {candidates.map((host) => (
              <li key={host}>
                <label className="flex cursor-pointer items-center gap-2.5 px-3 py-1.5 transition hover:bg-white/[0.035]">
                  <input
                    type="checkbox"
                    checked={picked.has(host)}
                    onChange={() =>
                      setPicked((current) => {
                        const next = new Set(current);
                        if (next.has(host)) next.delete(host);
                        else next.add(host);
                        return next;
                      })
                    }
                    className="size-3.5 accent-brand-500"
                  />
                  <span className="font-mono text-xs text-fg">{host}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

