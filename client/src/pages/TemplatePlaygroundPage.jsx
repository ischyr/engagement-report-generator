import { useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Download,
  FileCode2,
  FlaskConical,
  RefreshCw,
  Table2,
  Upload,
} from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { formatBytes } from '../lib/utils.js';

import { Card, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { Badge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, SkeletonRows } from '../components/ui/Feedback.jsx';

/**
 * A template with its placeholders shown where they actually are.
 *
 * The Test render dialog answers "did every tag resolve?" as a list of names. That is the wrong
 * shape for the job you are doing when a template is wrong: you have a name and a verdict, and no
 * idea which of the four places that tag appears is the one that matters, or what surrounds it.
 *
 * So the document is laid out in reading order with the tags highlighted in it, clicking one says
 * what it resolved to against the sample engagement, and a corrected file can be dropped straight
 * in — the loop that used to be "edit in Word, upload, open the dialog, squint, repeat".
 */

/** How each verdict reads. `close` is bookkeeping and deliberately quiet. */
const STATUS = {
  ok: {
    label: 'resolved',
    chip: 'bg-low/15 text-low ring-low/30',
    dot: 'bg-low',
  },
  empty: {
    label: 'empty here',
    chip: 'bg-med/15 text-med ring-med/30',
    dot: 'bg-med',
  },
  unknown: {
    label: 'not a tag',
    chip: 'bg-crit/15 text-crit ring-crit/40',
    dot: 'bg-crit',
  },
  /*
   * A tag the lint did not list. Not "wrong" — the lint lists a field written inside its own
   * condition only once, and a closing tag never — so this says "nothing to report" rather than
   * inventing a verdict.
   */
  unlisted: {
    label: 'no verdict',
    chip: 'bg-white/5 text-fg-subtle ring-line',
    dot: 'bg-fg-subtle',
  },
  close: {
    label: 'closes a loop',
    chip: 'bg-white/5 text-fg-subtle ring-line',
    dot: 'bg-fg-subtle',
  },
};

const KIND_LABELS = {
  value: 'value',
  rich: 'rich text',
  loop: 'loop or condition',
  inverted: 'inverted condition',
  close: 'closing tag',
};

/** What a tag is written as, so the chip reads like the template rather than like data. */
function tagLabel(segment) {
  if (segment.kind === 'loop') return `#${segment.tag}`;
  if (segment.kind === 'inverted') return `^${segment.tag}`;
  if (segment.kind === 'close') return `/${segment.tag}`;
  if (segment.kind === 'rich') return `@${segment.tag}`;
  return segment.tag;
}

const isProblem = (segment) => segment.status === 'empty' || segment.status === 'unknown';

export default function TemplatePlaygroundPage() {
  const { id } = useParams();
  const toast = useToast();
  const { canWrite } = useAuth();
  const replaceRef = useRef(null);

  const { data, error, loading, reload } = useResource(`/templates/${id}/playground`, {
    initial: null,
  });
  const [selected, setSelected] = useState(null);
  const [query, setQuery] = useState('');
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [replacing, setReplacing] = useState(false);

  const reference = useResource('/templates/tag-reference', { initial: null });

  /** Every documented tag by name, for the inspector's description. */
  const descriptions = useMemo(() => {
    const map = new Map();
    const groups = [
      ...(reference.data?.groups ?? []),
      ...(reference.data?.proposalGroups ?? []),
    ];
    for (const group of groups) {
      for (const entry of group.tags ?? []) {
        if (!map.has(entry.tag)) map.set(entry.tag, { ...entry, group: group.title ?? group.name });
      }
    }
    return map;
  }, [reference.data]);

  /** How many times each tag appears, so the inspector can say "3 places". */
  const occurrences = useMemo(() => {
    const counts = new Map();
    for (const part of data?.outline?.parts ?? []) {
      for (const block of part.blocks) {
        for (const segment of block.segments) {
          if (!segment.tag || segment.kind === 'close') continue;
          counts.set(segment.tag, (counts.get(segment.tag) ?? 0) + 1);
        }
      }
    }
    return counts;
  }, [data]);

  /** The outline with the search and the problems filter applied. */
  const parts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const keep = (block) => {
      if (onlyProblems && !block.segments.some(isProblem)) return false;
      if (!needle) return true;
      const haystack = block.segments
        .map((segment) => segment.tag ?? segment.text ?? '')
        .join(' ')
        .toLowerCase();
      return haystack.includes(needle) || (block.heading ?? '').toLowerCase().includes(needle);
    };
    return (data?.outline?.parts ?? [])
      .map((part) => ({ ...part, blocks: part.blocks.filter(keep) }))
      .filter((part) => part.blocks.length > 0);
  }, [data, query, onlyProblems]);

  const replaceFile = async (file) => {
    if (!file) return;
    setReplacing(true);
    try {
      const body = new FormData();
      body.append('file', file);
      await api.put(`/templates/${id}/file`, body);
      toast.success('File replaced — re-testing');
      // Straight back round the loop: the point of the page is not having to go and look.
      reload({ quiet: true });
    } catch (err) {
      toast.fromError(err);
    } finally {
      setReplacing(false);
      if (replaceRef.current) replaceRef.current.value = '';
    }
  };

  const download = async () => {
    try {
      const response = await api.raw(`/templates/${id}/test-render`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${data?.template?.name ?? 'test-render'}.docx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.fromError(err);
    }
  };

  if (error) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title="Template playground" description="Where every placeholder is, and what it resolves to." />
        <Card>
          <ErrorState error={error} onRetry={reload} />
        </Card>
      </div>
    );
  }

  const counts = data?.counts ?? { total: 0, ok: 0, empty: 0, unknown: 0 };
  const template = data?.template;
  const render = data?.render;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={template ? `Playground — ${template.name}` : 'Template playground'}
        description="Every placeholder where it sits in the document, and what it resolves to against the sample engagement. Nothing here touches your engagements."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button as={Link} to="/templates" variant="ghost" size="sm" icon={ArrowLeft}>
              Templates
            </Button>
            {template?.kind === 'html' ? (
              <Button as={Link} to={`/templates/html/${id}`} variant="secondary" size="sm" icon={FileCode2}>
                Edit markup
              </Button>
            ) : null}
            {render?.downloadable ? (
              <Button variant="secondary" size="sm" icon={Download} onClick={download}>
                Download the render
              </Button>
            ) : null}
            {canWrite && template?.kind === 'docx' ? (
              <>
                <input
                  ref={replaceRef}
                  type="file"
                  accept=".docx"
                  className="hidden"
                  onChange={(event) => replaceFile(event.target.files?.[0])}
                />
                <Button
                  variant="primary"
                  size="sm"
                  icon={Upload}
                  loading={replacing}
                  onClick={() => replaceRef.current?.click()}
                >
                  Replace and re-test
                </Button>
              </>
            ) : null}
          </div>
        }
      />

      {/* What the render did, and the three numbers that matter. */}
      <Card>
        <div className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-3">
            {loading && !data ? (
              <span className="text-sm text-fg-muted">Rendering against the sample engagement…</span>
            ) : render?.ok ? (
              <span className="flex items-center gap-2 text-sm text-fg">
                <Check size={15} className="text-low" />
                Rendered {formatBytes(render.size)}
              </span>
            ) : (
              <span className="flex items-center gap-2 text-sm text-crit">
                <AlertTriangle size={15} />
                {render?.error || 'The template could not be rendered'}
              </span>
            )}

            <span className="ml-auto flex flex-wrap items-center gap-2">
              {[
                ['unknown', counts.unknown, 'not a tag'],
                ['empty', counts.empty, 'empty'],
                ['ok', counts.ok, 'resolved'],
              ].map(([status, count, label]) => (
                <span
                  key={status}
                  className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${STATUS[status].chip}`}
                  title={`${count} of ${counts.total} placeholders`}
                >
                  {count} {label}
                </span>
              ))}
              <Button variant="ghost" size="sm" icon={RefreshCw} loading={loading} onClick={() => reload()}>
                Re-test
              </Button>
            </span>
          </div>

          {/* docxtemplater reports every broken tag it found, not just the first. */}
          {render?.problems?.length ? (
            <ul className="flex flex-col gap-1 rounded-lg bg-crit/5 p-3 text-xs text-fg-muted ring-1 ring-crit/20">
              {render.problems.slice(0, 8).map((problem, index) => (
                <li key={index}>
                  <span className="font-mono text-crit">{problem.tag || '—'}</span> {problem.message}
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder="Search tags, text or headings…"
              className="w-full sm:w-80"
            />
            <Button
              variant={onlyProblems ? 'secondary' : 'ghost'}
              size="sm"
              icon={AlertTriangle}
              onClick={() => setOnlyProblems((current) => !current)}
            >
              {onlyProblems ? 'Showing problems only' : 'Show only the problems'}
            </Button>
            {data?.outlineError ? (
              <span className="text-xs text-med">The document could not be read: {data.outlineError}</span>
            ) : null}
          </div>
        </div>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader
            title={data?.outline?.kind === 'html' ? 'Markup' : 'Document'}
            icon={FlaskConical}
            description="In reading order. Indentation is loop nesting; click a placeholder to inspect it."
          />
          {loading && !data ? (
            <SkeletonRows rows={6} columns={1} />
          ) : parts.length === 0 ? (
            <EmptyState
              icon={FlaskConical}
              title={onlyProblems || query ? 'Nothing matches' : 'No placeholders found'}
              description={
                onlyProblems || query
                  ? 'Clear the filter to see the rest of the template.'
                  : 'This template has no tags in it yet — every value in the report would be whatever the document already says.'
              }
            />
          ) : (
            <div className="flex flex-col divide-y divide-line-soft">
              {parts.map((part) => (
                <section key={part.id}>
                  <h3 className="sticky top-0 z-10 flex items-center gap-2 bg-surface/95 px-4 py-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle backdrop-blur">
                    {part.label}
                    <span className="font-normal normal-case tracking-normal">
                      {part.blocks.length} paragraph{part.blocks.length === 1 ? '' : 's'}
                    </span>
                  </h3>
                  <ul className="flex flex-col">
                    {part.blocks.map((block, index) => {
                      /*
                       * The heading only where it changes. Repeating "RULES OF ENGAGEMENT" above
                       * each of the six paragraphs under it turned a breadcrumb into wallpaper —
                       * and the point of it is to tell you when you have moved on.
                       */
                      const heading =
                        block.heading && block.heading !== part.blocks[index - 1]?.heading
                          ? block.heading
                          : '';
                      return (
                      <li
                        key={block.id}
                        className="border-t border-line-soft/60 px-4 py-2.5 text-sm leading-relaxed"
                        style={{ paddingLeft: `${1 + block.depth * 1.25}rem` }}
                      >
                        {heading || block.table || block.line ? (
                          <p className="mb-1 flex items-center gap-2 text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
                            {block.table ? <Table2 size={12} /> : null}
                            {block.line ? `line ${block.line}` : heading}
                          </p>
                        ) : null}
                        <p className={block.markup ? 'break-all font-mono text-xs' : ''}>
                          {block.segments.map((segment, index) =>
                            segment.tag ? (
                              <button
                                key={index}
                                type="button"
                                onClick={() => setSelected(segment)}
                                title={`${KIND_LABELS[segment.kind] ?? segment.kind} — ${STATUS[segment.status]?.label ?? segment.status}`}
                                className={`mx-0.5 rounded px-1.5 py-0.5 font-mono text-xs ring-1 transition hover:brightness-125 ${
                                  STATUS[segment.status]?.chip ?? STATUS.unlisted.chip
                                } ${selected?.tag === segment.tag ? 'outline outline-1 outline-offset-1 outline-brand-400' : ''}`}
                              >
                                {tagLabel(segment)}
                              </button>
                            ) : (
                              <span key={index} className="text-fg-muted">
                                {segment.text}
                              </span>
                            )
                          )}
                        </p>
                      </li>
                      );
                    })}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </Card>

        {/* The inspector. Sticky, because the thing being inspected is somewhere in a long page. */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card>
            <CardHeader title="Inspector" description={selected ? undefined : 'Click a placeholder.'} />
            {selected ? (
              <div className="flex flex-col gap-3 p-4 text-sm">
                <p className="break-all font-mono text-base text-fg">{selected.raw}</p>

                <div className="flex flex-wrap items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${STATUS[selected.status]?.chip ?? STATUS.unlisted.chip}`}>
                    {STATUS[selected.status]?.label ?? selected.status}
                  </span>
                  <Badge tone="neutral">{KIND_LABELS[selected.kind] ?? selected.kind}</Badge>
                  {occurrences.get(selected.tag) > 1 ? (
                    <Badge tone="neutral">{occurrences.get(selected.tag)} places</Badge>
                  ) : null}
                </div>

                <dl className="flex flex-col gap-2 text-xs">
                  <div>
                    <dt className="text-fg-subtle">Inside</dt>
                    <dd className="text-fg">
                      {selected.scope?.length ? selected.scope.join(' → ') : 'the document, at the top level'}
                    </dd>
                  </div>
                  {selected.status === 'ok' ? (
                    <div>
                      <dt className="text-fg-subtle">On the sample engagement</dt>
                      <dd className="break-words text-fg">{selected.value || '(blank)'}</dd>
                    </div>
                  ) : null}
                  {selected.status === 'empty' ? (
                    <div>
                      <dt className="text-fg-subtle">On the sample engagement</dt>
                      <dd className="text-fg-muted">
                        {selected.unverified
                          ? 'Nothing to sample — the loop this sits in is empty on the sample, so this cannot be judged either way.'
                          : 'A real tag with nothing behind it here. Fine if the sample simply has none of these; a problem if you meant it to be inside a loop.'}
                      </dd>
                    </div>
                  ) : null}
                  {descriptions.get(selected.tag) ? (
                    <div>
                      <dt className="text-fg-subtle">
                        Reference{descriptions.get(selected.tag).group ? ` — ${descriptions.get(selected.tag).group}` : ''}
                      </dt>
                      <dd className="text-fg-muted">{descriptions.get(selected.tag).description}</dd>
                    </div>
                  ) : null}
                </dl>

                {selected.suggestions?.length ? (
                  <div className="rounded-lg bg-crit/5 p-3 text-xs ring-1 ring-crit/20">
                    <p className="mb-1 text-fg-subtle">Did you mean</p>
                    <ul className="flex flex-col gap-0.5 font-mono text-fg">
                      {selected.suggestions.map((suggestion) => (
                        <li key={suggestion}>{suggestion}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="flex flex-col gap-2 p-4 text-xs text-fg-muted">
                {Object.entries(STATUS).map(([status, meta]) => (
                  <span key={status} className="flex items-center gap-2">
                    <span className={`size-2 rounded-full ${meta.dot}`} />
                    {meta.label}
                  </span>
                ))}
                <p className="mt-2 leading-relaxed">
                  A tag written as <span className="font-mono">#name</span> opens a loop or a
                  condition, <span className="font-mono">/name</span> closes one, and{' '}
                  <span className="font-mono">@name</span> is rich text.
                </p>
              </div>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
