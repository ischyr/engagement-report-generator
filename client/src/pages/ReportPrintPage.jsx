import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ChevronLeft, Download, Info, Printer, RefreshCw } from 'lucide-react';

import { api } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { downloadBlob } from '../lib/utils.js';

import { Button } from '../components/ui/Button.jsx';
import { Alert } from '../components/ui/Alert.jsx';
import { LoadingBlock } from '../components/ui/Feedback.jsx';

/**
 * Full-width print view of an HTML report.
 *
 * The document is fetched with the session token and handed to an iframe via
 * `srcDoc` rather than pointing the iframe at the API — an iframe cannot carry an
 * Authorization header, and putting the token in a query string would leak it
 * into history and logs.
 *
 * Printing targets the iframe's own window so the browser paginates the report's
 * `@page` rules rather than the surrounding app chrome.
 */
export default function ReportPrintPage() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const toast = useToast();
  const frameRef = useRef(null);

  const [state, setState] = useState({ html: '', loading: true, error: null });

  const templateParam = searchParams.get('template');

  const load = useCallback(async () => {
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const query = templateParam ? `?template=${encodeURIComponent(templateParam)}` : '';
      const response = await api.raw(`/audits/${id}/report.html${query}`);
      setState({ html: await response.text(), loading: false, error: null });
    } catch (error) {
      setState({ html: '', loading: false, error });
    }
  }, [id, templateParam]);

  useEffect(() => {
    load();
  }, [load]);

  const print = () => {
    const frame = frameRef.current?.contentWindow;
    if (!frame) return;
    frame.focus();
    frame.print();
  };

  const downloadHtml = () => {
    downloadBlob(new Blob([state.html], { type: 'text/html;charset=utf-8' }), 'report.html');
  };

  return (
    <div className="flex flex-col gap-4">
      {/* The toolbar is screen-only: it must never appear in the PDF. */}
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          to={`/engagements/${id}`}
          className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
        >
          <ChevronLeft size={13} />
          Back to the engagement
        </Link>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" size="sm" icon={RefreshCw} onClick={load} loading={state.loading}>
            Refresh
          </Button>
          <Button variant="secondary" size="sm" icon={Download} onClick={downloadHtml} disabled={!state.html}>
            Download .html
          </Button>
          <Button variant="primary" icon={Printer} onClick={print} disabled={!state.html}>
            Print / Save as PDF
          </Button>
        </div>
      </div>

      <Alert tone="info" icon={Info} title="Saving as PDF" className="print:hidden">
        In the print dialog choose <span className="text-fg">Save as PDF</span> as the destination.
        Leave margins at <span className="text-fg">Default</span> and turn on{' '}
        <span className="text-fg">Background graphics</span> so severity colours and code blocks
        print.
      </Alert>

      {state.loading && !state.html ? (
        <LoadingBlock label="Rendering the report…" />
      ) : state.error ? (
        <Alert tone="error" title={state.error.message || 'Could not render the report'}>
          {state.error.status === 400
            ? 'This engagement needs an HTML template assigned on its Overview tab.'
            : 'Check the template markup and try again.'}
        </Alert>
      ) : (
        <div className="overflow-hidden rounded-card border border-line-soft bg-white shadow-panel print:rounded-none print:border-0 print:shadow-none">
          <iframe
            ref={frameRef}
            title="Report"
            srcDoc={state.html}
            sandbox="allow-same-origin allow-modals"
            className="block h-[82vh] w-full border-0 print:h-auto"
          />
        </div>
      )}
    </div>
  );
}
