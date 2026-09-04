import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ChevronLeft,
  Code2,
  Eye,
  FileCode2,
  RefreshCw,
  Save,
  TriangleAlert,
} from 'lucide-react';

import { api, ApiError } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { cn, formatBytes } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Tabs } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Input, Select, Textarea } from '../components/ui/Field.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { LoadingBlock, ErrorState } from '../components/ui/Feedback.jsx';

/**
 * Editor for HTML report templates.
 *
 * The preview is rendered by the server against a real engagement rather than
 * faked client-side, so what appears here is exactly what printing produces —
 * same data, same engine, same sanitiser.
 */
export default function HtmlTemplateEditorPage() {
  const { id } = useParams();
  const isNew = id === 'new';
  const navigate = useNavigate();
  const toast = useToast();

  const template = useResource(isNew ? null : `/templates/${id}`);
  const starter = useResource(isNew ? '/templates/starter-html' : null);
  const audits = useResource('/audits', { initial: [] });

  const [form, setForm] = useState({ name: '', description: '', html: '' });
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState('preview');
  const [previewFor, setPreviewFor] = useState('');
  const [preview, setPreview] = useState({ html: '', loading: false, error: null });
  const [unknownTags, setUnknownTags] = useState([]);

  // Seed from either the saved template or the starter markup.
  useEffect(() => {
    if (isNew && starter.data?.html) {
      setForm({ name: '', description: '', html: starter.data.html });
      setDirty(false);
    }
  }, [isNew, starter.data]);

  useEffect(() => {
    if (!isNew && template.data) {
      setForm({
        name: template.data.name ?? '',
        description: template.data.description ?? '',
        html: template.data.html ?? '',
      });
      setUnknownTags([]);
      setDirty(false);
    }
  }, [isNew, template.data]);

  const auditOptions = useMemo(
    () => (audits.data ?? []).map((a) => ({ value: a._id, label: a.name })),
    [audits.data]
  );

  // Default to the most recently touched engagement — the list is already sorted.
  useEffect(() => {
    if (!previewFor && auditOptions.length) setPreviewFor(auditOptions[0].value);
  }, [auditOptions, previewFor]);

  /**
   * Renders the *saved* template for the chosen engagement.
   *
   * Deliberately server-side, so the preview cannot drift from the real output.
   * The consequence is that unsaved edits are not previewed — the button says so.
   */
  const refreshPreview = useCallback(async () => {
    if (isNew || !previewFor) return;
    setPreview((p) => ({ ...p, loading: true, error: null }));
    try {
      const response = await api.raw(`/audits/${previewFor}/report.html?template=${id}`);
      setPreview({ html: await response.text(), loading: false, error: null });
    } catch (error) {
      setPreview({ html: '', loading: false, error });
    }
  }, [id, isNew, previewFor]);

  useEffect(() => {
    if (view === 'preview') refreshPreview();
  }, [view, refreshPreview]);

  const set = (patch) => {
    setForm((current) => ({ ...current, ...patch }));
    setDirty(true);
  };

  const save = async () => {
    if (!form.name.trim()) {
      toast.error('Give the template a name');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        description: form.description.trim(),
        html: form.html,
      };
      const saved = isNew
        ? await api.post('/templates/html', payload)
        : await api.put(`/templates/${id}/html`, payload);

      setUnknownTags(saved.unknownTags ?? []);
      setDirty(false);
      toast.success(isNew ? 'Template created' : 'Template saved');

      if (isNew) navigate(`/templates/html/${saved._id}`, { replace: true });
      else await refreshPreview();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setSaving(false);
    }
  };

  // Warn before losing unsaved markup on a reload or tab close.
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!isNew && template.loading) return <LoadingBlock label="Loading template…" />;
  if (!isNew && template.error) {
    return <ErrorState error={template.error} onRetry={template.reload} />;
  }

  const lineCount = form.html.split('\n').length;

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        breadcrumb={
          <Link
            to="/templates"
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft size={13} />
            All templates
          </Link>
        }
        title={isNew ? 'New HTML template' : form.name || 'HTML template'}
        description="Ordinary HTML and CSS. Use the same placeholders as a Word template; print it to get a PDF."
        actions={
          <>
            {!isNew ? (
              <Button
                as={Link}
                to={`/engagements/${previewFor}/print?template=${id}`}
                variant="secondary"
                icon={Eye}
                disabled={!previewFor}
              >
                Open print view
              </Button>
            ) : null}
            <Button variant="primary" icon={Save} loading={saving} onClick={save}>
              {isNew ? 'Create template' : 'Save'}
            </Button>
          </>
        }
      />

      {unknownTags.length ? (
        <Alert tone="warning" title={`${unknownTags.length} placeholder(s) not recognised`}>
          {unknownTags.slice(0, 6).join(', ')}
          {unknownTags.length > 6 ? ', …' : ''} — these will render empty. Check them against
          Templates → Tag reference.
        </Alert>
      ) : null}

      <Card>
        <CardBody className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Template name"
            required
            placeholder="Web Application Report (HTML)"
            value={form.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          <Input
            label="Description"
            placeholder="When to use this template"
            value={form.description}
            onChange={(e) => set({ description: e.target.value })}
          />
        </CardBody>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          options={[
            { value: 'preview', label: 'Preview', icon: Eye },
            { value: 'code', label: 'Markup', icon: Code2 },
          ]}
          value={view}
          onChange={setView}
        />
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-fg-subtle">
            {lineCount} lines · {formatBytes(new Blob([form.html]).size)}
            {dirty ? ' · unsaved' : ''}
          </span>
          {view === 'preview' ? (
            <>
              <Select
                value={previewFor}
                onChange={(e) => setPreviewFor(e.target.value)}
                options={auditOptions}
                placeholder="Choose an engagement"
                className="h-8 w-56 text-xs"
                wrapperClassName="w-56"
              />
              <Button
                variant="secondary"
                size="sm"
                icon={RefreshCw}
                onClick={refreshPreview}
                loading={preview.loading}
                disabled={isNew || !previewFor}
              >
                Refresh
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {view === 'code' ? (
        <Card>
          <CardHeader
            title="Template markup"
            icon={FileCode2}
            description="A complete HTML document. The @page rules control the printed page size and margins."
          />
          <CardBody>
            <Textarea
              value={form.html}
              onChange={(e) => set({ html: e.target.value })}
              rows={30}
              spellCheck={false}
              wrap="off"
              className="font-mono text-xs leading-relaxed"
              // Tab should indent, not jump out of a code editor.
              onKeyDown={(event) => {
                if (event.key !== 'Tab') return;
                event.preventDefault();
                const el = event.target;
                const { selectionStart: start, selectionEnd: end, value } = el;
                const next = `${value.slice(0, start)}  ${value.slice(end)}`;
                set({ html: next });
                requestAnimationFrame(() => {
                  el.selectionStart = start + 2;
                  el.selectionEnd = start + 2;
                });
              }}
            />
          </CardBody>
        </Card>
      ) : (
        <Card className="overflow-hidden">
          {isNew ? (
            <CardBody>
              <p className="flex items-center gap-2 text-xs text-fg-muted">
                <TriangleAlert size={14} className="shrink-0 text-med" />
                Save the template once to see it rendered against a real engagement.
              </p>
            </CardBody>
          ) : preview.error ? (
            <CardBody>
              <Alert
                tone="error"
                title={
                  preview.error instanceof ApiError ? preview.error.message : 'Could not render'
                }
              >
                {(audits.data?.length ?? 0) === 0
                  ? 'Create an engagement first — the preview renders against real data.'
                  : 'Fix the template markup, save, then refresh.'}
              </Alert>
            </CardBody>
          ) : preview.loading && !preview.html ? (
            <LoadingBlock label="Rendering…" />
          ) : (
            <>
              <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2">
                <p className="text-xs text-fg-muted">
                  Rendered from the saved template. Unsaved edits are not shown.
                </p>
                {dirty ? <Badge tone="warning">Save to update</Badge> : null}
              </div>
              {/* The report is a light document; give it a white canvas rather
                  than letting the dark app theme bleed through. */}
              <iframe
                title="Report preview"
                srcDoc={preview.html}
                sandbox="allow-same-origin"
                className={cn('block w-full border-0 bg-white', 'h-[70vh]')}
              />
            </>
          )}
        </Card>
      )}
    </div>
  );
}
