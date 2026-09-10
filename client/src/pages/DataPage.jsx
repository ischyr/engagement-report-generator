import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowUpRight,
  Building2,
  ChevronDown,
  ChevronRight,
  Database,
  HardDrive,
  Pencil,
  Plus,
  Tags,
  Trash2,
  Users,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { formatBytes } from '../lib/utils.js';

import { Card, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, Tabs, TagChip } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select, Textarea } from '../components/ui/Field.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';

/**
 * Every collection on this page is a flat list with a small form, so they are
 * all driven by one declarative spec rather than eight near-identical files.
 *
 * `fields` describes the form; `columns` describes the table; `toForm` maps a
 * record onto form state (needed where the API returns populated references).
 */
const COLLECTIONS = {
  companies: {
    label: 'Companies',
    icon: Building2,
    path: '/data/companies',
    singular: 'company',
    description:
      'The organisations you assess — open one for every engagement you have run for them, their contacts and what recurs. Available in templates as company.name and friends.',
    empty: 'Add the client organisations you work with.',
    labelOf: (row) => row.name,
    /*
     * A client is a relationship, not a row, and their page is where that reads as one
     * story. The way in sits with the pencil and the bin rather than being hidden in
     * the name: every other name on this page is inert reference data, so a name that
     * only became a link under the cursor was a door nobody knew was there.
     */
    rowLink: (row) => ({ to: `/clients/${row._id}`, title: `Everything for ${row.name}` }),
    columns: [
      { key: 'name', label: 'Name', primary: true },
      { key: 'shortName', label: 'Short name' },
      { key: 'website', label: 'Website' },
    ],
    /*
     * The report overrides are stored nested and edited flat: three dotted keys in a form
     * would need dotted-path support everywhere, for one client of it.
     */
    toForm: (row) => ({
      ...row,
      reportDateFormat: row.report?.dateFormat ?? '',
      reportFindingIdPrefix: row.report?.findingIdPrefix ?? '',
      reportCaptionStyle: row.report?.captionStyle ?? '',
      sevCritical: row.report?.severityLabels?.critical ?? '',
      sevHigh: row.report?.severityLabels?.high ?? '',
      sevMedium: row.report?.severityLabels?.medium ?? '',
      sevLow: row.report?.severityLabels?.low ?? '',
      sevNone: row.report?.severityLabels?.none ?? '',
    }),
    toPayload: (form) => {
      const {
        reportDateFormat,
        reportFindingIdPrefix,
        reportCaptionStyle,
        sevCritical,
        sevHigh,
        sevMedium,
        sevLow,
        sevNone,
        report: _ignored,
        ...rest
      } = form;
      return {
        ...rest,
        report: {
          dateFormat: reportDateFormat ?? '',
          findingIdPrefix: reportFindingIdPrefix ?? '',
          captionStyle: reportCaptionStyle ?? '',
          severityLabels: {
            critical: sevCritical ?? '',
            high: sevHigh ?? '',
            medium: sevMedium ?? '',
            low: sevLow ?? '',
            none: sevNone ?? '',
          },
        },
      };
    },
    fields: [
      { key: 'name', label: 'Name', required: true, placeholder: 'Acme Industries S.R.L.' },
      { key: 'shortName', label: 'Short name', placeholder: 'Acme' },
      { key: 'address', label: 'Address', type: 'textarea' },
      { key: 'website', label: 'Website', placeholder: 'https://acme.example' },
      {
        key: 'reportDateFormat',
        label: 'Date format for this client',
        placeholder: 'Leave empty to use the instance setting',
        hint: 'Patterns: yyyy MM dd MMMM MMM EEEE. A German client can have dd.MM.yyyy while everybody else keeps the default.',
      },
      {
        key: 'reportFindingIdPrefix',
        label: 'Finding ID prefix',
        placeholder: 'Leave empty to use the instance setting',
        hint: 'What their report calls a finding: VULN-, ACME-, or nothing at all.',
      },
      {
        key: 'reportCaptionStyle',
        label: 'Caption style',
        placeholder: 'Leave empty to use the instance setting',
        hint: 'The Word style used for figure captions in their template, if it is not the usual Caption.',
      },
      {
        key: 'sevCritical',
        label: 'Their word for Critical',
        placeholder: 'Critical',
        hint: 'Only for a client who runs their own scale — P1, Severe, whatever they use. Empty keeps the standard word. The app itself always says Critical.',
      },
      { key: 'sevHigh', label: 'Their word for High', placeholder: 'High' },
      { key: 'sevMedium', label: 'Their word for Medium', placeholder: 'Medium' },
      { key: 'sevLow', label: 'Their word for Low', placeholder: 'Low' },
      {
        key: 'sevNone',
        label: 'Their word for Informational',
        placeholder: 'Informational',
      },
    ],
  },

  clients: {
    label: 'Contacts',
    icon: Users,
    path: '/data/clients',
    singular: 'contact',
    description: 'Named people at each company — the "prepared for" line on the report.',
    empty: 'Add the people who receive your reports.',
    labelOf: (row) => [row.firstname, row.lastname].filter(Boolean).join(' ') || row.email,
    /*
     * Grouped under the company rather than carrying it in a column.
     *
     * A contact only means anything alongside the company they work for, and a flat list stops
     * answering that as soon as a client has more than a couple of people on it: the name repeats
     * down a column, so telling one client's distribution list from another's means reading every
     * row. Under a heading, "who at Northwind gets this report" is one glance.
     *
     * The freed column goes to the phone number, which is on the contact and was not shown
     * anywhere on this page — the field a report's contact table wants next after the email.
     */
    groupBy: {
      keyOf: (row) => row.company?._id ?? row.company ?? '',
      labelOf: (row) => row.company?.name ?? 'No company',
      countLabel: (count) => `${count} contact${count === 1 ? '' : 's'}`,
    },
    searchIn: (row) => [row.firstname, row.lastname, row.email, row.title, row.company?.name],
    columns: [
      {
        key: 'name',
        label: 'Name',
        primary: true,
        render: (row) => [row.firstname, row.lastname].filter(Boolean).join(' ') || '—',
      },
      { key: 'email', label: 'Email' },
      { key: 'title', label: 'Job title' },
      { key: 'phone', label: 'Phone', render: (row) => row.phone || row.cell || '—' },
    ],
    toForm: (row) => ({ ...row, company: row.company?._id ?? row.company ?? '' }),
    fields: [
      { key: 'email', label: 'Email', required: true, type: 'email' },
      { key: 'firstname', label: 'First name' },
      { key: 'lastname', label: 'Last name' },
      { key: 'title', label: 'Job title', placeholder: 'CISO' },
      { key: 'phone', label: 'Phone' },
      { key: 'cell', label: 'Mobile' },
      { key: 'company', label: 'Company', type: 'ref', refPath: '/data/companies', refLabel: 'name' },
    ],
  },

  'audit-types': {
    label: 'Engagement types',
    icon: Database,
    path: '/data/audit-types',
    singular: 'engagement type',
    description:
      'A blueprint for a kind of job: the sections, the methodology, who reviews it and the scope groups. A new engagement of this type arrives set up.',
    empty: 'Define the kinds of assessment you deliver.',
    labelOf: (row) => row.name,
    columns: [
      { key: 'name', label: 'Name', primary: true },
      {
        key: 'blueprint',
        label: 'Sets up',
        // One column summarising the whole blueprint — the detail lives in the form.
        render: (row) => {
          const parts = [];
          // First, because it changes which tabs the engagement has rather than what is in them.
          if (row.kind === 'phishing') parts.push('a phishing campaign');
          if (row.sections?.length) parts.push(`${row.sections.length} sections`);
          if (row.checklists?.length) {
            parts.push(
              row.checklists.length === 1
                ? (row.checklists[0].name ?? '1 checklist')
                : `${row.checklists.length} checklists`
            );
          }
          if (row.scopeGroups?.length) parts.push(`${row.scopeGroups.length} scope groups`);
          if (row.reviewers?.length) parts.push(`${row.reviewers.length} reviewers`);
          return parts.length ? parts.join(' · ') : '—';
        },
      },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true, placeholder: 'Web Application Penetration Test' },
      {
        key: 'kind',
        label: 'What shape of work',
        type: 'select',
        options: [
          { value: 'standard', label: 'Standard — assets and findings' },
          { value: 'phishing', label: 'Phishing campaign — a sending list' },
        ],
        hint: 'A campaign gets a sending list instead of a scope of assets. New engagements of this type arrive set up that way, so nobody has to say it twice.',
      },
      {
        key: 'sections',
        label: 'Pre-filled sections',
        type: 'multiref',
        refPath: '/data/sections',
        refValue: 'field',
        refLabel: 'name',
        hint: 'New engagements of this type start with these narrative sections.',
      },
      {
        key: 'checklists',
        label: 'Checklists to apply',
        type: 'multiref',
        refPath: '/checklists',
        refValue: '_id',
        refLabel: 'name',
        hint: 'The methodology arrives already attached, on the Checks tab. Copied in, so later edits to a checklist never change an engagement underway.',
      },
      {
        key: 'scopeGroups',
        label: 'Scope groups',
        type: 'lines',
        placeholder: 'External perimeter\nDomain controllers\nWorkstation /24',
        hint: 'One per line. The groups are laid out empty; hosts get filled in during the engagement.',
      },
      {
        key: 'reviewers',
        label: 'Default reviewers',
        type: 'multiref',
        refPath: '/users',
        // /users serialises through toPublic(), which exposes 'id' rather than '_id'.
        refValue: 'id',
        refLabel: 'fullname',
        hint: 'The people who normally sign this kind of work off. Whoever creates the engagement is never added as its own reviewer.',
      },
      {
        key: 'collaborators',
        label: 'Default testers',
        type: 'multiref',
        refPath: '/users',
        refValue: 'id',
        refLabel: 'fullname',
        hint: 'Added alongside whoever creates the engagement.',
      },
    ],
  },

  sections: {
    label: 'Report sections',
    icon: Tags,
    path: '/data/sections',
    singular: 'section',
    description: 'The narrative blocks a report can contain. The field name becomes the placeholder.',
    empty: 'Define the prose sections your reports use.',
    labelOf: (row) => row.name,
    columns: [
      { key: 'name', label: 'Name', primary: true },
      {
        key: 'field',
        label: 'Template placeholder',
        render: (row) => <TagChip tag={`sections.${row.field}.rich.text`} prefix="@" />,
      },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true, placeholder: 'Executive Summary' },
      {
        key: 'field',
        label: 'Field name',
        required: true,
        placeholder: 'executive_summary',
        hint: 'Letters, digits and underscores. Used in the template placeholder — changing it later breaks existing templates.',
      },
    ],
  },

  'vulnerability-types': {
    label: 'Vulnerability types',
    icon: Tags,
    path: '/data/vulnerability-types',
    singular: 'vulnerability type',
    description: 'Broad classification for a finding — Web Application, Active Directory, and so on.',
    empty: 'Add the categories of testing you perform.',
    labelOf: (row) => row.name,
    columns: [
      { key: 'name', label: 'Name', primary: true },
      { key: 'locale', label: 'Locale' },
    ],
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'locale', label: 'Locale', placeholder: 'en', defaultValue: 'en' },
    ],
  },

  'vulnerability-categories': {
    label: 'Categories',
    icon: Tags,
    path: '/data/vulnerability-categories',
    singular: 'category',
    description: 'Groups findings in the report — Injection, Access Control, Cryptography.',
    empty: 'Add the categories you group findings by.',
    labelOf: (row) => row.name,
    columns: [{ key: 'name', label: 'Name', primary: true }],
    fields: [{ key: 'name', label: 'Name', required: true, placeholder: 'Injection' }],
  },

  languages: {
    label: 'Languages',
    icon: Tags,
    path: '/data/languages',
    singular: 'language',
    description: 'Report locales. Library entries can hold text per locale.',
    empty: 'Add the languages you write reports in.',
    labelOf: (row) => row.language,
    columns: [
      { key: 'language', label: 'Language', primary: true },
      { key: 'locale', label: 'Locale' },
    ],
    fields: [
      { key: 'language', label: 'Language', required: true, placeholder: 'English' },
      { key: 'locale', label: 'Locale code', required: true, placeholder: 'en' },
    ],
  },

  'custom-fields': {
    label: 'Custom fields',
    icon: Database,
    path: '/data/custom-fields',
    singular: 'custom field',
    adminOnly: true,
    description:
      'Your own fields on engagements or findings. Each becomes a placeholder like custom.KEY.',
    empty: 'Add fields specific to how your team reports.',
    labelOf: (row) => row.label,
    columns: [
      { key: 'label', label: 'Label', primary: true },
      { key: 'key', label: 'Placeholder', render: (row) => <TagChip tag={`custom.${row.key}`} /> },
      { key: 'display', label: 'Appears on', render: (row) => <Badge tone="brand">{row.display}</Badge> },
      { key: 'fieldType', label: 'Type' },
    ],
    toForm: (row) => ({
      ...row,
      optionsText: (row.options ?? []).map((o) => o.value).join('\n'),
    }),
    toPayload: (form) => {
      const { optionsText, ...rest } = form;
      return {
        ...rest,
        options: String(optionsText ?? '')
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean)
          .map((value) => ({ locale: 'en', value })),
      };
    },
    fields: [
      { key: 'label', label: 'Label', required: true, placeholder: 'Affected Environment' },
      {
        key: 'key',
        label: 'Key',
        required: true,
        placeholder: 'environment',
        hint: 'Used in templates as custom.KEY. Letters, digits and underscores.',
      },
      {
        key: 'display',
        label: 'Appears on',
        type: 'select',
        required: true,
        defaultValue: 'finding',
        options: [
          { value: 'finding', label: 'Findings' },
          { value: 'audit', label: 'Engagements' },
          { value: 'vulnerability', label: 'Library entries' },
          { value: 'section', label: 'Sections' },
          { value: 'general', label: 'General' },
        ],
      },
      {
        key: 'fieldType',
        label: 'Input type',
        type: 'select',
        defaultValue: 'input',
        options: [
          { value: 'input', label: 'Single line' },
          { value: 'textarea', label: 'Multi-line' },
          { value: 'select', label: 'Dropdown' },
          { value: 'date', label: 'Date' },
          { value: 'checkbox', label: 'Checkbox' },
        ],
      },
      {
        key: 'optionsText',
        label: 'Dropdown options',
        type: 'textarea',
        hint: 'One per line. Only used for dropdowns.',
      },
      { key: 'description', label: 'Help text', type: 'textarea' },
    ],
  },
};

const TAB_ORDER = [
  'companies',
  'clients',
  'audit-types',
  'sections',
  'vulnerability-types',
  'vulnerability-categories',
  'languages',
  'custom-fields',
];

/* -------------------------------------------------------------------------- */

function RecordModal({ open, onClose, spec, record, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState({});

  /*
   * Reference dropdowns fetch their own options. Hooks cannot be called in a loop,
   * so there is a fixed number of slots — four distinct paths is enough for every
   * spec here (the engagement-type blueprint uses three), and a fifth would fetch
   * nothing rather than fail quietly, which is why the count is asserted below.
   */
  const refPaths = [...new Set(spec.fields.filter((f) => f.refPath).map((f) => f.refPath))];
  const refA = useResource(open && refPaths[0] ? refPaths[0] : null, { initial: [] });
  const refB = useResource(open && refPaths[1] ? refPaths[1] : null, { initial: [] });
  const refC = useResource(open && refPaths[2] ? refPaths[2] : null, { initial: [] });
  const refD = useResource(open && refPaths[3] ? refPaths[3] : null, { initial: [] });
  const refData = useMemo(() => {
    const slots = [refA.data, refB.data, refC.data, refD.data];
    if (refPaths.length > slots.length) {
      // Loud in development rather than a silently empty picker.
      console.warn(`${spec.label}: ${refPaths.length} reference sources, only ${slots.length} slots`);
    }
    return Object.fromEntries(refPaths.map((p, i) => [p, slots[i] ?? []]));
  }, [refPaths, refA.data, refB.data, refC.data, refD.data, spec.label]);

  // Seed the form when the modal opens or the target record changes.
  useEffect(() => {
    if (!open) return;
    const base = {};
    for (const field of spec.fields) base[field.key] = field.defaultValue ?? '';

    const seeded = record ? { ...base, ...(spec.toForm ? spec.toForm(record) : record) } : base;

    // The API returns references populated, so normalise them back to the ids the
    // pickers compare against — otherwise editing a record shows nothing selected.
    for (const field of spec.fields) {
      if (field.type === 'multiref' && Array.isArray(seeded[field.key])) {
        seeded[field.key] = seeded[field.key].map((value) =>
          value && typeof value === 'object' ? value[field.refValue ?? '_id'] : value
        );
      }
      if (field.type === 'lines') {
        seeded[field.key] = Array.isArray(seeded[field.key]) ? seeded[field.key].join('\n') : '';
      }
    }

    setForm(seeded);
    setErrors({});
  }, [open, record, spec]);

  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const save = async () => {
    const nextErrors = {};
    for (const field of spec.fields) {
      if (field.required && !String(form[field.key] ?? '').trim()) {
        nextErrors[field.key] = 'Required';
      }
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSaving(true);
    try {
      const payload = spec.toPayload ? spec.toPayload(form) : { ...form };
      // Strip fields the API does not accept back.
      for (const key of ['_id', '__v', 'createdAt', 'updatedAt', 'uploadedBy']) delete payload[key];
      for (const field of spec.fields) {
        if (field.type === 'ref' && payload[field.key] === '') payload[field.key] = null;
        // A `lines` field is edited as text and stored as an array.
        if (field.type === 'lines') {
          payload[field.key] = String(payload[field.key] ?? '')
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean);
        }
      }

      if (record?._id) await api.put(`${spec.path}/${record._id}`, payload);
      else await api.post(spec.path, payload);

      toast.success(record?._id ? `${spec.singular} updated` : `${spec.singular} added`);
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
      title={record?._id ? `Edit ${spec.singular}` : `New ${spec.singular}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4">
        {spec.fields.map((field) => {
          const common = {
            key: field.key,
            label: field.label,
            hint: field.hint,
            required: field.required,
            error: errors[field.key],
            value: form[field.key] ?? '',
            onChange: (event) => set(field.key, event.target.value),
          };

          if (field.type === 'textarea') return <Textarea {...common} rows={3} />;

          if (field.type === 'select') {
            return <Select {...common} options={field.options} placeholder="Choose…" />;
          }

          if (field.type === 'ref') {
            const options = (refData[field.refPath] ?? []).map((row) => ({
              value: row._id,
              label: row[field.refLabel] ?? row.name ?? row._id,
            }));
            return <Select {...common} options={options} placeholder="Not set" />;
          }

          // One value per line, stored as an array. Nicer than a tag input for
          // things people paste, like a list of scope groups.
          if (field.type === 'lines') {
            return <Textarea {...common} rows={4} className="font-mono text-xs" />;
          }

          if (field.type === 'multiref') {
            const rows = refData[field.refPath] ?? [];
            const selected = Array.isArray(form[field.key]) ? form[field.key] : [];
            return (
              <div key={field.key} className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-fg-muted">{field.label}</span>
                <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto rounded-lg bg-canvas/60 p-1.5 ring-1 ring-line">
                  {rows.length === 0 ? (
                    <p className="px-2 py-1.5 text-xs text-fg-subtle">Nothing to choose from yet.</p>
                  ) : (
                    rows.map((row) => {
                      const value = row[field.refValue ?? '_id'];
                      const checked = selected.includes(value);
                      return (
                        <label
                          key={value}
                          className="flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 text-xs text-fg transition hover:bg-white/5"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() =>
                              set(
                                field.key,
                                checked
                                  ? selected.filter((v) => v !== value)
                                  : [...selected, value]
                              )
                            }
                            className="size-3.5 rounded border-line bg-canvas accent-brand-500"
                          />
                          {row[field.refLabel] ?? value}
                        </label>
                      );
                    })
                  )}
                </div>
                {field.hint ? (
                  <p className="text-xs leading-relaxed text-fg-subtle">{field.hint}</p>
                ) : null}
              </div>
            );
          }

          return <Input {...common} type={field.type ?? 'text'} placeholder={field.placeholder} />;
        })}
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * How much evidence is stored.
 *
 * Worth showing now that screenshots live in GridFS rather than inside the
 * engagement document: the old 16 MB-per-engagement ceiling was an accidental
 * limit, and with it gone the only real one is disk.
 */
function EvidenceUsage() {
  const { data } = useResource('/media/usage', { initial: null });
  if (!data) return null;

  return (
    <span
      title="Screenshots and evidence stored outside the engagement documents. Reclaim unreferenced files with `npm run media:gc`."
      className="flex items-center gap-2 rounded-lg border border-line-soft bg-surface/60 px-3 py-2 text-xs text-fg-muted"
    >
      <HardDrive size={14} className="shrink-0 text-fg-subtle" />
      <span className="font-medium text-fg">{formatBytes(data.bytes)}</span>
      of evidence in {data.files} file{data.files === 1 ? '' : 's'}
    </span>
  );
}

export default function DataPage() {
  const toast = useToast();
  const { canWrite, isAdmin } = useAuth();
  const [active, setActive] = useState('companies');
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);

  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState(() => new Set());

  const spec = COLLECTIONS[active];
  const { data, error, loading, reload } = useResource(spec.path, { initial: [] });
  const all = Array.isArray(data) ? data : [];

  const mayEdit = canWrite && (!spec.adminOnly || isAdmin);

  /** What the search box matched, or everything when the collection has no search. */
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!spec.searchIn || !needle) return all;
    return all.filter((row) =>
      spec
        .searchIn(row)
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(needle))
    );
  }, [all, query, spec]);

  /**
   * The rows under their headings: `[{ key, label, rows }]`, or null when this collection is flat.
   *
   * Alphabetical, with the ungrouped ones last — a "No company" heading above the named ones reads
   * as the most important group on the page, when it is the one nobody has filled in yet.
   */
  const groups = useMemo(() => {
    if (!spec.groupBy) return null;

    /*
     * Coerced, because for one render the rows are the previous tab's.
     *
     * Switching tab changes `spec` immediately while the fetch for the new collection is still in
     * flight, so this runs once with companies being asked for a contact's name — and a spec's
     * `labelOf` returns undefined for a record it was not written for. Sorting on that threw and
     * took the page with it. Nothing else called `labelOf` during a render, which is why the tab
     * switch was safe before.
     */
    const text = (value) => (value === undefined || value === null ? '' : String(value));

    const map = new Map();
    for (const row of rows) {
      const key = text(spec.groupBy.keyOf(row));
      if (!map.has(key)) map.set(key, { key, label: text(spec.groupBy.labelOf(row)), rows: [] });
      map.get(key).rows.push(row);
    }
    const sorted = [...map.values()].sort((a, b) => {
      if (!a.key !== !b.key) return a.key ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
    for (const group of sorted) {
      group.rows.sort((a, b) => text(spec.labelOf(a)).localeCompare(text(spec.labelOf(b))));
    }
    return sorted;
  }, [rows, spec]);

  const toggleGroup = (key) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  /** One record's row. Shared, so a grouped list and a flat one cannot drift apart. */
  const recordRow = (row) => (
    <TR key={row._id}>
      {spec.columns.map((column) => (
        <TD
          key={column.key}
          className={
            column.primary
              ? 'max-w-xs truncate text-sm font-medium text-fg'
              : 'max-w-xs truncate text-xs text-fg-muted'
          }
        >
          {column.render ? column.render(row) : (row[column.key] ?? '—') || '—'}
        </TD>
      ))}
      <TD align="right">
        <div className="flex items-center justify-end gap-1">
          {/* Not gated on edit rights: opening a client's page is reading,
              and which clients you may read is enforced server-side. */}
          {spec.rowLink ? (
            <Button as={Link} variant="ghost" size="sm" iconRight={ArrowUpRight} {...spec.rowLink(row)}>
              Open
            </Button>
          ) : null}
          {mayEdit ? (
            <>
              <Button
                variant="ghost"
                size="icon-sm"
                icon={Pencil}
                title="Edit"
                onClick={() => setEditing(row)}
              />
              <Button
                variant="ghost"
                size="icon-sm"
                icon={Trash2}
                title="Delete"
                className="hover:text-crit"
                onClick={() => setPendingDelete(row)}
              />
            </>
          ) : null}
        </div>
      </TD>
    </TR>
  );

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`${spec.path}/${pendingDelete._id}`);
      toast.success(`${spec.singular} deleted`);
      setPendingDelete(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Clients & data"
        description="The reference data every engagement draws on — companies, contacts, taxonomies and your own custom fields."
        actions={<EvidenceUsage />}
      />

      <Tabs
        options={TAB_ORDER.filter((key) => !COLLECTIONS[key].adminOnly || isAdmin).map((key) => ({
          value: key,
          label: COLLECTIONS[key].label,
        }))}
        value={active}
        onChange={(next) => {
          setActive(next);
          setEditing(null);
          setQuery('');
          setCollapsed(new Set());
        }}
        size="sm"
      />

      <Card>
        <CardHeader
          title={spec.label}
          icon={spec.icon}
          description={spec.description}
          actions={
            <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
              {spec.searchIn && all.length > 0 ? (
                <SearchInput
                  value={query}
                  onChange={setQuery}
                  placeholder={`Search ${spec.label.toLowerCase()}…`}
                  className="w-full sm:w-64"
                />
              ) : null}
              {mayEdit ? (
                <Button variant="primary" size="sm" icon={Plus} onClick={() => setCreating(true)}>
                  Add {spec.singular}
                </Button>
              ) : null}
            </div>
          }
        />
        {loading ? (
          <SkeletonRows rows={4} columns={spec.columns.length} />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : all.length === 0 ? (
          <EmptyState
            icon={spec.icon}
            title={`No ${spec.label.toLowerCase()} yet`}
            description={spec.empty}
            actionLabel={mayEdit ? `Add ${spec.singular}` : undefined}
            actionIcon={Plus}
            onAction={mayEdit ? () => setCreating(true) : undefined}
          />
        ) : (
          <Table>
            <THead>
              {spec.columns.map((column) => (
                <TH key={column.key}>{column.label}</TH>
              ))}
              <TH width={spec.rowLink ? '11rem' : '5rem'} />
            </THead>
            <TBody>
              {groups
                ? groups.flatMap((group) => {
                    // A search shows what it matched: hiding a hit inside a collapsed group
                    // would read as no result at all.
                    const open = Boolean(query.trim()) || !collapsed.has(group.key);
                    const Chevron = open ? ChevronDown : ChevronRight;
                    return [
                      <TR key={`group-${group.key}`} className="bg-white/[0.03]">
                        <TD colSpan={spec.columns.length + 1} className="py-2">
                          <button
                            type="button"
                            onClick={() => toggleGroup(group.key)}
                            aria-expanded={open}
                            className="flex items-center gap-2 text-sm font-semibold text-fg transition hover:text-brand-300"
                          >
                            <Chevron size={14} className="shrink-0 text-fg-subtle" />
                            <Building2 size={14} className="shrink-0 text-fg-subtle" />
                            {group.label}
                            <span className="text-xs font-normal text-fg-subtle">
                              {spec.groupBy.countLabel(group.rows.length)}
                            </span>
                          </button>
                        </TD>
                      </TR>,
                      ...(open ? group.rows.map(recordRow) : []),
                    ];
                  })
                : rows.map(recordRow)}
              {rows.length === 0 ? (
                <TR>
                  <TD colSpan={spec.columns.length + 1} className="py-6 text-center text-sm text-fg-muted">
                    Nothing matches “{query}”.
                  </TD>
                </TR>
              ) : null}
            </TBody>
          </Table>
        )}
      </Card>

      <RecordModal
        open={creating || Boolean(editing)}
        onClose={() => {
          setCreating(false);
          setEditing(null);
        }}
        spec={spec}
        record={editing}
        onSaved={() => reload({ quiet: true })}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title={`Delete this ${spec.singular}?`}
        confirmLabel="Delete"
        message={`"${pendingDelete ? spec.labelOf(pendingDelete) : ''}" will be removed. Anything already referencing it keeps the value it copied.`}
      />
    </div>
  );
}
