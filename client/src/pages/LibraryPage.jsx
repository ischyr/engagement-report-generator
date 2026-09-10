import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Pencil, Plus, ShieldAlert, Trash2, Upload } from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { calculateCvss, CVSS_DEFAULT_VECTOR } from '../lib/cvss.js';
import { SEVERITIES, downloadBlob, filenameFromResponse, htmlToSnippet, timeAgo } from '../lib/utils.js';

import { Card } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select, Textarea } from '../components/ui/Field.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { SeverityBadge } from '../components/ui/Badge.jsx';
import { CvssEditor } from '../components/cvss/CvssEditor.jsx';
import { RichTextEditor } from '../components/editor/RichTextEditor.jsx';

const RICH_FIELDS = [
  { key: 'description', label: 'Description' },
  { key: 'observation', label: 'Impact' },
  { key: 'remediation', label: 'Remediation' },
];

function emptyEntry(locale = 'en') {
  return {
    cvssv3: CVSS_DEFAULT_VECTOR,
    category: '',
    priority: '',
    remediationComplexity: '',
    details: [
      {
        locale,
        title: '',
        vulnType: '',
        description: '',
        observation: '',
        remediation: '',
        references: [],
      },
    ],
  };
}

function EntryModal({ open, onClose, entry, onSaved }) {
  const toast = useToast();
  const vulnTypes = useResource(open ? '/data/vulnerability-types' : null, { initial: [] });
  const categories = useResource(open ? '/data/vulnerability-categories' : null, { initial: [] });

  const [form, setForm] = useState(entry ?? emptyEntry());
  const [referencesText, setReferencesText] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const next = entry ?? emptyEntry();
    setForm(next);
    setReferencesText((next.details?.[0]?.references ?? []).join('\n'));
  }, [entry, open]);

  const detail = form.details?.[0] ?? {};
  const cvss = useMemo(() => calculateCvss(form.cvssv3), [form.cvssv3]);

  const setDetail = (patch) =>
    setForm((current) => ({
      ...current,
      details: [{ ...(current.details?.[0] ?? {}), ...patch }],
    }));

  const save = async () => {
    if (!detail.title?.trim()) {
      toast.error('Give the entry a title');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        cvssv3: form.cvssv3,
        category: form.category ?? '',
        priority: form.priority === '' || form.priority === null ? null : Number(form.priority),
        remediationComplexity:
          form.remediationComplexity === '' || form.remediationComplexity === null
            ? null
            : Number(form.remediationComplexity),
        details: [
          {
            locale: detail.locale ?? 'en',
            title: detail.title,
            vulnType: detail.vulnType ?? '',
            description: detail.description ?? '',
            observation: detail.observation ?? '',
            remediation: detail.remediation ?? '',
            references: referencesText
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
            customFields: detail.customFields ?? [],
          },
        ],
      };

      if (form._id) await api.put(`/vulnerabilities/${form._id}`, payload);
      else await api.post('/vulnerabilities', payload);

      toast.success(form._id ? 'Library entry updated' : 'Added to the library');
      onSaved?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={form._id ? 'Edit library entry' : 'New library entry'}
      description="Reusable text you can drop into any engagement, then tailor per client."
      size="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            {form._id ? 'Save entry' : 'Add to library'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Title"
            required
            autoFocus
            wrapperClassName="sm:col-span-2"
            placeholder="SQL Injection"
            value={detail.title ?? ''}
            onChange={(e) => setDetail({ title: e.target.value })}
          />
          <Select
            label="Vulnerability type"
            placeholder="Not set"
            value={detail.vulnType ?? ''}
            onChange={(e) => setDetail({ vulnType: e.target.value })}
            options={(vulnTypes.data ?? []).map((t) => ({ value: t.name, label: t.name }))}
          />
          <Select
            label="Category"
            placeholder="Not set"
            value={form.category ?? ''}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
            options={(categories.data ?? []).map((c) => ({ value: c.name, label: c.name }))}
          />
          <Select
            label="Default priority"
            placeholder="Not set"
            value={form.priority ?? ''}
            onChange={(e) => setForm({ ...form, priority: e.target.value })}
            options={[
              { value: '1', label: 'Low' },
              { value: '2', label: 'Medium' },
              { value: '3', label: 'High' },
              { value: '4', label: 'Urgent' },
            ]}
          />
          <Select
            label="Default remediation effort"
            placeholder="Not set"
            value={form.remediationComplexity ?? ''}
            onChange={(e) => setForm({ ...form, remediationComplexity: e.target.value })}
            options={[
              { value: '1', label: 'Easy' },
              { value: '2', label: 'Medium' },
              { value: '3', label: 'Complex' },
            ]}
          />
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-medium text-fg-muted">Default CVSS v3.1 vector</p>
            <SeverityBadge severity={cvss.baseSeverity} score={cvss.baseScore} />
          </div>
          <CvssEditor
            value={form.cvssv3}
            onChange={(next) => setForm({ ...form, cvssv3: next })}
            showTemporal={false}
          />
        </div>

        {RICH_FIELDS.map((field) => (
          <div key={field.key}>
            <p className="mb-2 text-xs font-medium text-fg-muted">{field.label}</p>
            <RichTextEditor
              value={detail[field.key] ?? ''}
              onChange={(html) => setDetail({ [field.key]: html })}
              minHeight={140}
              compact
            />
          </div>
        ))}

        <Textarea
          label="References"
          hint="One URL per line."
          rows={3}
          value={referencesText}
          onChange={(e) => setReferencesText(e.target.value)}
          className="font-mono text-xs"
        />
      </div>
    </Modal>
  );
}

export default function LibraryPage() {
  const toast = useToast();
  const { canWrite } = useAuth();
  const { data, error, loading, reload } = useResource('/vulnerabilities', { initial: [] });

  const [search, setSearch] = useState('');
  const [severity, setSeverity] = useState('all');
  const [editing, setEditing] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const list = Array.isArray(data) ? data : [];

  const decorated = useMemo(
    () =>
      list.map((entry) => {
        const detail = entry.details?.[0] ?? {};
        const cvss = calculateCvss(entry.cvssv3);
        return { ...entry, detail, cvss };
      }),
    [list]
  );

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return decorated.filter((entry) => {
      if (severity !== 'all' && entry.cvss.baseSeverity !== severity) return false;
      if (!needle) return true;
      return [entry.detail.title, entry.category, entry.detail.vulnType, entry.detail.description]
        .filter(Boolean)
        .some((field) => field.toLowerCase().includes(needle));
    });
  }, [decorated, search, severity]);

  const tabs = useMemo(
    () => [
      { value: 'all', label: 'All', count: decorated.length },
      ...SEVERITIES.map((s) => ({
        value: s,
        label: s === 'None' ? 'Info' : s,
        count: decorated.filter((e) => e.cvss.baseSeverity === s).length,
      })),
    ],
    [decorated]
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/vulnerabilities/${pendingDelete._id}`);
      toast.success('Entry deleted');
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  /**
   * The library as one file, and back again.
   *
   * A library could only be built by hand, one entry at a time, in this instance — no way
   * to seed a new one, keep it in git, or share it with a colleague. The import endpoint
   * has existed all along with nothing to feed it and no way to reach it.
   */
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const exportLibrary = async () => {
    setBusy(true);
    try {
      const response = await api.raw('/vulnerabilities/export');
      const blob = await response.blob();
      downloadBlob(blob, filenameFromResponse(response, 'vulnerability-library.json'));
    } catch (error) {
      toast.fromError(error, 'Could not export the library');
    } finally {
      setBusy(false);
    }
  };

  const importLibrary = async (file, mode) => {
    setBusy(true);
    try {
      const bundle = JSON.parse(await file.text());
      const result = await api.post('/vulnerabilities/import', { ...bundle, mode });
      setImportResult(result);
      await reload({ quiet: true });
    } catch (error) {
      if (error instanceof SyntaxError) {
        toast.error('That is not a JSON file', 'Pick a library bundle exported from this app.');
      } else {
        toast.fromError(error, 'Could not import that bundle');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Vulnerability library"
        description="Write a finding once and reuse it. Importing into an engagement copies the text, so per-client edits never affect the library."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" icon={Download} loading={busy} onClick={exportLibrary}>
              Export
            </Button>
            {canWrite ? (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={Upload}
                  onClick={() => fileRef.current?.click()}
                >
                  Import
                </Button>
                <Button variant="primary" icon={Plus} onClick={() => setEditing(emptyEntry())}>
                  New entry
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Skip by default: re-importing a bundle should be safe, and the result panel
          // offers the update pass once you can see what would be touched.
          if (file) importLibrary(file, 'skip');
          event.target.value = '';
        }}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Tabs options={tabs} value={severity} onChange={setSeverity} size="sm" />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Search titles, categories, descriptions…"
          className="w-full sm:ml-auto sm:w-72"
        />
      </div>

      <Card>
        {loading ? (
          <SkeletonRows rows={6} columns={4} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={ShieldAlert}
            title={list.length === 0 ? 'The library is empty' : 'Nothing matches those filters'}
            description={
              list.length === 0
                ? 'Add the vulnerabilities you write up repeatedly — the descriptions, impacts and fixes you would otherwise retype each engagement.'
                : 'Try a different search term or severity.'
            }
            actionLabel={list.length === 0 && canWrite ? 'New entry' : undefined}
            actionIcon={Plus}
            onAction={list.length === 0 && canWrite ? () => setEditing(emptyEntry()) : undefined}
          />
        ) : (
          <Table>
            <THead>
              <TH>Title</TH>
              <TH>Severity</TH>
              <TH>Category</TH>
              <TH align="right">Updated</TH>
              <TH width="5rem" />
            </THead>
            <TBody>
              {filtered.map((entry) => (
                <TR key={entry._id} onClick={canWrite ? () => setEditing(entry) : undefined}>
                  <TD className="max-w-lg">
                    <p className="truncate text-sm font-medium text-fg">
                      {entry.detail.title || 'Untitled'}
                    </p>
                    {entry.detail.description ? (
                      <p className="mt-0.5 truncate text-xs text-fg-muted">
                        {htmlToSnippet(entry.detail.description, 120)}
                      </p>
                    ) : null}
                  </TD>
                  <TD>
                    <SeverityBadge
                      severity={entry.cvss.baseSeverity}
                      score={entry.cvss.baseScore}
                    />
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    {[entry.category, entry.detail.vulnType].filter(Boolean).join(' · ') || '—'}
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                    {timeAgo(entry.updatedAt)}
                  </TD>
                  <TD align="right">
                    {canWrite ? (
                      <div className="flex items-center justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Pencil}
                          title="Edit"
                          onClick={(event) => {
                            event.stopPropagation();
                            setEditing(entry);
                          }}
                        />
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={Trash2}
                          title="Delete"
                          className="hover:text-crit"
                          onClick={(event) => {
                            event.stopPropagation();
                            setPendingDelete(entry);
                          }}
                        />
                      </div>
                    ) : null}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      <EntryModal
        open={Boolean(editing)}
        entry={editing}
        onClose={() => setEditing(null)}
        onSaved={() => reload({ quiet: true })}
      />

      {/* What the import actually did. Reported rather than toasted, because "37 skipped"
          is the answer to a question and deserves reading. */}
      <Modal
        open={Boolean(importResult)}
        onClose={() => setImportResult(null)}
        title="Bundle imported"
        size="sm"
        footer={
          <Button variant="primary" onClick={() => setImportResult(null)}>
            Done
          </Button>
        }
      >
        <ul className="flex flex-col gap-1.5 text-sm text-fg">
          <li>
            <span className="font-semibold">{importResult?.added ?? 0}</span> added
          </li>
          <li>
            <span className="font-semibold">{importResult?.updated ?? 0}</span> updated
          </li>
          <li>
            <span className="font-semibold">{importResult?.skipped ?? 0}</span> skipped — already
            here, matched on category and title
          </li>
        </ul>
        {importResult?.danglingScreenshots ? (
          <p className="mt-3 rounded-lg border border-med/25 bg-med/[0.06] px-3 py-2 text-xs leading-relaxed text-fg-muted">
            {importResult.danglingScreenshots} screenshot reference
            {importResult.danglingScreenshots === 1 ? '' : 's'} point at evidence storage this
            instance does not have — the text came through, the images did not. Bundles carry
            words, not files.
          </p>
        ) : null}
        <p className="mt-3 text-[0.6875rem] leading-relaxed text-fg-subtle">
          Entries already here were left alone. Importing the same bundle twice is safe.
        </p>
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete this library entry?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.detail?.title}" will be removed from the library. Findings already copied into engagements are not affected.`}
      />
    </div>
  );
}
