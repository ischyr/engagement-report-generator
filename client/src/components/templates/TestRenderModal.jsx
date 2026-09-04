import { useEffect, useState } from 'react';
import { CheckCircle2, CircleSlash, Download, OctagonAlert } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { cn, downloadBlob, filenameFromResponse } from '../../lib/utils.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { LoadingBlock } from '../ui/Feedback.jsx';

const STATUS = {
  unknown: {
    icon: OctagonAlert,
    text: 'text-crit',
    label: 'not a tag',
    hint: 'Nothing in the app produces this name — almost always a typo. It will render as nothing.',
  },
  empty: {
    icon: CircleSlash,
    text: 'text-med',
    label: 'empty here',
    hint: 'A real tag with nothing behind it in the sample. Fine if the sample simply has none of these; a problem if you meant to use it inside a loop.',
  },
  ok: { icon: CheckCircle2, text: 'text-low', label: 'resolved', hint: '' },
};

/**
 * Renders a template against the sample engagement and says what happened.
 *
 * A .docx template used to be provable only by attaching it to a real engagement,
 * generating, and opening Word — and a misspelled tag does not raise an error, it leaves
 * a gap, so the loop was both slow and quiet.
 */
export default function TestRenderModal({ template, onClose }) {
  const toast = useToast();
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);
  const [show, setShow] = useState('problems');

  useEffect(() => {
    if (!template) return;
    setResult(null);
    setError(null);
    api
      .post(`/templates/${template._id}/test`, {})
      .then(setResult)
      .catch((err) => setError(err));
  }, [template]);

  const downloadSample = async () => {
    setDownloading(true);
    try {
      const response = await api.raw(`/templates/${template._id}/test-render`);
      const blob = await response.blob();
      downloadBlob(blob, filenameFromResponse(response, `Sample report — ${template.name}.docx`));
    } catch (err) {
      toast.fromError(err, 'Could not render the sample');
    } finally {
      setDownloading(false);
    }
  };

  const counts = result?.counts;
  const problems = (result?.tags ?? []).filter((tag) => tag.status !== 'ok');
  const listed = show === 'problems' ? problems : (result?.tags ?? []);

  return (
    <Modal
      open={Boolean(template)}
      onClose={onClose}
      title={`Test render — ${template?.name ?? ''}`}
      description="Rendered against a sample engagement with three findings, two CVSS versions, a screenshot and empty optional fields. Nothing here touches your engagements."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {result?.downloadable ? (
            <Button variant="primary" icon={Download} loading={downloading} onClick={downloadSample}>
              Download the sample report
            </Button>
          ) : null}
        </>
      }
    >
      {error ? (
        <p className="rounded-lg border border-crit/25 bg-crit/[0.06] px-3 py-2.5 text-xs text-fg">
          {error.message}
        </p>
      ) : !result ? (
        <LoadingBlock label="Rendering…" />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Did it render at all? A broken loop stops the document; a wrong tag does not. */}
          {result.ok ? (
            <p className="flex items-center gap-2 rounded-lg border border-low/25 bg-low/[0.06] px-3 py-2.5 text-xs text-fg-muted">
              <CheckCircle2 size={14} className="shrink-0 text-low" />
              The document rendered.
              {result.size ? ` ${(result.size / 1024).toFixed(1)} KB.` : ''}
              {problems.length
                ? ' Some placeholders need a look, below.'
                : ' Every placeholder resolved.'}
            </p>
          ) : (
            <div className="rounded-lg border border-crit/25 bg-crit/[0.06] px-3 py-2.5">
              <p className="flex items-center gap-2 text-xs font-medium text-fg">
                <OctagonAlert size={14} className="shrink-0 text-crit" />
                {result.error}
              </p>
              {(result.problems ?? []).length ? (
                <ul className="mt-2 flex flex-col gap-1">
                  {result.problems.map((problem, index) => (
                    <li key={index} className="text-[0.6875rem] leading-relaxed text-fg-muted">
                      {problem.message}
                      {problem.tag ? (
                        <span className="ml-1 font-mono text-fg-subtle">{problem.tag}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2 text-[0.625rem] text-fg-subtle">
                An unclosed or mismatched loop stops the whole document. The placeholder list
                below still applies.
              </p>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={counts.unknown ? 'danger' : 'neutral'}>{counts.unknown} not a tag</Badge>
            <Badge tone={counts.empty ? 'warning' : 'neutral'}>{counts.empty} empty</Badge>
            <Badge tone="success">{counts.ok} resolved</Badge>
            <button
              type="button"
              onClick={() => setShow(show === 'problems' ? 'all' : 'problems')}
              className="ml-auto rounded-md px-2 py-1 text-[0.6875rem] font-medium text-fg-muted transition hover:bg-white/5 hover:text-fg"
            >
              {show === 'problems' ? `Show all ${counts.total}` : 'Show only the problems'}
            </button>
          </div>

          {listed.length === 0 ? (
            <p className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-6 text-center text-xs text-fg-subtle">
              Nothing to look at — every placeholder in this template resolved.
            </p>
          ) : (
            <ul className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {listed.map((tag) => {
                const meta = STATUS[tag.status] ?? STATUS.empty;
                return (
                  <li
                    key={`${tag.where}|${tag.tag}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg px-2 py-1.5 odd:bg-white/[0.02]"
                  >
                    <meta.icon size={12} className={cn('shrink-0 self-center', meta.text)} />
                    <span className="font-mono text-xs text-fg">{tag.tag}</span>
                    {tag.where ? (
                      <span className="text-[0.625rem] text-fg-subtle">inside {tag.where}</span>
                    ) : null}
                    <span className={cn('text-[0.625rem]', meta.text)}>{meta.label}</span>
                    {tag.value ? (
                      <span className="min-w-0 flex-1 truncate text-right text-[0.6875rem] text-fg-muted">
                        {tag.value}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}

          {/* The statuses need explaining once, not per row. */}
          {problems.length ? (
            <dl className="flex flex-col gap-1.5 border-t border-line-soft pt-3 text-[0.625rem] leading-relaxed text-fg-subtle">
              {['unknown', 'empty']
                .filter((status) => listed.some((tag) => tag.status === status))
                .map((status) => (
                  <div key={status} className="flex gap-2">
                    <dt className={cn('shrink-0 font-semibold', STATUS[status].text)}>
                      {STATUS[status].label}
                    </dt>
                    <dd>{STATUS[status].hint}</dd>
                  </div>
                ))}
            </dl>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
