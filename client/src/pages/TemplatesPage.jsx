import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BookOpen,
  Braces,
  Check,
  Download,
  FlaskConical,
  FileCode2,
  FileText,
  Info,
  Pencil,
  RefreshCw,
  ScanSearch,
  Trash2,
  TriangleAlert,
  Upload,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { downloadBlob, filenameFromResponse, formatBytes, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput, TagChip, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Modal, ConfirmDialog } from '../components/ui/Modal.jsx';
import { Input, Select, Textarea, Toggle } from '../components/ui/Field.jsx';

/** Kept in step with PROPOSAL_DOC_LABELS on the server. */
const PROPOSAL_DOC_LABELS = {
  nda: 'NDA',
  pta: 'Permission to attack',
  proposal: 'Proposal',
  sow: 'Statement of work',
  other: 'Proposal paperwork',
};
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock, SkeletonRows } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import TestRenderModal from '../components/templates/TestRenderModal.jsx';

/* -------------------------------------------------------------------------- */
/* Tag reference                                                               */
/* -------------------------------------------------------------------------- */

function TagReference() {
  const { data, loading } = useResource('/templates/tag-reference');
  const [search, setSearch] = useState('');
  /**
   * Which vocabulary. Two lists rather than one, because they are different documents: a
   * contract has no findings in it, and offering `{{ findings }}` to somebody writing an NDA
   * would be an invitation to a placeholder that renders as nothing.
   */
  const [purpose, setPurpose] = useState('report');

  const groups = useMemo(() => {
    const all = (purpose === 'proposal' ? data?.proposalGroups : data?.groups) ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return all;
    return all
      .map((group) => ({
        ...group,
        tags: group.tags.filter(
          (tag) =>
            tag.tag.toLowerCase().includes(needle) ||
            tag.description.toLowerCase().includes(needle)
        ),
      }))
      .filter((group) => group.tags.length > 0);
  }, [data, search, purpose]);

  if (loading) return <LoadingBlock label="Loading tag reference…" />;

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader
          title="How placeholders work"
          icon={Info}
          description="Put these anywhere in your .docx — body, headers, footers, tables."
        />
        <CardBody>
          <ul className="flex flex-col gap-2.5">
            {(data?.syntax?.notes ?? []).map((note) => (
              <li key={note} className="flex gap-2.5 text-xs leading-relaxed text-fg-muted">
                <span className="mt-1.5 size-1 shrink-0 rounded-full bg-brand-400" />
                {note}
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center gap-3">
        <Tabs
          options={[
            { value: 'report', label: 'Report tags' },
            { value: 'proposal', label: 'Proposal tags' },
          ]}
          value={purpose}
          onChange={setPurpose}
          size="sm"
        />
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder={
            purpose === 'proposal'
              ? "Search tags — try 'firm', 'effort' or 'client'…"
              : "Search tags — try 'severity', 'client' or 'cvss'…"
          }
          className="max-w-md flex-1"
        />
      </div>

      {purpose === 'proposal' ? (
        <p className="text-xs leading-relaxed text-fg-muted">
          For the paperwork the Sales section generates — an NDA, a permission to attack, an offer.
          The syntax and the filters above are identical; only the names differ. Your own company
          details come from Settings → Your firm.
        </p>
      ) : null}

      <div className="grid gap-5 lg:grid-cols-2">
        {groups.map((group) => (
          <Card key={group.title}>
            <CardHeader title={group.title} description={group.description} />
            <CardBody className="flex flex-col gap-2.5">
              {group.tags.map((tag) => (
                <div key={tag.tag} className="flex flex-wrap items-baseline gap-2">
                  <TagChip
                    tag={tag.tag}
                    prefix={tag.kind === 'rich' ? '@' : ''}
                  />
                  {tag.kind === 'loop' ? <Badge tone="brand">loop</Badge> : null}
                  {tag.kind === 'rich' ? <Badge tone="info">rich text</Badge> : null}
                  <p className="min-w-40 flex-1 text-xs leading-relaxed text-fg-muted">
                    {tag.description}
                  </p>
                </div>
              ))}
            </CardBody>
          </Card>
        ))}
        {groups.length === 0 ? (
          <Card className="lg:col-span-2">
            <EmptyState icon={Braces} title="No tags match that search" />
          </Card>
        ) : null}
      </div>

      <Card>
        <CardHeader title="Filters" description="Transform a value inline with a pipe." />
        <CardBody className="grid gap-2.5 sm:grid-cols-2">
          {(data?.filters ?? []).map((filter) => (
            <div key={filter.name} className="flex flex-col gap-1">
              <code className="w-fit rounded bg-canvas/70 px-1.5 py-0.5 font-mono text-[0.6875rem] text-brand-300 ring-1 ring-line">
                {filter.example}
              </code>
              <p className="text-xs leading-relaxed text-fg-muted">{filter.description}</p>
            </div>
          ))}
        </CardBody>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Upload / rename                                                             */
/* -------------------------------------------------------------------------- */

function UploadModal({ open, onClose, onUploaded }) {
  const toast = useToast();
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  /**
   * What the template is for.
   *
   * `report` by default, because that is what every template here has always been and what
   * most of them will stay. `proposal` is the paperwork the Sales section generates — same file
   * format and the same tag language, a different set of tags available to it.
   */
  const [purpose, setPurpose] = useState('report');
  const [docType, setDocType] = useState('nda');
  const [uploading, setUploading] = useState(false);

  const reset = () => {
    setFile(null);
    setName('');
    setDescription('');
    setPurpose('report');
    setDocType('nda');
  };

  const pick = (chosen) => {
    if (!chosen) return;
    if (!chosen.name.toLowerCase().endsWith('.docx')) {
      toast.error('Templates must be .docx files');
      return;
    }
    setFile(chosen);
    if (!name) setName(chosen.name.replace(/\.docx$/i, ''));
  };

  const upload = async () => {
    if (!file) {
      toast.error('Choose a .docx file first');
      return;
    }
    setUploading(true);
    try {
      const body = new FormData();
      body.append('file', file);
      body.append('name', name.trim() || file.name.replace(/\.docx$/i, ''));
      body.append('description', description.trim());
      body.append('purpose', purpose);
      if (purpose === 'proposal') body.append('docType', docType);

      const created = await api.post('/templates', body);
      const found = created.detectedTags?.length ?? 0;
      /*
       * The scope-aware analysis, when the server managed to run it.
       *
       * It knows which loop a tag sits inside and resolves it against the sample engagement, so
       * it catches `{{ .client.nmae }}` — a typo under a root that exists — which the flat root
       * check in `unknownTags` cannot see. That falls back for an instance where the analysis
       * could not run at all.
       */
      const unknown = (created.lint?.unknown ?? []).map((entry) =>
        entry.where ? `${entry.tag} (in ${entry.where})` : entry.tag
      );
      const fallback = created.unknownTags ?? [];
      const problems = unknown.length ? unknown : fallback;

      toast.success('Template uploaded', `${found} placeholder${found === 1 ? '' : 's'} detected.`);
      // Advisory, not a failure: an unrecognised placeholder simply renders
      // empty, so say what will happen rather than just listing names.
      if (problems.length) {
        toast.warning(
          `${problems.length} placeholder${problems.length === 1 ? '' : 's'} not recognised`,
          `${problems.slice(0, 4).join(', ')}${problems.length > 4 ? ', …' : ''}\n` +
            'These will render empty. Check the spelling against Templates → Tag reference.'
        );
      }
      reset();
      onUploaded?.();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Upload a template"
      description="Any Word document works. Add placeholders where you want data filled in."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={uploading}>
            Cancel
          </Button>
          <Button variant="primary" icon={Upload} loading={uploading} onClick={upload}>
            Upload
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label="What is it for"
          value={purpose}
          onChange={(event) => setPurpose(event.target.value)}
          options={[
            { value: 'report', label: 'Engagement report' },
            { value: 'proposal', label: 'Proposal paperwork (NDA, agreement, offer)' },
          ]}
          hint={
            purpose === 'proposal'
              ? 'Offered in the Sales section. Its tags are the proposal ones — see the tag reference.'
              : 'The report a finished engagement renders to.'
          }
        />
        {purpose === 'proposal' ? (
          <Select
            label="Which document"
            value={docType}
            onChange={(event) => setDocType(event.target.value)}
            options={[
              { value: 'nda', label: 'NDA' },
              { value: 'pta', label: 'Permission to attack' },
              { value: 'proposal', label: 'Proposal / offer' },
              { value: 'sow', label: 'Statement of work' },
              { value: 'other', label: 'Something else' },
            ]}
            hint="Named so the flow can ask whether the NDA has been generated yet."
          />
        ) : null}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            pick(event.dataTransfer.files?.[0]);
          }}
          className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-6 py-8 transition hover:border-brand-500/50 hover:bg-brand-500/[0.04]"
        >
          <FileText size={22} className="text-fg-subtle" />
          {file ? (
            <>
              <span className="text-sm font-medium text-fg">{file.name}</span>
              <span className="text-xs text-fg-muted">{formatBytes(file.size)} · click to change</span>
            </>
          ) : (
            <>
              <span className="text-sm font-medium text-fg">Choose or drop a .docx file</span>
              <span className="text-xs text-fg-muted">Up to 50 MB</span>
            </>
          )}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".docx"
          className="hidden"
          onChange={(event) => {
            pick(event.target.files?.[0]);
            event.target.value = '';
          }}
        />

        <Input
          label="Template name"
          placeholder="Standard Pentest Report 2026"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Textarea
          label="Description"
          rows={2}
          placeholder="When to use this template."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
    </Modal>
  );
}

/* -------------------------------------------------------------------------- */

export default function TemplatesPage() {
  const toast = useToast();
  const { canWrite } = useAuth();
  const { data, error, loading, reload } = useResource('/templates', { initial: [] });

  const [tab, setTab] = useState('templates');
  const [uploading, setUploading] = useState(false);
  const [renaming, setRenaming] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const [replacingFor, setReplacingFor] = useState(null);
  /** Which template's test render is open. */
  const [testing, setTesting] = useState(null);
  const replaceInputRef = useRef(null);

  const list = Array.isArray(data) ? data : [];

  const download = async (template) => {
    try {
      const response = await api.raw(`/templates/${template._id}/download`);
      const blob = await response.blob();
      downloadBlob(blob, filenameFromResponse(response, `${template.name}.docx`));
    } catch (err) {
      toast.fromError(err, 'Could not download the template');
    }
  };

  const replaceFile = async (template, file) => {
    if (!file) return;
    try {
      const body = new FormData();
      body.append('file', file);
      await api.put(`/templates/${template._id}/file`, body);
      toast.success('Template file replaced');
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    }
  };

  const saveRename = async () => {
    if (!renaming) return;
    try {
      await api.put(`/templates/${renaming._id}`, {
        name: renaming.name,
        description: renaming.description ?? '',
        /*
         * Word templates only. An HTML template shares markup with `{{> a partial }}` instead, and
         * the server refuses the combination rather than half-applying it.
         */
        ...(renaming.kind === 'html'
          ? {}
          : {
              inherits: renaming.inherits || null,
              inheritParts: {
                styles: Boolean(renaming.inheritParts?.styles),
                numbering: Boolean(renaming.inheritParts?.numbering),
                theme: Boolean(renaming.inheritParts?.theme),
                page: Boolean(renaming.inheritParts?.page),
              },
            }),
      });
      toast.success('Template updated');
      setRenaming(null);
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    }
  };

  const confirmDelete = async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      await api.del(`/templates/${pendingDelete._id}`);
      toast.success('Template deleted');
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
        title="Report templates"
        description="Reports are rendered from the .docx files you upload here — your fonts, your layout, your cover page."
        actions={
          canWrite ? (
            <>
              <Button as={Link} to="/templates/html/new" variant="secondary" icon={FileCode2}>
                New HTML template
              </Button>
              <Button variant="primary" icon={Upload} onClick={() => setUploading(true)}>
                Upload .docx
              </Button>
            </>
          ) : null
        }
      />

      <Tabs
        options={[
          { value: 'templates', label: 'Templates', icon: FileText, count: list.length },
          { value: 'reference', label: 'Tag reference', icon: BookOpen },
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'reference' ? (
        <TagReference />
      ) : (
        <Card>
          {loading ? (
            <SkeletonRows rows={4} columns={4} />
          ) : error ? (
            <ErrorState error={error} onRetry={reload} />
          ) : list.length === 0 ? (
            <EmptyState
              icon={FileText}
              title="No templates yet"
              description="Upload a Word document with placeholders in it. A ready-made starter template ships with the project as DEFAULT_PENTEST_REPORT.docx — upload that to see every placeholder in context."
              actionLabel={canWrite ? 'Upload template' : undefined}
              actionIcon={Upload}
              onAction={canWrite ? () => setUploading(true) : undefined}
            />
          ) : (
            <Table>
              <THead>
                <TH>Template</TH>
                <TH>Placeholders</TH>
                <TH>Size</TH>
                <TH align="right">Updated</TH>
                <TH width="9rem" />
              </THead>
              <TBody>
                {list.map((template) => (
                  <TR key={template._id}>
                    <TD className="max-w-md">
                      <div className="flex items-center gap-2">
                        {template.kind === 'html' ? (
                          <Link
                            to={`/templates/html/${template._id}`}
                            className="truncate text-sm font-medium text-fg hover:text-brand-300"
                          >
                            {template.name}
                          </Link>
                        ) : (
                          <p className="truncate text-sm font-medium text-fg">{template.name}</p>
                        )}
                        <Badge tone={template.kind === 'html' ? 'info' : 'neutral'}>
                          {template.kind === 'html' ? 'HTML / PDF' : '.docx'}
                        </Badge>
                        {/* Only worth saying when it is not the usual thing. */}
                        {template.purpose === 'proposal' ? (
                          <Badge tone="success">
                            {PROPOSAL_DOC_LABELS[template.docType] ?? 'proposal paperwork'}
                          </Badge>
                        ) : null}
                      </div>
                      {template.description ? (
                        <p className="mt-0.5 truncate text-xs text-fg-muted">
                          {template.description}
                        </p>
                      ) : null}
                    </TD>
                    <TD>
                      <span className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={template.detectedTags?.length ? 'brand' : 'warning'}>
                          {template.detectedTags?.length ?? 0} found
                        </Badge>
                        {/*
                          What the analysis made of them, from the last time the file was
                          written. A placeholder nobody recognises renders as a gap rather than
                          an error, so the list is where somebody should notice.
                        */}
                        {template.lint?.unknown?.length ? (
                          <Badge
                            tone="warning"
                            icon={TriangleAlert}
                            title={template.lint.unknown
                              .map((entry) => (entry.where ? `${entry.tag} — in ${entry.where}` : entry.tag))
                              .join('\n')}
                          >
                            {template.lint.unknown.length} unrecognised
                          </Badge>
                        ) : template.lint?.at ? (
                          <Badge tone="success" icon={Check} title="Every placeholder resolved against the sample engagement">
                            all known
                          </Badge>
                        ) : null}
                      </span>
                    </TD>
                    <TD className="whitespace-nowrap text-xs text-fg-muted">
                      {formatBytes(template.size)}
                    </TD>
                    <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                      {timeAgo(template.updatedAt)}
                    </TD>
                    <TD align="right">
                      <div className="flex items-center justify-end gap-1">
                        {/* Before it meets a real engagement: render it against the
                            sample and see which placeholders actually resolved. */}
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          icon={FlaskConical}
                          title="Test render against a sample engagement"
                          onClick={() => setTesting(template)}
                        />
                        {/* The same verdicts, but shown where the tags are — which is what you
                            need once the dialog has told you something is wrong. */}
                        <Button
                          as={Link}
                          to={`/templates/${template._id}/playground`}
                          variant="ghost"
                          size="icon-sm"
                          icon={ScanSearch}
                          title="Open the playground: every placeholder in place, and what it resolves to"
                        />
                        {template.kind === 'html' ? (
                          <Button
                            as={Link}
                            to={`/templates/html/${template._id}`}
                            variant="ghost"
                            size="icon-sm"
                            icon={FileCode2}
                            title="Edit the markup"
                          />
                        ) : (
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            icon={Download}
                            title="Download"
                            onClick={() => download(template)}
                          />
                        )}
                        {canWrite ? (
                          <>
                            {template.kind === 'docx' ? (
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                icon={RefreshCw}
                                title="Replace the file, keeping this template's settings"
                                onClick={() => {
                                  setReplacingFor(template);
                                  replaceInputRef.current?.click();
                                }}
                              />
                            ) : null}
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              icon={Pencil}
                              title="Rename"
                              onClick={() => setRenaming({ ...template })}
                            />
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              icon={Trash2}
                              title="Delete"
                              className="hover:text-crit"
                              onClick={() => setPendingDelete(template)}
                            />
                          </>
                        ) : null}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </Card>
      )}

      <input
        ref={replaceInputRef}
        type="file"
        accept=".docx"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (replacingFor && file) replaceFile(replacingFor, file);
          setReplacingFor(null);
          event.target.value = '';
        }}
      />

      <UploadModal
        open={uploading}
        onClose={() => setUploading(false)}
        onUploaded={() => reload({ quiet: true })}
      />

      <TestRenderModal template={testing} onClose={() => setTesting(null)} />

      <Modal
        open={Boolean(renaming)}
        onClose={() => setRenaming(null)}
        title="Edit template"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={saveRename}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Input
            label="Name"
            autoFocus
            value={renaming?.name ?? ''}
            onChange={(e) => setRenaming((current) => ({ ...current, name: e.target.value }))}
          />
          <Textarea
            label="Description"
            rows={2}
            value={renaming?.description ?? ''}
            onChange={(e) => setRenaming((current) => ({ ...current, description: e.target.value }))}
          />

          {/*
            One house style, several documents. An NDA, an offer and a report share a letterhead and
            a set of heading styles; keeping three copies of them means fixing two. Applied when the
            document is generated, so correcting the base corrects everything that points at it.
          */}
          {renaming && renaming.kind !== 'html' ? (
            <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
              <Select
                label="Take its look from"
                hint="Only the parts you tick below. This template keeps its own words and its own tags."
                value={renaming.inherits ?? ''}
                onChange={(e) => setRenaming((current) => ({ ...current, inherits: e.target.value }))}
                options={[
                  { value: '', label: 'Nothing — this template stands alone' },
                  ...list
                    .filter((row) => row.kind !== 'html' && row._id !== renaming._id)
                    .map((row) => ({ value: row._id, label: row.name })),
                ]}
              />
              {renaming.inherits ? (
                <div className="flex flex-col gap-2">
                  {[
                    ['page', 'Page setup, headers and footers', 'The letterhead and the footer, with the paper size and margins they were drawn for. A landscape appendix inside the document is left alone.'],
                    ['styles', 'Heading and text styles', 'Headings, quotes, captions and table styles.'],
                    ['numbering', 'List numbering', 'How bullets and numbered lists are drawn.'],
                    ['theme', 'Theme colours and fonts', 'The palette and typeface pair the styles refer to.'],
                  ].map(([key, label, hint]) => (
                    <Toggle
                      key={key}
                      checked={Boolean(renaming.inheritParts?.[key])}
                      onChange={(checked) =>
                        /*
                         * The functional form, deliberately. Each handler otherwise closes over
                         * `renaming` as it was when that render happened, so ticking two of these
                         * in the same tick kept only the second — which is exactly what a probe
                         * ticking all four found.
                         */
                        setRenaming((current) => ({
                          ...current,
                          inheritParts: { ...(current.inheritParts ?? {}), [key]: checked },
                        }))
                      }
                      label={label}
                      hint={hint}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={confirmDelete}
        loading={deleting}
        title="Delete this template?"
        confirmLabel="Delete"
        message={`"${pendingDelete?.name}" will be removed. Engagements still using it must be reassigned first — the server will refuse the delete otherwise.`}
      />
    </div>
  );
}
