import { useRef, useState } from 'react';
import { CheckCircle2, CircleAlert, Copy, FileSpreadsheet, Upload } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Alert } from '../ui/Alert.jsx';
import { Checkbox } from '../ui/Field.jsx';

/**
 * Findings, in from a spreadsheet.
 *
 * Two steps, and the first one writes nothing. The file is uploaded, judged and shown back as a
 * table of rows with verdicts; only then does anything get created, and only the rows that are
 * ticked. A preview that committed as a side effect of being looked at would not be a preview.
 *
 * Duplicates arrive unticked rather than hidden. The sheet may well contain something this
 * engagement already has — that is normal when two people worked from the same scanner output —
 * and the useful behaviour is to say so and let somebody decide, not to drop the row or to create
 * a second copy quietly.
 *
 * The file is sent twice, once per step. That is deliberate: what gets created is read from the
 * sheet by the server rather than posted back by the browser, so the import cannot become a
 * roundabout way of creating arbitrary findings.
 */
const STATUS = {
  new: { icon: CheckCircle2, tone: 'text-low', label: 'New' },
  duplicate: { icon: Copy, tone: 'text-med', label: 'Already here' },
  invalid: { icon: CircleAlert, tone: 'text-crit', label: 'Cannot import' },
};

export default function ImportFindingsDialog({ open, onClose, auditId, onImported }) {
  const toast = useToast();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [plan, setPlan] = useState(null);
  const [chosen, setChosen] = useState(() => new Set());
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setFile(null);
    setPlan(null);
    setChosen(new Set());
  };

  const preview = async (picked) => {
    if (!picked) return;
    setBusy(true);
    setFile(picked);
    try {
      const body = new FormData();
      body.append('file', picked, picked.name);
      const result = await api.post(`/audits/${auditId}/findings/import/preview`, body);
      setPlan(result);
      /* Everything importable is ticked except the duplicates, which are the decision. */
      setChosen(new Set(result.rows.filter((row) => row.status === 'new').map((row) => row.line)));
    } catch (error) {
      toast.fromError(error, 'That file could not be read');
      reset();
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const body = new FormData();
      body.append('file', file, file.name);
      body.append('lines', [...chosen].join(','));
      const result = await api.post(`/audits/${auditId}/findings/import`, body);
      toast.success(
        result.created.length === 1 ? 'One finding imported' : `${result.created.length} findings imported`,
        'They arrive as drafts — scoring and evidence still need you.'
      );
      await onImported?.();
      reset();
      onClose();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (line) =>
    setChosen((current) => {
      const next = new Set(current);
      if (next.has(line)) next.delete(line);
      else next.add(line);
      return next;
    });

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title="Import findings from a spreadsheet"
      description="An .xlsx or a CSV whose first row is the headers — Title, Severity, Vector, Description, and the rest. The findings export writes exactly that shape, so a sheet from here comes back unchanged."
      size="xl"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              reset();
              onClose();
            }}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={Upload}
            loading={busy}
            disabled={!plan || !chosen.size}
            onClick={commit}
          >
            {chosen.size === 1 ? 'Import 1 row' : `Import ${chosen.size} rows`}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {!plan ? (
          <div className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line px-6 py-10 text-center">
            <FileSpreadsheet size={26} className="text-fg-subtle" />
            <p className="text-xs text-fg-muted">
              Nothing is created until you have seen what the file contains.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="hidden"
              onChange={(event) => preview(event.target.files?.[0])}
            />
            <Button variant="secondary" loading={busy} onClick={() => fileRef.current?.click()}>
              Choose a file
            </Button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
              <span className="text-fg">{file?.name}</span>
              <span>· {plan.counts.new} new</span>
              {plan.counts.duplicate ? <span>· {plan.counts.duplicate} already here</span> : null}
              {plan.counts.invalid ? <span>· {plan.counts.invalid} unusable</span> : null}
              <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
                Choose another
              </Button>
            </div>

            {plan.unknown?.length ? (
              <Alert tone="info" title="Some columns were not recognised">
                {plan.unknown.join(', ')} — those are ignored. Everything else mapped:{' '}
                {plan.mapped.join(', ')}.
              </Alert>
            ) : null}

            <div className="max-h-96 overflow-auto rounded-card border border-line-soft">
              <table className="w-full text-left text-xs">
                <thead className="sticky top-0 bg-surface">
                  <tr className="text-fg-subtle">
                    <th className="w-10 px-3 py-2" />
                    <th className="w-12 px-2 py-2">Row</th>
                    <th className="px-2 py-2">Title</th>
                    <th className="w-32 px-2 py-2">What happens</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {plan.rows.map((row) => {
                    const meta = STATUS[row.status] ?? STATUS.invalid;
                    const Icon = meta.icon;
                    return (
                      <tr key={row.line} className={row.status === 'invalid' ? 'opacity-60' : ''}>
                        <td className="px-3 py-2 align-top">
                          <Checkbox
                            checked={chosen.has(row.line)}
                            disabled={row.status === 'invalid'}
                            onChange={() => toggle(row.line)}
                          />
                        </td>
                        <td className="px-2 py-2 align-top font-mono text-fg-subtle">{row.line}</td>
                        <td className="px-2 py-2 align-top">
                          <p className="text-fg">{row.title || <em>no title</em>}</p>
                          {row.duplicateOf ? (
                            <p className="text-fg-muted">
                              Same as {row.duplicateOf.identifier || row.duplicateOf.title}
                            </p>
                          ) : null}
                          {row.duplicateOfLine ? (
                            <p className="text-fg-muted">Same as row {row.duplicateOfLine} above</p>
                          ) : null}
                          {/* The reasons a row is refused, and the warnings on one that is not. */}
                          {[...(row.reasons ?? []), ...(row.warnings ?? [])].map((reason) => (
                            <p key={reason} className="text-fg-subtle">
                              {reason}
                            </p>
                          ))}
                        </td>
                        <td className="px-2 py-2 align-top">
                          <span className={`flex items-center gap-1.5 ${meta.tone}`}>
                            <Icon size={13} className="shrink-0" />
                            {meta.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
