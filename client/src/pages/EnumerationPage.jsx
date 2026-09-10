import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ChevronLeft, PanelLeftClose, ScanSearch } from 'lucide-react';

import { useResource } from '../hooks/useResource.js';
import { useActivity, useHere } from '../context/PresenceContext.jsx';
import { useUnsaved } from '../context/UnsavedContext.jsx';

import { PageHeader } from '../components/ui/Misc.jsx';
import { Button } from '../components/ui/Button.jsx';
import { ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { StateBadge } from '../components/ui/Badge.jsx';
import EnumerationTab from '../components/engagement/EnumerationTab.jsx';

/**
 * The enumeration workbench.
 *
 * The tab is fine for a dozen rows. A real operation's enumeration is a tree of sections with tool
 * runs under them — sixty rows, a hundred — and a 19rem list inside a tab bar is the wrong shape for
 * that: the structure does not fit, and the editor beside it is squeezed into half a column.
 *
 * So this is the same component in a different room. A shell, deliberately thin: a header, a fixed
 * viewport, and one `EnumerationTab` in its page layout. The split, the tree and every action live
 * where they already lived — rendering the component twice, once per pane, would give two copies of
 * its state and therefore two different selections.
 */
export default function EnumerationPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { guard } = useUnsaved();

  const { data: audit, loading, error, reload } = useResource(`/audits/${id}`, { initial: null });
  const [treeHidden, setTreeHidden] = useState(false);

  useActivity(audit?.name ? `Enumerating ${audit.name}` : '');
  useHere(audit?._id ? `engagement:${audit._id}:enumeration` : '');

  const editable = useMemo(
    /* The same rule the tab bar uses: approved is locked, trashed is read-only. */
    () => Boolean(audit) && audit.state !== 'APPROVED' && !audit.deletedAt,
    [audit]
  );

  if (loading) return <LoadingBlock label="Loading the engagement…" />;
  if (error || !audit) {
    return (
      <ErrorState
        title="That engagement could not be opened"
        description={error?.message ?? 'It may have been deleted, or you may not have access to it.'}
        actionLabel="All engagements"
        onAction={() => navigate('/engagements')}
      />
    );
  }

  return (
    /*
     * An ordinary page that grows with its content, scrolled by the window.
     *
     * It was a fixed viewport with two independently scrolling panes at first, and that was the
     * wrong trade: a step with a long write-up got a short scrolling box inside a page that could
     * not scroll, so the editor was always smaller than the screen it sat on. Now the editor is
     * as tall as it needs to be and the tree stays put beside it — see the split in
     * `EnumerationTab`.
     */
    <div className="flex flex-col gap-4">
      <PageHeader
        breadcrumb={
          <Link
            to={`/engagements/${id}?tab=enumeration`}
            onClick={(event) => {
              event.preventDefault();
              guard(() => navigate(`/engagements/${id}?tab=enumeration`));
            }}
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft size={13} />
            {audit.name}
          </Link>
        }
        title={
          <span className="flex items-center gap-2">
            <ScanSearch size={18} className="text-brand-300" />
            Enumeration
          </span>
        }
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{audit.company?.name ?? audit.auditType}</span>
            <StateBadge state={audit.state} />
          </span>
        }
        actions={
          <Button
            variant="ghost"
            size="sm"
            icon={PanelLeftClose}
            onClick={() => setTreeHidden((v) => !v)}
            title={treeHidden ? 'Show the tree' : 'Hide the tree and use the full width'}
          >
            {treeHidden ? 'Show tree' : 'Hide tree'}
          </Button>
        }
      />

      <EnumerationTab
        audit={audit}
        editable={editable}
        onReload={reload}
        layout="page"
        treeHidden={treeHidden}
      />
    </div>
  );
}
