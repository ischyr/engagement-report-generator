import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  BookOpen,
  ChevronDown,
  ChevronUp,
  Combine,
  FileSpreadsheet,
  History,
  Plus,
  Repeat2,
  UserCheck,
  Save,
  ShieldAlert,
  Sparkles,
  Trash2,
  TriangleAlert,
  BookMarked,
  Eye,
  ImagePlus,
  Lock,
  Pencil,
  Undo2,
  Users,
  X,
  Zap,
} from 'lucide-react';

import { api } from '../../lib/api.js';
import ImportFindingsDialog from './ImportFindingsDialog.jsx';
import AssistantAction from '../assistant/AssistantAction.jsx';
import { listKey, saveShortcutLabel } from '../../lib/keys.js';
import { shrinkImage } from '../../lib/images.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { useUnsaved, useUnsavedWork } from '../../context/UnsavedContext.jsx';
import { calculateCvss, CVSS_DEFAULT_VECTOR } from '../../lib/cvss.js';
import {
  COMPLEXITY_LABELS,
  PRIORITY_LABELS,
  cn,
  displayName,
  downloadBlob,
  filenameFromResponse,
  formatDate,
  htmlToSnippet,
  isHtmlEmpty,
  timeAgo,
} from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';
import { Input, Select, Textarea } from '../ui/Field.jsx';
import { Modal, ConfirmDialog } from '../ui/Modal.jsx';
import ConflictMerge from '../ui/ConflictMerge.jsx';
import CustomFieldInput, { isWideField } from './CustomFieldInput.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';
import { Avatar, SearchInput } from '../ui/Misc.jsx';
import { useHere } from '../../context/PresenceContext.jsx';
import FindingPreview from './FindingPreview.jsx';
import EvidenceBin from './EvidenceBin.jsx';
import FindingLockBar from './FindingLockBar.jsx';
import MergeFindingDialog from './MergeFindingDialog.jsx';
import { Badge, SeverityBadge } from '../ui/Badge.jsx';
import { CvssEditor } from '../cvss/CvssEditor.jsx';
import { RichTextEditor } from '../editor/RichTextEditor.jsx';
import FindingComments from './FindingComments.jsx';
import FindingTimeline from './FindingTimeline.jsx';
import TransferFindingCard from './TransferFindingCard.jsx';
import BulkFindingBar from './BulkFindingBar.jsx';

const BLANK = {
  title: '',
  vulnType: '',
  category: '',
  cvssv3: CVSS_DEFAULT_VECTOR,
  priority: '',
  remediationComplexity: '',
  remediationStatus: 'open',
  description: '',
  observation: '',
  remediation: '',
  poc: '',
  scope: '',
  references: [],
  customFields: [],
};

/** Mirrors REMEDIATION_STATUSES on the server. */
const REMEDIATION_STATUS_OPTIONS = [
  { value: 'open', label: 'Not fixed' },
  { value: 'retesting', label: 'Retesting' },
  { value: 'fixed', label: 'Fixed' },
];

/**
 * "Nothing chosen", in the three shapes it arrives in: '', null and undefined.
 *
 * Anything else becomes a number, because both fields it serves are numeric on the wire.
 */
const blankToNull = (value) =>
  value === '' || value === null || value === undefined ? null : Number(value);

/** One per line, the same split the save does. Named because a bare escape in JSX is easy to lose. */
const NEWLINE = '\n';

/**
 * The fields a conflict is resolved over, and what to call them.
 *
 * Everything a save sends, so the merge cannot quietly drop something it did not think to compare —
 * a field missing from this list would be taken from whichever whole version won, which is exactly
 * the behaviour this replaced.
 */
const MERGE_FIELDS = [
  { key: 'title', label: 'Title' },
  { key: 'vulnType', label: 'Vulnerability type' },
  { key: 'category', label: 'Category' },
  { key: 'cvssv3', label: 'CVSS vector' },
  { key: 'priority', label: 'Remediation priority' },
  { key: 'remediationComplexity', label: 'Remediation effort' },
  { key: 'remediationStatus', label: 'Remediation status' },
  { key: 'severityOverride', label: 'Reported severity' },
  { key: 'severityOverrideReason', label: 'Severity override reason' },
  { key: 'description', label: 'Description', rich: true },
  { key: 'scope', label: 'Affected assets', rich: true },
  { key: 'poc', label: 'Proof of concept', rich: true },
  { key: 'observation', label: 'Impact', rich: true },
  { key: 'remediation', label: 'Remediation', rich: true },
  { key: 'references', label: 'References' },
];

const RICH_FIELDS = [
  {
    key: 'description',
    label: 'Description',
    hint: 'What the issue is and how it was found. Screenshots and code blocks are welcome.',
  },
  { key: 'scope', label: 'Affected assets', hint: 'Which hosts, URLs or endpoints are affected.' },
  { key: 'poc', label: 'Proof of concept', hint: 'Requests, payloads and evidence. Paste screenshots directly.' },
  { key: 'observation', label: 'Impact', hint: 'What an attacker gains, in business terms.' },
  { key: 'remediation', label: 'Remediation', hint: 'Concrete, actionable fixes.' },
];

/* -------------------------------------------------------------------------- */
/* Import from the shared library                                              */
/* -------------------------------------------------------------------------- */

function LibraryPicker({ open, onClose, auditId, locale, onImported }) {
  const toast = useToast();
  const { data, loading } = useResource(open ? '/vulnerabilities' : null, { initial: [] });
  const [search, setSearch] = useState('');
  const [importing, setImporting] = useState(null);

  const list = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const all = data ?? [];
    if (!needle) return all;
    return all.filter((entry) => {
      const detail = entry.details?.[0];
      return [detail?.title, entry.category, detail?.vulnType]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [data, search]);

  const importEntry = async (entry) => {
    setImporting(entry._id);
    try {
      await api.post(`/audits/${auditId}/findings/from-library`, {
        vulnerability: entry._id,
        locale,
      });
      toast.success('Finding added from the library');
      onImported?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setImporting(null);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add from the vulnerability library"
      description="A copy is made — editing the finding here will not change the library entry."
      size="lg"
    >
      <SearchInput value={search} onChange={setSearch} placeholder="Search the library…" autoFocus />
      <div className="mt-4">
        {loading ? (
          <LoadingBlock />
        ) : list.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="Nothing in the library matches"
            description="Add reusable entries on the Vulnerabilities page to speed up future reports."
          />
        ) : (
          <ul className="flex flex-col gap-1.5">
            {list.map((entry) => {
              const detail =
                entry.details?.find((d) => d.locale === locale) ?? entry.details?.[0] ?? {};
              const cvss = calculateCvss(entry.cvssv3);
              return (
                <li key={entry._id}>
                  <button
                    type="button"
                    disabled={Boolean(importing)}
                    onClick={() => importEntry(entry)}
                    className="flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left transition hover:bg-white/5 disabled:opacity-50"
                  >
                    <SeverityBadge
                      severity={cvss.baseSeverity}
                      score={cvss.baseScore}
                      className="mt-0.5 shrink-0"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-fg">
                        {detail.title || 'Untitled'}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-fg-muted">
                        {[entry.category, detail.vulnType].filter(Boolean).join(' · ')}
                        {detail.description ? ` — ${htmlToSnippet(detail.description, 90)}` : ''}
                      </span>
                    </span>
                    {importing === entry._id ? (
                      <span className="shrink-0 text-xs text-fg-muted">adding…</span>
                    ) : (
                      <Plus size={15} className="mt-1 shrink-0 text-fg-subtle" />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */
/* Finding editor                                                              */
/* -------------------------------------------------------------------------- */

function FindingEditor({
  finding,
  auditId,
  editable,
  onSaved,
  onClose,
  customFieldDefs,
  onReload,
  previously = [],
  /** The engagement's other findings, for merging one into this. */
  siblings = [],
  /** Opens another finding — the duplicate hint under the title links to what it found. */
  onOpen,
  /** Which language the library is read in, for a match against it. */
  locale = 'en',
}) {
  const toast = useToast();
  const { user } = useAuth();
  const vulnTypes = useResource('/data/vulnerability-types', { initial: [] });
  /**
   * Promoting this write-up into the library.
   *
   * `clash` holds the entry the server refused over — a 409 carrying the existing entry — so
   * the choice between "update that one" and "add a second" is the author's, not a silent
   * decision by whichever code path got there first.
   */
  const [promoting, setPromoting] = useState(false);
  const [clash, setClash] = useState(null);
  const categories = useResource('/data/vulnerability-categories', { initial: [] });

  const [form, setForm] = useState(() => ({ ...BLANK, ...finding }));
  const [saving, setSaving] = useState(false);
  const [referencesText, setReferencesText] = useState((finding.references ?? []).join('\n'));
  const [dirty, setDirty] = useState(false);
  /** Set when a save was refused because someone else edited this finding first. */
  const [conflict, setConflict] = useState(null);

  /**
   * The write-up, fetched when the finding is opened.
   *
   * The engagement's own payload carries every finding without its four HTML bodies — that is what
   * stopped a hundred-finding engagement weighing megabytes on every page load — so the row this
   * editor is handed has a title, a rating and a snippet, and the prose lives one request away.
   *
   * Seeded from the row first and filled in when the body lands, rather than waiting: the title,
   * the severity and the metadata are already here, so the form is usable immediately and the
   * editors fill in underneath. `dirty` is not touched by the arrival, because somebody who
   * started typing in the title must not have it thrown away by a response that was already in
   * flight.
   */
  const [bodyFor, setBodyFor] = useState(null);
  useEffect(() => {
    setForm({ ...BLANK, ...finding });
    setReferencesText((finding.references ?? []).join('\n'));
    setDirty(false);
    setBodyFor(finding._id ? null : 'new');

    if (!finding._id) return undefined;
    let cancelled = false;
    api
      .get(`/audits/${auditId}/findings/${finding._id}`)
      .then((full) => {
        if (cancelled) return;
        setForm((current) => ({
          ...current,
          /* Only the fields the list left behind, so anything typed meanwhile survives. */
          ...Object.fromEntries(
            ['description', 'observation', 'remediation', 'poc'].map((field) => [
              field,
              current[field] || full[field] || '',
            ])
          ),
        }));
        setBodyFor(finding._id);
      })
      .catch(() => {
        /* The metadata is on screen and editable; the write-up simply has not arrived. */
        if (!cancelled) setBodyFor(finding._id);
      });
    return () => {
      cancelled = true;
    };
  }, [finding, auditId]);

  /** True once the prose for the open finding is here, so the editors are not seeded empty. */
  const bodyReady = !finding._id || bodyFor === finding._id;

  const set = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  useUnsavedWork(dirty, finding._id ? 'This finding' : 'The new finding', () => save());

  /**
   * The finding's prose, in the order the report prints it, for the figure-reference picker.
   *
   * Memoised on the five fields rather than on `form`, which changes on every keystroke anywhere —
   * including the title and the vector. The picker reads unsaved text on purpose: the screenshot
   * somebody wants to point at is usually the one they pasted a minute ago.
   */
  const prose = useMemo(
    () =>
      Object.fromEntries(RICH_FIELDS.map((field) => [field.label.toLowerCase(), form[field.key] ?? ''])),
    /* eslint-disable-next-line react-hooks/exhaustive-deps -- the five fields, named. */
    [form.description, form.scope, form.poc, form.observation, form.remediation]
  );

  /**
   * Takes a library match's write-up, into the fields that are empty and no others.
   *
   * Additive on purpose. The person asking "is this already written up" usually has a title, a
   * vector and half a description, and the useful outcome is the other half — not their own
   * paragraph replaced by a generic one. Nothing is saved: it lands in the editor as an ordinary
   * unsaved change, which is what makes accepting it reversible.
   */
  const applyLibraryMatch = (result) => {
    const body = result?.match?.body;
    if (!body) return;

    const patch = {};
    for (const key of ['description', 'observation', 'remediation']) {
      if (body[key] && isHtmlEmpty(form[key])) patch[key] = body[key];
    }
    if (body.vulnType && !form.vulnType) patch.vulnType = body.vulnType;
    if (body.category && !form.category) patch.category = body.category;

    const filledReferences = body.references?.length && !referencesText.trim();
    if (filledReferences) setReferencesText(body.references.join(NEWLINE));

    const filled = Object.keys(patch).length + (filledReferences ? 1 : 0);
    if (!filled) {
      toast.info('Nothing was empty', 'Every field that entry could fill already has something in it.');
      return;
    }
    if (Object.keys(patch).length) set(patch);
    else setDirty(true);
    toast.success(
      `Filled ${filled} empty field${filled === 1 ? '' : 's'} from the library`,
      'Nothing you had written was touched. Save when you are happy with it.'
    );
  };

  /**
   * Findings already here that this one would duplicate.
   *
   * Debounced, because it runs while somebody types a title, and asked of the server because the
   * rule for "the same weakness" is `normaliseTitle` and there must be exactly one of those. The
   * request is cheap — the findings are already loaded with the engagement — and a failure is
   * silent: a hint that could not be fetched is not worth an error over a field somebody is
   * halfway through filling in.
   */
  const [duplicates, setDuplicates] = useState([]);
  useEffect(() => {
    const title = form.title?.trim() ?? '';
    if (title.length < 6) {
      setDuplicates([]);
      return undefined;
    }
    const timer = setTimeout(() => {
      api
        .get(
          `/audits/${auditId}/findings/similar?title=${encodeURIComponent(title)}` +
            (finding._id ? `&exclude=${finding._id}` : '')
        )
        .then((result) => setDuplicates(result?.matches ?? []))
        .catch(() => setDuplicates([]));
    }, 400);
    return () => clearTimeout(timer);
  }, [form.title, auditId, finding._id]);

  /*
   * Keyed on the finding, not the engagement: two people in different findings of the same job
   * are not in each other's way, and warning them would train everybody to ignore this.
   */
  const alsoHere = useHere(finding._id ? `finding:${auditId}:${finding._id}` : '');

  /**
   * Whether somebody else has taken this finding.
   *
   * `editable` already covers the engagement being approved and the account being read-only; this is
   * the third reason a finding cannot be written to, and it is the only one that changes minute to
   * minute. Everything downstream reads `mayWrite` rather than `editable`, so a lock cannot be
   * enforced in one place and forgotten in another — the server refuses these writes anyway, and a
   * form that lets somebody type for ten minutes before saying so is a worse failure than a
   * disabled field.
   */
  const lockedByOther = Boolean(
    finding.lockedBy && String(finding.lockedBy._id ?? finding.lockedBy) !== String(user?.id)
  );
  const lockLapsed =
    lockedByOther && finding.lockedBy?.lastSeenAt
      ? Date.now() - new Date(finding.lockedBy.lastSeenAt).getTime() > 5 * 60 * 1000
      : false;
  const mayWrite = editable && !(lockedByOther && !lockLapsed);

  /** Swaps the five editors for what the report will make of them. */
  const [previewing, setPreviewing] = useState(false);
  const [mergePicker, setMergePicker] = useState(false);
  /**
   * Where an insert from the evidence bin lands.
   *
   * The last field that had the cursor, defaulting to the proof of concept — which is where
   * evidence goes in every template we ship, and a better guess than the first field on the page.
   */
  const [activeField, setActiveField] = useState('poc');
  const [binOpen, setBinOpen] = useState(false);

  const cvss = useMemo(() => calculateCvss(form.cvssv3), [form.cvssv3]);
  /** An override equal to the score is not an override — nobody explains calling a High a High. */
  const overridden =
    Boolean(form.severityOverride) && form.severityOverride !== cvss.baseSeverity;

  const findingCustomFields = useMemo(
    () => (customFieldDefs ?? []).filter((f) => f.display === 'finding'),
    [customFieldDefs]
  );

  const customValue = (key) => form.customFields?.find((f) => f.key === key)?.value ?? '';
  const setCustomField = (definition, value) => {
    const next = [...(form.customFields ?? [])];
    const index = next.findIndex((f) => f.key === definition.key);
    const entry = {
      key: definition.key,
      label: definition.label,
      fieldType: definition.fieldType,
      value,
    };
    if (index === -1) next.push(entry);
    else next[index] = entry;
    set({ customFields: next });
  };

  /**
   * @param {{force?: boolean}} [options] `force` re-sends without the freshness
   *   token, which is how "overwrite theirs" is expressed to the server.
   */
  const save = async ({ force = false } = {}) => {
    if (!form.title.trim()) {
      toast.error('A finding needs a title');
      return;
    }
    /*
     * Never save a write-up that has not arrived.
     *
     * The prose is fetched when the finding is opened, so for a moment the form holds empty
     * strings for four fields that are not empty on the server. The window is milliseconds and
     * the cost of losing it is somebody's afternoon, so a save in it is refused rather than raced.
     */
    if (!bodyReady) {
      toast.info('Still opening this finding', 'Its write-up is on its way — try again in a moment.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: form.title,
        vulnType: form.vulnType,
        category: form.category,
        cvssv3: form.cvssv3,
        /*
         * Nothing chosen means null, and there are three ways to mean nothing.
         *
         * The empty string is what the select gives; `null` is what a finding that has never had a
         * priority carries; `undefined` is what a form seeded from an older record has. Only the
         * first was handled, so `Number(null)` sent 0 — and the schema, correctly, refuses a
         * priority of zero. The effect was that a finding with no priority could not be saved at
         * all, with a validation error naming a field nobody had touched. The merge path below
         * already got this right, which is the tell.
         */
        priority: blankToNull(form.priority),
        remediationComplexity: blankToNull(form.remediationComplexity),
        remediationStatus: form.remediationStatus || 'open',
        description: form.description,
        observation: form.observation,
        remediation: form.remediation,
        poc: form.poc,
        scope: form.scope,
        references: referencesText
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean),
        customFields: form.customFields ?? [],
        // Lets the server refuse the write if this finding moved on underneath us.
        ...(form._id && form.updatedAt && !force ? { expectedUpdatedAt: form.updatedAt } : {}),
      };

      const saved = form._id
        ? await api.put(`/audits/${auditId}/findings/${form._id}`, payload)
        : await api.post(`/audits/${auditId}/findings`, payload);

      toast.success(form._id ? 'Finding saved' : 'Finding added');
      setConflict(null);
      setDirty(false);
      onSaved?.(saved);
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else if (error?.isLocked) {
        /*
         * Somebody took the lock between this editor loading and the save. Reload rather than only
         * complaining: the point is that the screen stops offering to write, which is what the
         * fresh copy does.
         */
        toast.error('Locked while you were editing', error.message);
        await onReload?.();
      } else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  /**
   * Sends this finding to the library.
   *
   * `replace` is only ever set from the clash dialog, so a second entry with the same title
   * is something somebody chose rather than something that happened.
   */
  /**
   * Swaps a screenshot for a new one wherever this engagement references it.
   *
   * The rewrite is server-side and reaches other findings, sections and notes, so the whole
   * engagement is refetched afterwards — and it is refused while this finding has unsaved
   * text, because saving over it would put the old reference back.
   */
  const replaceImage = async (mediaId, file) => {
    if (dirty) {
      toast.info(
        'Save the finding first',
        'Replacing rewrites what is stored, and unsaved text would overwrite it.'
      );
      return;
    }
    try {
      const body = new FormData();
      /* A replacement is embedded exactly like the capture it replaces, so it gets the same. */
      body.append('file', (await shrinkImage(file)).file);
      const result = await api.post(`/audits/${auditId}/media/${mediaId}/replace`, body);
      if (result.unchanged) {
        toast.info('That is the same image', 'Nothing needed changing.');
        return;
      }
      // Nothing referenced it: worth saying, rather than reporting a successful replacement
      // of nothing.
      if (!result.replaced) {
        toast.info('That image is not referenced here', 'The new file was stored, but nothing pointed at the old one.');
        await onReload?.();
        return;
      }
      toast.success(
        `Replaced in ${result.replaced} place${result.replaced === 1 ? '' : 's'}`,
        'Captions and alt text were kept.'
      );
      await onReload?.();
    } catch (error) {
      toast.fromError(error);
    }
  };

  const promote = async (replace) => {
    setPromoting(true);
    try {
      const result = await api.post(
        `/audits/${auditId}/findings/${form._id}/promote`,
        replace ? { replace } : {}
      );
      setClash(null);
      toast.success(
        result.replaced ? 'Library entry updated' : 'Added to the library',
        result.imagesRemoved
          ? `${result.imagesRemoved} screenshot${result.imagesRemoved === 1 ? '' : 's'} left behind — evidence belongs to this engagement.`
          : undefined
      );
    } catch (error) {
      if (error.status === 409 && error.details?.existing) {
        setClash(error.details.existing);
      } else {
        toast.fromError(error);
      }
    } finally {
      setPromoting(false);
    }
  };

  /**
   * Puts a capture from the bin into whichever field was last focused.
   *
   * Appended rather than inserted at the cursor: the editors are separate components with their own
   * instances, and reaching into one from here to place a node at a position it may no longer have
   * is a way to lose text. Evidence belongs at the end of what it evidences anyway.
   */
  const insertFromBin = (item) => {
    const caption = (item.caption ?? '').replace(/[<>&]/g, '');
    const figure = caption
      ? `<figure class="engy-figure"><img src="${item.url}" alt="${caption}"><figcaption>${caption}</figcaption></figure>`
      : `<figure class="engy-figure"><img src="${item.url}" alt=""></figure>`;
    set({ [activeField]: `${form[activeField] ?? ''}${figure}` });
    const label = RICH_FIELDS.find((field) => field.key === activeField)?.label ?? activeField;
    toast.success(`Added to ${label}`, 'It leaves the bin once this finding is saved.');
  };

  /**
   * Saves the merged version, based on theirs.
   *
   * The freshness token is *their* `updatedAt`, not the one this editor loaded with: the merge was
   * built from their version, so it is no longer out of date. Anything they change in the seconds
   * after this is still caught, which is the point of the check.
   */
  const saveMerged = async (merged) => {
    const theirs = conflict;
    setSaving(true);
    try {
      const payload = {
        ...merged,
        priority:
          merged.priority === '' || merged.priority === null ? null : Number(merged.priority),
        remediationComplexity:
          merged.remediationComplexity === '' || merged.remediationComplexity === null
            ? null
            : Number(merged.remediationComplexity),
        remediationStatus: merged.remediationStatus || 'open',
        references: Array.isArray(merged.references) ? merged.references : [],
        customFields: form.customFields ?? [],
        ...(theirs?.updatedAt ? { expectedUpdatedAt: theirs.updatedAt } : {}),
      };
      const saved = await api.put(`/audits/${auditId}/findings/${form._id}`, payload);
      setConflict(null);
      setDirty(false);
      toast.success('Merged and saved');
      onSaved?.(saved);
    } catch (error) {
      if (error?.isConflict) setConflict(error.current ?? {});
      else toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  /*
   * There is no "discard mine and load theirs" here any more.
   *
   * The merge dialog subsumes it: choosing theirs for every field that actually clashes gives the
   * same result, while keeping the edits they never touched — which somebody who pressed "discard"
   * was throwing away without being asked about. The other tabs still use the simpler dialog,
   * because a note or a section is one field and a merge would be a longer way to say the same thing.
   */

  return (
    <div className="flex flex-col gap-5">
      {/*
        * Advisory, not a lock.
        *
        * The save already refuses to clobber somebody else's version — that is what `conflict`
        * handles — but by then both people have written a paragraph and one of them is going to
        * lose it. Saying "Andrei is in here too" while it is still cheap to coordinate is worth
        * more than a better dialog afterwards. Nothing is blocked: two people editing the same
        * finding on the last afternoon of a test is sometimes exactly what should happen.
        */}
      {alsoHere.length ? (
        <p className="flex flex-wrap items-center gap-2 rounded-lg bg-med/10 px-3 py-2 text-xs text-fg ring-1 ring-med/25">
          <Users size={14} className="shrink-0 text-med" />
          {alsoHere.map((person) => (
            <span key={person.id} className="flex items-center gap-1.5">
              <Avatar user={person} size={18} />
              <span className="font-medium">{person.fullname}</span>
            </span>
          ))}
          <span className="text-fg-muted">
            {alsoHere.length === 1 ? 'has' : 'have'} this finding open too — check before you save.
          </span>
        </p>
      ) : null}

      {editable && form._id ? (
        <FindingLockBar
          auditId={auditId}
          finding={finding}
          lock={finding}
          editable={editable}
          onChanged={() => onReload?.()}
        />
      ) : null}

      {finding.createdBy ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[0.6875rem] text-fg-subtle">
          <Avatar user={finding.createdBy} size={20} />
          <span>
            Added by <span className="font-medium text-fg-muted">{displayName(finding.createdBy)}</span>
            {finding.createdAt ? ` ${timeAgo(finding.createdAt)}` : ''}
          </span>
          {finding.updatedBy &&
          (finding.updatedBy._id ?? finding.updatedBy) !== (finding.createdBy._id ?? finding.createdBy) ? (
            <>
              <span aria-hidden>·</span>
              <span>
                last edited by{' '}
                <span className="font-medium text-fg-muted">{displayName(finding.updatedBy)}</span>
                {finding.updatedAt ? ` ${timeAgo(finding.updatedAt)}` : ''}
              </span>
            </>
          ) : null}
        </p>
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Title"
            required
            placeholder="SQL injection in the reporting endpoint"
            wrapperClassName="sm:col-span-2"
            value={form.title}
            disabled={!mayWrite}
            onChange={(e) => set({ title: e.target.value })}
            /*
              Said under the field rather than in a dialog on save. The point is to stop the second
              write-up being started, and by the time somebody has written one and pressed save,
              telling them it was a duplicate is only bad news.
            */
            hint={
              duplicates.length ? (
                <span className="text-med">
                  {duplicates.length === 1 ? 'This engagement already has ' : 'Already here: '}
                  {duplicates.map((match, index) => (
                    <span key={match._id}>
                      {index ? ', ' : ''}
                      <button
                        type="button"
                        className="underline decoration-dotted hover:text-fg"
                        onClick={() => onOpen?.(match._id)}
                      >
                        {match.identifier || match.title}
                      </button>
                    </span>
                  ))}
                  . Write it up once, or merge them later.
                </span>
              ) : undefined
            }
          />
          <Select
            label="Vulnerability type"
            placeholder="Not set"
            value={form.vulnType}
            disabled={!mayWrite}
            onChange={(e) => set({ vulnType: e.target.value })}
            options={(vulnTypes.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
          />
          <Select
            label="Category"
            placeholder="Not set"
            value={form.category}
            disabled={!mayWrite}
            onChange={(e) => set({ category: e.target.value })}
            options={(categories.data ?? []).map((c) => ({ value: c.name, label: c.name }))}
          />
          <Select
            label="Remediation priority"
            placeholder="Not set"
            value={form.priority ?? ''}
            disabled={!mayWrite}
            onChange={(e) => set({ priority: e.target.value })}
            options={Object.entries(PRIORITY_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            label="Remediation effort"
            placeholder="Not set"
            value={form.remediationComplexity ?? ''}
            disabled={!mayWrite}
            onChange={(e) => set({ remediationComplexity: e.target.value })}
            options={Object.entries(COMPLEXITY_LABELS).map(([value, label]) => ({ value, label }))}
          />
          <Select
            label="Remediation status"
            hint="Drives the fixed / retesting / not-fixed counters in the report."
            value={form.remediationStatus ?? 'open'}
            disabled={!mayWrite}
            onChange={(e) => set({ remediationStatus: e.target.value })}
            options={REMEDIATION_STATUS_OPTIONS}
          />
        </CardBody>
      </Card>

      {/* Read before writing: what this client was already told, and whether they
          acted on it. It is the difference between "we found X" and "we found X
          again, having reported it in March". */}
      {previously.length ? (
        <Card>
          <CardHeader
            icon={Repeat2}
            title="Reported to this client before"
            description="The same issue in an earlier engagement, newest first."
          />
          <CardBody className="flex flex-col gap-1.5">
            {previously.map((occurrence) => (
              <Link
                key={occurrence.findingId}
                // Straight to the finding it is talking about, not to that
                // engagement's list.
                to={`/engagements/${occurrence.auditId}/findings/${occurrence.findingId}`}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 transition hover:border-brand-500/40"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs text-fg">
                    {occurrence.reference || occurrence.auditName}
                  </span>
                  <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                    {occurrence.title}
                  </span>
                </span>
                <SeverityBadge severity={occurrence.severity} score={occurrence.score} />
                <Badge tone={occurrence.remediationStatus === 'fixed' ? 'success' : 'warning'}>
                  {REMEDIATION_STATUS_OPTIONS.find((o) => o.value === occurrence.remediationStatus)
                    ?.label ?? occurrence.remediationStatus}{' '}
                  then
                </Badge>
                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                  {occurrence.date ? formatDate(occurrence.date) : 'undated'}
                </span>
              </Link>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader
          title="CVSS v3.1"
          description="The score and severity shown throughout the report come from this vector."
          actions={
            <span className="flex items-center gap-2">
              {overridden ? (
                <span className="text-[0.625rem] text-fg-subtle line-through">
                  {cvss.baseSeverity}
                </span>
              ) : null}
              <SeverityBadge
                severity={overridden ? form.severityOverride : cvss.baseSeverity}
                score={cvss.baseScore}
              />
            </span>
          }
        />
        <CardBody className="flex flex-col gap-4">
          <CvssEditor
            value={form.cvssv3}
            onChange={(next) => set({ cvssv3: next })}
            editable={mayWrite}
          />

          {/*
            The rating the team stands behind, when it differs from the arithmetic.

            Firms do this in the document by hand — "rated Medium rather than High because the
            interface is reachable only from the management VLAN" — which leaves the app's counts,
            charts and report disagreeing with each other. Recorded here, everything agrees, and
            the reason prints beside the score rather than living in somebody's memory.
          */}
          <div className="flex flex-col gap-3 border-t border-line-soft pt-3">
            <div className="flex flex-wrap items-end gap-3">
              <Select
                label="Reported severity"
                hint="Leave as the score unless there is a reason to depart from it."
                wrapperClassName="w-56"
                value={form.severityOverride ?? ''}
                onChange={(event) => set({ severityOverride: event.target.value })}
                options={[
                  { value: '', label: `As scored — ${cvss.baseSeverity}` },
                  { value: 'Critical', label: 'Critical' },
                  { value: 'High', label: 'High' },
                  { value: 'Medium', label: 'Medium' },
                  { value: 'Low', label: 'Low' },
                  { value: 'None', label: 'Informational' },
                ]}
              />
              {overridden ? (
                <Input
                  label="Why"
                  required
                  wrapperClassName="min-w-0 flex-1"
                  placeholder="Reachable only from the management VLAN"
                  hint="Printed in the report beside the score, and shown to whoever reviews this."
                  error={
                    (form.severityOverrideReason ?? '').trim() ? undefined : 'A reason is required'
                  }
                  value={form.severityOverrideReason ?? ''}
                  onChange={(event) => set({ severityOverrideReason: event.target.value })}
                />
              ) : null}
            </div>
            {overridden ? (
              <p className="flex items-start gap-2 text-[0.6875rem] leading-relaxed text-med">
                <TriangleAlert size={12} className="mt-0.5 shrink-0" />
                Reported as {form.severityOverride} while the vector scores{' '}
                {cvss.baseSeverity} ({cvss.baseScore}). Both appear in the report — a rating that
                hides the score it departed from is the one a client argues with.
              </p>
            ) : null}
          </div>
        </CardBody>
      </Card>

      {/*
        * Preview instead of the editors, not beside them.
        *
        * Side by side, each half is too narrow to judge either the writing or the layout, and the
        * question being asked — "is this right?" — is not one you ask while typing. Toggling keeps
        * the draft in state, so nothing is saved to look at it.
        */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {/*
          * Merge sits with the other whole-finding actions rather than in the list, because it needs
          * a finding open to be *about* something: this one survives, the chosen one folds into it.
          */}
        {editable && form._id && siblings.length > 0 ? (
          <Button
            variant="ghost"
            size="sm"
            icon={Combine}
            onClick={() => {
              if (dirty) {
                toast.info(
                  'Save this finding first',
                  'Merging rewrites what is stored, and unsaved text would be overwritten.'
                );
                return;
              }
              setMergePicker(true);
            }}
          >
            Merge in another
          </Button>
        ) : null}
        {editable && form._id ? (
          <Button
            variant={binOpen ? 'secondary' : 'ghost'}
            size="sm"
            icon={ImagePlus}
            onClick={() => setBinOpen((current) => !current)}
          >
            {binOpen ? 'Hide the evidence bin' : 'Evidence bin'}
          </Button>
        ) : null}
        <Button
          variant={previewing ? 'secondary' : 'ghost'}
          size="sm"
          icon={previewing ? Pencil : Eye}
          onClick={() => setPreviewing((current) => !current)}
        >
          {previewing ? 'Back to editing' : 'Preview as it will render'}
        </Button>
      </div>

      {binOpen && !previewing ? (
        <EvidenceBin auditId={auditId} onInsert={insertFromBin} compact />
      ) : null}

      {previewing ? (
        <FindingPreview
          auditId={auditId}
          findingId={form._id}
          draft={{
            title: form.title || 'Untitled finding',
            vulnType: form.vulnType ?? '',
            category: form.category ?? '',
            description: form.description ?? '',
            observation: form.observation ?? '',
            remediation: form.remediation ?? '',
            poc: form.poc ?? '',
            scope: form.scope ?? '',
            cvssv3: form.cvssv3 ?? '',
            severityOverride: form.severityOverride ?? '',
            severityOverrideReason: form.severityOverrideReason ?? '',
            remediationStatus: form.remediationStatus ?? 'open',
            references: referencesText
              .split(NEWLINE)
              .map((line) => line.trim())
              .filter(Boolean),
          }}
        />
      ) : (
        RICH_FIELDS.map((field) => (
          <Card key={field.key}>
            <CardHeader
              title={field.label}
              description={field.hint}
              actions={
                mayWrite && form._id ? (
                  /*
                   * Drawn only when the instance has an assistant — see `useAssistant`.
                   *
                   * The rewrite reads the saved field, so it is disabled while there are unsaved
                   * changes: rewriting last night's paragraph while this morning's sits in the
                   * editor would produce something that reads well and says the wrong thing.
                   */
                  <AssistantAction
                    job="rewrite"
                    label="Rewrite"
                    icon={Sparkles}
                    disabled={dirty || isHtmlEmpty(form[field.key])}
                    title={
                      dirty
                        ? 'Save the finding first — this reads the saved text'
                        : isHtmlEmpty(form[field.key])
                          ? 'Write something first'
                          : `Rewrite the ${field.label.toLowerCase()} in the house style`}
                    dialogTitle={`${field.label}, rewritten`}
                    dialogDescription="Every fact is meant to survive — hosts, ports, versions, parameters and any caveat. Read it against what you wrote; it is a draft, not a correction."
                    request={() =>
                      api.post('/assistant/rewrite', {
                        auditId,
                        findingId: form._id,
                        field: field.key,
                      })
                    }
                    preview={(result) => (
                      <div
                        className="engy-prose max-h-96 overflow-auto"
                        dangerouslySetInnerHTML={{ __html: result.html }}
                      />
                    )}
                    applyLabel="Replace what is there"
                    onApply={(result) => set({ [field.key]: result.html })}
                  />
                ) : null
              }
            />
            <CardBody>
              {/*
                Not mounted until the write-up has arrived.
                The editor reports a change whenever its value moves under it, so mounting it empty
                and filling it in a moment later would mark the finding edited the instant it was
                opened — and a save from that state would write the empty version over somebody's
                text. The enumeration tab documents the same hazard for the same reason.
              */}
              {bodyReady ? (
                <RichTextEditor
                  value={form[field.key]}
                  onChange={(html) => set({ [field.key]: html })}
                  onFocus={() => setActiveField(field.key)}
                  editable={mayWrite}
                  placeholder={field.hint}
                  minHeight={field.key === 'description' ? 200 : 140}
                  onReplaceImage={form._id ? replaceImage : undefined}
                  /* So a sentence in the description can point at a screenshot in the proof of concept. */
                  siblingFields={prose}
                />
              ) : (
                <div
                  className="animate-pulse rounded-card bg-white/[0.03]"
                  style={{ minHeight: field.key === 'description' ? 200 : 140 }}
                />
              )}
            </CardBody>
          </Card>
        ))
      )}

      <Card>
        <CardHeader title="References" description="One URL per line." />
        <CardBody>
          <Textarea
            rows={3}
            placeholder={'https://owasp.org/Top10/A03_2021-Injection/\nhttps://cwe.mitre.org/data/definitions/89.html'}
            value={referencesText}
            disabled={!mayWrite}
            onChange={(e) => {
              setReferencesText(e.target.value);
              setDirty(true);
            }}
            className="font-mono text-xs"
          />
        </CardBody>
      </Card>

      {findingCustomFields.length ? (
        <Card>
          <CardHeader title="Custom fields" />
          <CardBody className="grid gap-4 sm:grid-cols-2">
            {findingCustomFields.map((definition) => (
              <div
                key={definition.key}
                className={isWideField(definition) ? 'sm:col-span-2' : undefined}
              >
                <CustomFieldInput
                  definition={definition}
                  value={customValue(definition.key)}
                  disabled={!mayWrite}
                  onChange={(value) => setCustomField(definition, value)}
                />
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      {/*
        Into the library, so a good write-up outlives the engagement it was written for.
        Only for a saved finding: promoting unsaved text would put a version in the library
        that exists nowhere else.
      */}
      {editable && form._id ? (
        <Card>
          <CardHeader
            icon={BookMarked}
            title="Reuse this write-up"
            description="Copy the description, observation, remediation, references and score into the shared library. The proof of concept, the affected hosts and every screenshot stay here — they are this client's."
            actions={
              <div className="flex items-center gap-2">
                {/*
                  The other direction, and the one that saves the most time: is this already
                  written up somewhere. The shortlist is drawn from the library by the search this
                  app already has, here on this machine; only those few titles are sent.
                */}
                <AssistantAction
                  job="library"
                  label="Find a match"
                  icon={Sparkles}
                  disabled={dirty}
                  title={dirty ? 'Save the finding first' : 'Ask whether the library already has this'}
                  dialogTitle="Is this already in the library?"
                  dialogDescription="Your own library, shortlisted here by title and then judged. Nothing is copied until you say so, and only into fields that are empty."
                  request={() => api.post('/assistant/library', { auditId, findingId: form._id, locale })}
                  applicable={(result) => Boolean(result.match)}
                  applyLabel="Fill the empty fields from it"
                  onApply={applyLibraryMatch}
                  preview={(result) => (
                    <div className="flex flex-col gap-3">
                      {result.match ? (
                        <div className="rounded-card border border-brand-500/30 bg-brand-500/5 p-3">
                          <p className="text-sm font-medium text-fg">{result.match.title}</p>
                          {result.match.category ? (
                            <p className="mt-0.5 text-[0.6875rem] text-fg-subtle">
                              {result.match.category}
                            </p>
                          ) : null}
                          {result.reason ? (
                            <p className="mt-1.5 text-xs text-fg-muted">{result.reason}</p>
                          ) : null}
                        </div>
                      ) : (
                        <p className="text-sm text-fg-muted">
                          Nothing in the library is the same weakness.
                          {result.reason ? ` ${result.reason}` : ''}
                        </p>
                      )}
                      {result.candidates?.length ? (
                        <div>
                          <p className="mb-1 text-[0.6875rem] uppercase tracking-wide text-fg-subtle">
                            {/*
                              The shortlist as well, always. Disagreeing with the answer is the
                              common case, and the useful thing then is the list it chose from
                              rather than a second trip to the library page.
                            */}
                            It chose from
                          </p>
                          <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
                            {result.candidates.map((candidate) => (
                              <li key={candidate._id} className="truncate">
                                {candidate.title}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ) : null}
                    </div>
                  )}
                />
                <Button
                  variant="secondary"
                  size="sm"
                  icon={BookMarked}
                  loading={promoting}
                  disabled={dirty}
                  title={dirty ? 'Save the finding first' : 'Add this write-up to the library'}
                  onClick={() => promote()}
                >
                  Add to the library
                </Button>
              </div>
            }
          />
        </Card>
      ) : null}

      {editable && form._id ? (
        <TransferFindingCard
          auditId={auditId}
          finding={form}
          dirty={dirty}
          onMoved={async () => {
            // It is not here any more, so the editor must not be either.
            await onReload?.();
            onClose?.();
          }}
          onCopied={() => onReload?.()}
        />
      ) : null}

      {/*
        Above the comments, because the comments are part of the history it summarises — and
        below the finding itself, because the history is context rather than the work.
      */}
      {finding?._id ? (
        <Card>
          <CardHeader
            icon={History}
            title="What has happened to this"
            description="When it appeared, when its rating changed, when its status moved — and which delivered versions the client has seen it in."
          />
          <CardBody>
            <FindingTimeline auditId={auditId} findingId={finding._id} />
          </CardBody>
        </Card>
      ) : null}

      <FindingComments auditId={auditId} finding={finding} onChanged={onReload} />

      {editable ? (
        <div className="sticky bottom-4 z-20 flex items-center justify-end gap-3 rounded-card border border-line bg-overlay/95 px-4 py-3 shadow-pop backdrop-blur">
          <p className="mr-auto text-xs text-fg-muted">
            {dirty ? 'Unsaved changes' : 'All changes saved'}
          </p>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {mayWrite ? null : (
            <span className="mr-auto text-xs text-fg-subtle">
              Locked by somebody else — read only.
            </span>
          )}
          <Button
            variant="primary"
            icon={Save}
            loading={saving}
            disabled={!mayWrite}
            title={`Save (${saveShortcutLabel()})`}
            onClick={() => save()}
          >
            {form._id ? 'Save finding' : 'Add finding'}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={Boolean(clash)}
        onClose={() => setClash(null)}
        onConfirm={() => promote(clash._id)}
        title="The library already has this one"
        message={`"${clash?.title}"${clash?.category ? ` (${clash.category})` : ''} is already in the library. Update it with this write-up? Its other languages are left alone. Cancel to leave the library as it is.`}
        confirmLabel="Update it"
      />

      {/*
        * A three-way merge rather than a choice between two whole versions — see ConflictMerge. The
        * base is the version this editor loaded, which is exactly the common ancestor it needs.
        */}
      {mergePicker ? (
        <MergeFindingDialog
          open
          onClose={() => setMergePicker(false)}
          auditId={auditId}
          target={form}
          findings={siblings}
          onMerged={(merged) => {
            onSaved?.(merged);
            onReload?.();
          }}
        />
      ) : null}

      <ConflictMerge
        open={Boolean(conflict)}
        onClose={() => setConflict(null)}
        onMerge={saveMerged}
        onOverwrite={() => save({ force: true })}
        label={`the finding “${form.title}”`}
        fields={MERGE_FIELDS}
        base={finding}
        mine={{
          ...form,
          references: referencesText
            .split(NEWLINE)
            .map((line) => line.trim())
            .filter(Boolean),
        }}
        theirs={conflict}
        loading={saving}
      />
    </div>
  );
}

/**
 * Who wrote a finding up, shown on its row.
 *
 * The activity log has the same information, but "whose finding is this?" comes up
 * while reading the list, so it is answered there. Findings written before
 * authorship was recorded show nothing rather than a guess — putting the wrong
 * name on someone's work would be worse than leaving it blank.
 */
function FindingAuthor({ finding }) {
  const author = finding.createdBy;
  const editor = finding.updatedBy;
  if (!author) return null;

  const editedByElse =
    editor && (editor._id ?? editor) !== (author._id ?? author) ? displayName(editor) : null;

  return (
    <span
      title={
        editedByElse
          ? `Added by ${displayName(author)} · last edited by ${editedByElse}`
          : `Added by ${displayName(author)}`
      }
      className="hidden shrink-0 items-center gap-1.5 sm:flex"
    >
      <Avatar user={author} size={22} />
      <span className="hidden max-w-28 truncate text-[0.6875rem] text-fg-subtle lg:block">
        {displayName(author)}
      </span>
      {/* A dot rather than a second avatar: the point is that it was touched by
          someone else, and the tooltip says who. */}
      {editedByElse ? (
        <span aria-hidden className="size-1.5 rounded-full bg-med/70" title={`Last edited by ${editedByElse}`} />
      ) : null}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Tab                                                                         */
/* -------------------------------------------------------------------------- */

export default function FindingsTab({ audit, editable, onReload, onPatch }) {
  const toast = useToast();
  const navigate = useNavigate();
  const customFields = useResource('/data/custom-fields', { initial: [] });

  /**
   * Which finding is open is in the URL, not in this component.
   *
   * It used to be local state, which meant a finding could not be linked to: the
   * notification saying you were mentioned in one opened the *list*, and pasting a
   * finding into a ticket was impossible. Selecting one navigates; the back button then
   * does what a reader expects.
   */
  const { findingId: selectedId } = useParams();
  const select = (id) => guard(() => navigate(`/engagements/${audit._id}/findings/${id}`));

  const [creating, setCreating] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  /** The trash row waiting on a confirmation, and whether it is being emptied. */
  const [pendingPurge, setPendingPurge] = useState(null);
  const [purging, setPurging] = useState(false);
  const [reordering, setReordering] = useState(false);
  const { guard } = useUnsaved();
  /** The quick-capture line: a title, and the category to reuse for the next one. */
  const [quick, setQuick] = useState('');
  const [capturing, setCapturing] = useState(false);
  /**
   * Which findings are ticked, and the last one ticked so shift can select a range.
   *
   * Ids rather than indices: the list re-sorts itself the moment a severity changes, and a
   * selection held by position would silently follow the sort onto different findings.
   */
  const [picked, setPicked] = useState([]);
  const [anchor, setAnchor] = useState(null);

  /**
   * Where these findings were reported to this client before.
   *
   * Its own request because it reads every other engagement for the company: the
   * findings list must render without waiting for it, and an engagement with no
   * client — or a client with no history — simply gets nothing back.
   */
  const history = useResource(`/audits/${audit._id}/history`, { initial: null });
  /** Deleted findings that can still be put back. Usually empty, so it is cheap. */
  const deleted = useResource(`/audits/${audit._id}/findings/deleted`, { initial: [] });
  const repeatsOf = (findingId) => history.data?.byFinding?.[findingId] ?? [];

  /**
   * A finding nobody has written up yet.
   *
   * Derived rather than stored: a flag would need setting, unsetting and migrating, and
   * "no description, still on the default vector" is the same thing the preflight check
   * already complains about — so the two can never disagree.
   */
  const isDraft = (finding) =>
    /*
      `hasDescription` is computed by the server with the same rule `isHtmlEmpty` applies here —
      and one it cannot: a proof of concept that is a single screenshot has no text in it, and
      calling that finding empty would tell somebody their evidence is missing.
    */
    !(finding.hasDescription ?? !isHtmlEmpty(finding.description)) &&
    (finding._cvss?.baseScore ?? 0) === 0;

  const findings = useMemo(() => {
    const list = [...(audit.findings ?? [])].map((finding) => ({
      ...finding,
      _cvss: calculateCvss(finding.cvssv3),
    }));
    if (audit.sortFindings !== false) {
      list.sort(
        (a, b) => (b._cvss.baseScore ?? -1) - (a._cvss.baseScore ?? -1) || a.title.localeCompare(b.title)
      );
    } else {
      list.sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
    }
    return list;
  }, [audit.findings, audit.sortFindings]);

  /**
   * Walking the list on the keyboard.
   *
   * `j`/`k` or the arrows to move, Enter or `o` to open, `e` to open straight into the editor,
   * Escape to put the cursor away. Reviewing forty findings was forty round trips to the mouse.
   *
   * The cursor is a highlight rather than DOM focus: the rows are list items containing their own
   * controls — a checkbox, two reorder buttons — and moving real focus onto the row would take it
   * off whichever of those somebody had just used. It scrolls itself into view, because a cursor
   * that walks off the bottom of the screen is worse than none.
   */
  const [cursor, setCursor] = useState(-1);
  useEffect(() => {
    const onKeyDown = (event) => {
      const intent = listKey(event);
      if (!intent || !findings.length) return;

      if (intent === 'clear') {
        setCursor(-1);
        return;
      }
      if (intent === 'next' || intent === 'previous') {
        event.preventDefault();
        setCursor((current) => {
          const step = intent === 'next' ? 1 : -1;
          /* From nowhere, the first press lands on the top rather than the second row. */
          if (current < 0) return intent === 'next' ? 0 : findings.length - 1;
          return Math.min(findings.length - 1, Math.max(0, current + step));
        });
        return;
      }
      const finding = findings[cursor];
      if (!finding) return;
      event.preventDefault();
      /* Both open the finding; `e` is the one that says "and I intend to type". */
      select(finding._id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [findings, cursor]);

  /* A filter that shortens the list must not leave the cursor pointing past the end of it. */
  useEffect(() => {
    setCursor((current) => (current >= findings.length ? findings.length - 1 : current));
  }, [findings.length]);

  // Must keep a stable identity: FindingEditor re-seeds its form whenever this
  // object changes, so a fresh `{ ...BLANK }` each render would discard whatever
  // had been typed the moment anything re-rendered this tab.
  const blankFinding = useMemo(() => ({ ...BLANK }), []);
  const selected = creating
    ? blankFinding
    : (findings.find((f) => f._id === selectedId) ?? null);

  /*
   * Ticking one, or a run of them.
   *
   * Shift-click extends from the last thing ticked, because the commonest selection by a mile is
   * "every Medium", and after a sort by score they are contiguous. Anything that has since left
   * the list is dropped on every render below rather than tracked here.
   */
  const toggle = (id, index, shiftKey) => {
    setPicked((current) => {
      if (shiftKey && anchor !== null) {
        const from = Math.min(anchor, index);
        const to = Math.max(anchor, index);
        const span = findings.slice(from, to + 1).map((finding) => finding._id);
        return [...new Set([...current, ...span])];
      }
      return current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id];
    });
    setAnchor(index);
  };

  /*
   * The selection, minus anything that is no longer here.
   *
   * A batch move takes findings off this engagement and the poll brings back a shorter list, so a
   * stale id would be sent to the next action and skipped as "missing" — technically handled, but
   * it would say something confusing about a finding nobody can see.
   */
  const selectedIds = useMemo(
    () => picked.filter((id) => findings.some((finding) => finding._id === id)),
    [picked, findings]
  );
  const allPicked = findings.length > 0 && selectedIds.length === findings.length;

  const closeEditor = () => {
    setCreating(false);
    if (selectedId) navigate(`/engagements/${audit._id}?tab=findings`);
  };

  /**
   * What to do once a finding has been written.
   *
   * The whole engagement used to be refetched — every other finding's rich text, every section,
   * every note — to pick up a change to one title. The write now answers with the finding in the
   * same shape a read gives, so it can be dropped into the copy this page already holds.
   *
   * The full reload stays as the fallback for anything that changes more than one finding, and for
   * a response that arrives in an unexpected shape: being slow is much better than being wrong, and
   * a page showing a finding that is not what the server has is the failure worth avoiding.
   */
  const afterSave = async (saved) => {
    if (saved?._id && onPatch) {
      const known = (audit.findings ?? []).some((finding) => finding._id === saved._id);
      onPatch({
        findings: known
          ? (audit.findings ?? []).map((finding) => (finding._id === saved._id ? saved : finding))
          : [...(audit.findings ?? []), saved],
      });
    } else {
      await onReload({ quiet: true });
    }
    closeEditor();
  };

  /**
   * The findings as a spreadsheet.
   *
   * Offered here rather than beside Generate report, because it is the findings being
   * exported and this is where somebody is looking at them. It needs no template: the
   * report is a document, this is data.
   */
  const [exporting, setExporting] = useState(false);
  const downloadSheet = async () => {
    setExporting(true);
    try {
      const response = await api.raw(`/audits/${audit._id}/findings.xlsx`);
      const blob = await response.blob();
      downloadBlob(blob, filenameFromResponse(response, `Findings — ${audit.name}.xlsx`));
      toast.success('Spreadsheet downloaded', 'One row per finding, with a summary sheet.');
    } catch (error) {
      toast.fromError(error, 'Could not build the spreadsheet');
    } finally {
      setExporting(false);
    }
  };

  /**
   * Emptying one row of the trash, before the window passes.
   *
   * Confirmed separately from the ordinary delete, and worded differently: the first has an
   * undo, this one has nothing after it.
   */
  const purge = async () => {
    if (!pendingPurge) return;
    setPurging(true);
    try {
      await api.del(`/audits/${audit._id}/findings/deleted/${pendingPurge.findingId}`);
      setPendingPurge(null);
      await deleted.reload({ quiet: true });
      toast.success('Deleted for good', 'It is not in the trash any more.');
    } catch (error) {
      toast.fromError(error);
      // Somebody else may have restored or purged it while this dialog was open.
      await deleted.reload({ quiet: true });
      setPendingPurge(null);
    } finally {
      setPurging(false);
    }
  };

  const restore = async (findingId, title) => {
    try {
      await api.post(`/audits/${audit._id}/findings/${findingId}/restore`, {});
      toast.success(`"${title}" is back`);
      await Promise.all([onReload({ quiet: true }), deleted.reload({ quiet: true })]);
    } catch (error) {
      toast.fromError(error);
      await deleted.reload({ quiet: true });
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    const { _id: deletedId, title } = pendingDelete;
    setDeleting(true);
    try {
      const result = await api.del(`/audits/${audit._id}/findings/${deletedId}`);
      // The undo belongs next to the action, not in a list somewhere else — but the
      // finding is kept either way, so missing the toast costs nothing.
      toast.withAction(
        'Finding deleted',
        `Kept for ${result?.restorableForDays ?? 15} days in case you want it back.`,
        { label: 'Undo', onClick: () => restore(deletedId, title) }
      );
      if (selectedId === deletedId) closeEditor();
      setPendingDelete(null);
      await Promise.all([onReload({ quiet: true }), deleted.reload({ quiet: true })]);
    } catch (error) {
      toast.fromError(error);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * Writes down a title and nothing else.
   *
   * The full editor is right for writing a finding up and wrong for finding one: while
   * testing you want "IDOR on /invoices" recorded in four seconds and to keep going. So
   * this creates the finding, leaves the list where it is, and puts the cursor back in
   * the box — five in a row without touching the mouse.
   *
   * Everything else is left at its default on purpose. A finding with no description and
   * an unscored vector reads as a draft below, and the report's preflight already refuses
   * to let one through unnoticed.
   */
  const capture = async (event) => {
    event.preventDefault();
    const title = quick.trim();
    if (!title) return;
    setCapturing(true);
    try {
      const created = await api.post(`/audits/${audit._id}/findings`, { title });
      setQuick('');
      await onReload({ quiet: true });
      toast.withAction('Noted', 'Left as a draft — the scoring and the write-up can wait.', {
        label: 'Write it up now',
        onClick: () => select(created._id),
      });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setCapturing(false);
    }
  };

  /** Manual reordering switches the engagement off automatic CVSS sorting. */
  const move = async (index, direction) => {
    const next = [...findings];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target], next[index]];
    setReordering(true);
    try {
      await api.put(`/audits/${audit._id}/findings-order`, { order: next.map((f) => f._id) });
      await onReload({ quiet: true });
    } catch (error) {
      toast.fromError(error);
    } finally {
      setReordering(false);
    }
  };

  if (selected) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <h2 className="truncate text-sm font-semibold text-fg">
            {creating ? 'New finding' : selected.title}
          </h2>
          <Button variant="ghost" size="sm" icon={X} onClick={closeEditor}>
            Back to list
          </Button>
        </div>
        <FindingEditor
          key={selected._id ?? 'new'}
          finding={selected}
          auditId={audit._id}
          editable={editable}
          previously={repeatsOf(selected._id)}
          siblings={(audit.findings ?? []).filter((entry) => entry._id !== selected._id)}
          onOpen={select}
          locale={audit.language ?? 'en'}
          customFieldDefs={customFields.data}
          onReload={() => onReload({ quiet: true })}
          onSaved={afterSave}
          onClose={closeEditor}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-fg-muted">
          {audit.sortFindings !== false
            ? 'Ordered automatically by CVSS score.'
            : 'Manual order — drag with the arrows to rearrange.'}
        </p>
        <div className="flex items-center gap-2">
          {findings.length ? (
            <Button
              variant="ghost"
              size="sm"
              icon={FileSpreadsheet}
              loading={exporting}
              onClick={downloadSheet}
              title="Every finding as a row — the tracker a client can work from"
            >
              Spreadsheet
            </Button>
          ) : null}
          {editable ? (
            <>
              <Button
                variant="secondary"
                size="sm"
                icon={BookOpen}
                onClick={() => setLibraryOpen(true)}
              >
                From library
              </Button>
              <Button
                variant="ghost"
                size="sm"
                icon={FileSpreadsheet}
                title="Import findings from an .xlsx or a CSV"
                onClick={() => setImportOpen(true)}
              >
                From a sheet
              </Button>
              <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                New finding
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* Capture first, write up later. Deliberately above the list: during a test this
          is the control being used, and the list is the thing being added to. */}
      {editable ? (
        <Card>
          <form onSubmit={capture} className="flex items-center gap-2 px-3 py-2.5">
            <Zap size={15} className="shrink-0 text-brand-300" />
            <input
              value={quick}
              onChange={(event) => setQuick(event.target.value)}
              placeholder="Note a finding and keep testing — a title is enough"
              aria-label="Quick-capture a finding"
              className="min-w-0 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
            />
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              icon={Plus}
              loading={capturing}
              disabled={!quick.trim()}
            >
              Add
            </Button>
          </form>
        </Card>
      ) : null}

      <Card>
        {/*
          Only once something is ticked. An empty header row with a checkbox in it on every
          engagement would be a permanent invitation to a feature most days do not need.
        */}
        {editable && findings.length > 1 && selectedIds.length > 0 ? (
          <div className="flex items-center gap-3 border-b border-line-soft px-4 py-2">
            <input
              type="checkbox"
              checked={allPicked}
              onChange={() => setPicked(allPicked ? [] : findings.map((finding) => finding._id))}
              aria-label={allPicked ? 'Clear the selection' : 'Select every finding'}
              className="size-3.5 cursor-pointer accent-brand-500"
            />
            <span className="text-xs text-fg-muted">
              {allPicked ? 'All' : selectedIds.length} of {findings.length} selected
              <span className="ml-2 text-fg-subtle">shift-click to take a run</span>
            </span>
          </div>
        ) : null}
        {findings.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title="No findings yet"
            description="Add findings by hand, or pull one in from your reusable vulnerability library."
            actionLabel={editable ? 'New finding' : undefined}
            actionIcon={Plus}
            onAction={editable ? () => setCreating(true) : undefined}
          />
        ) : (
          <ul className="divide-y divide-line-soft">
            {findings.map((finding, index) => (
              <li
                key={finding._id}
                ref={
                  index === cursor
                    ? (node) => node?.scrollIntoView({ block: 'nearest' })
                    : undefined
                }
                className={cn(
                  'group flex items-center gap-3 px-4 py-3',
                  selectedIds.includes(finding._id) && 'bg-brand-500/[0.07]',
                  /* The cursor, as a rail down the left edge: visible without moving anything. */
                  index === cursor && 'bg-white/[0.04] shadow-[inset_2px_0_0_0_var(--color-brand-500)]'
                )}
              >
                {/*
                  One click ticks, shift-click takes the run. Its own control rather than making the
                  row do both, because the row opens the finding and a list where clicking sometimes
                  opens and sometimes selects is a list people stop trusting.
                */}
                {editable ? (
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(finding._id)}
                    onChange={(event) => toggle(finding._id, index, event.nativeEvent.shiftKey)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`Select ${finding.title}`}
                    className="size-3.5 shrink-0 cursor-pointer accent-brand-500"
                  />
                ) : null}
                {editable && audit.sortFindings === false ? (
                  <div className="flex shrink-0 flex-col">
                    <button
                      type="button"
                      disabled={index === 0 || reordering}
                      onClick={() => move(index, -1)}
                      aria-label="Move up"
                      className="rounded p-0.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg disabled:opacity-25"
                    >
                      <ChevronUp size={13} />
                    </button>
                    <button
                      type="button"
                      disabled={index === findings.length - 1 || reordering}
                      onClick={() => move(index, 1)}
                      aria-label="Move down"
                      className="rounded p-0.5 text-fg-subtle transition hover:bg-white/5 hover:text-fg disabled:opacity-25"
                    >
                      <ChevronDown size={13} />
                    </button>
                  </div>
                ) : (
                  <span className="w-6 shrink-0 text-center font-mono text-xs text-fg-subtle">
                    {index + 1}
                  </span>
                )}

                <button
                  type="button"
                  onClick={() => select(finding._id)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg group-hover:text-brand-300">
                      {finding.title}
                    </span>
                    {/*
                      The severity the team is standing behind, which is not always the vector's.
                      The list used to show the score's own rating and nothing else, so an override
                      — the whole point of which is that it is what gets reported — was invisible
                      until somebody opened the finding. The score stays visible beside it, because
                      an override without the number it departs from is the half of the story a
                      client disputes.
                    */}
                    <SeverityBadge
                      severity={finding.severityOverride || finding._cvss.baseSeverity}
                      score={finding._cvss.baseScore}
                    />
                    {finding.severityOverride &&
                    finding.severityOverride !== finding._cvss.baseSeverity ? (
                      <span
                        title={
                          finding.severityOverrideReason ||
                          `Reported as ${finding.severityOverride}, scored ${finding._cvss.baseSeverity}`
                        }
                        className="text-[0.625rem] text-fg-subtle"
                      >
                        scored {finding._cvss.baseSeverity}
                      </span>
                    ) : null}
                    {/* Visible before you open it, so "taken" is something you can see rather
                        than something you discover after reading the whole write-up. */}
                    {finding.lockedBy ? (
                      <span
                        title={`Locked by ${displayName(finding.lockedBy)}`}
                        className="flex items-center gap-1 rounded-full bg-crit/12 px-1.5 py-0.5 text-[0.625rem] text-crit"
                      >
                        <Lock size={10} />
                        {displayName(finding.lockedBy).split(' ')[0]}
                      </span>
                    ) : null}
                    {finding.priority ? (
                      <span className="text-[0.6875rem] text-fg-subtle">
                        {PRIORITY_LABELS[finding.priority]} priority
                      </span>
                    ) : null}
                    {isDraft(finding) ? (
                      <Badge
                        tone="neutral"
                        title="No description and an unscored vector — still a note to yourself"
                      >
                        draft
                      </Badge>
                    ) : null}
                    {repeatsOf(finding._id).length ? (
                      <Badge
                        tone="warning"
                        icon={Repeat2}
                        title={`Reported before in ${repeatsOf(finding._id)
                          .map((o) => o.reference || o.auditName)
                          .join(', ')}`}
                      >
                        reported before
                      </Badge>
                    ) : null}
                    {/*
                      The client's word, not ours.
                      A status set through a client link and one set by somebody who retested it
                      are the same value and very different facts. This is the only thing on the
                      screen that tells them apart, so it stays until a person moves the status
                      themselves — at which point the server clears the claim.
                    */}
                    {finding.clientClaim?.status ? (
                      <Badge
                        tone="info"
                        icon={UserCheck}
                        title={`${finding.clientClaim.by || 'The client'} said this on ${formatDate(
                          finding.clientClaim.at
                        )}. Nobody has verified it yet.`}
                      >
                        client says {finding.clientClaim.status === 'fixed' ? 'fixed' : 'open'}
                      </Badge>
                    ) : null}
                  </div>
                  <p className="mt-0.5 truncate text-xs text-fg-muted">
                    {[finding.category, finding.vulnType].filter(Boolean).join(' · ')}
                    {/*
                      The snippet comes from the server now. The list never needed the description,
                      only the first line of it, and asking for the whole thing to show 110
                      characters is what made an engagement weigh megabytes.
                    */}
                    {finding.snippet
                      ? `${finding.category || finding.vulnType ? ' — ' : ''}${finding.snippet.slice(0, 110)}`
                      : ''}
                  </p>
                </button>

                <FindingAuthor finding={finding} />

                {editable ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    title="Delete finding"
                    className="shrink-0 hover:text-crit"
                    onClick={() => setPendingDelete(finding)}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/*
        The bar, only while something is ticked, and only for somebody who may edit. It floats
        above the page rather than sitting in the list — see the note in the component.
      */}
      {editable && selectedIds.length ? (
        <BulkFindingBar
          audit={audit}
          ids={selectedIds}
          onClear={() => {
            setPicked([]);
            setAnchor(null);
          }}
          onDone={() => onReload({ quiet: true })}
        />
      ) : null}

      {/* Recently deleted. Absent entirely when nothing has been deleted, so it is a
          way back rather than a permanent reminder of a decision already made. */}
      {(deleted.data ?? []).length ? (
        <Card>
          <CardHeader
            icon={Undo2}
            title="Recently deleted"
            description="Findings removed from this engagement. They are kept for a while and then purged — or deleted for good here, if you already know you do not want them."
          />
          <CardBody className="flex flex-col gap-1.5">
            {deleted.data.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-wrap items-center gap-3 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
              >
                <SeverityBadge severity={entry.severity} score={entry.score} />
                <span className="min-w-0 flex-1 truncate text-xs text-fg-muted">{entry.title}</span>
                <span className="shrink-0 text-[0.625rem] text-fg-subtle">
                  {[
                    entry.deletedBy ? `by ${displayName(entry.deletedBy)}` : null,
                    timeAgo(entry.deletedAt),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {editable ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Undo2}
                      onClick={() => restore(entry.findingId, entry.title)}
                    >
                      Restore
                    </Button>
                    {/* The other half of the decision. The trash makes a mis-click
                        survivable; it should not make a deliberate deletion take a
                        fortnight, so there is a way out of it now. */}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      icon={Trash2}
                      title="Delete for good"
                      className="hover:text-crit"
                      onClick={() => setPendingPurge(entry)}
                    />
                  </span>
                ) : null}
              </div>
            ))}
          </CardBody>
        </Card>
      ) : null}

      <LibraryPicker
        open={libraryOpen}
        onClose={() => setLibraryOpen(false)}
        auditId={audit._id}
        locale={audit.language ?? 'en'}
        onImported={() => onReload({ quiet: true })}
      />

      <ImportFindingsDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        auditId={audit._id}
        onImported={() => onReload({ quiet: true })}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete this finding?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.title}" leaves this engagement, and can be restored from the list at the bottom of this tab. The library entry it came from, if any, is untouched.`}
      />

      <ConfirmDialog
        open={Boolean(pendingPurge)}
        onClose={() => setPendingPurge(null)}
        onConfirm={purge}
        loading={purging}
        title="Delete for good?"
        confirmLabel="Delete permanently"
        message={`"${pendingPurge?.title}" and its evidence leave the trash now. There is no undo for this one, and nothing left to restore.`}
      />
    </div>
  );
}
