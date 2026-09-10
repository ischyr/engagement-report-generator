import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Archive, ArchiveRestore, ArrowLeft, Building2 } from 'lucide-react';

import { api } from '../lib/api.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useToast } from '../context/ToastContext.jsx';
import { useResource } from '../hooks/useResource.js';
import { formatDate, timeAgo } from '../lib/utils.js';

import { Card } from '../components/ui/Card.jsx';
import { PageHeader, SearchInput } from '../components/ui/Misc.jsx';
import { Badge, StateBadge } from '../components/ui/Badge.jsx';
import { Button } from '../components/ui/Button.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { SeverityBar } from '../components/cvss/CvssEditor.jsx';

/**
 * Engagements that are finished and put away.
 *
 * Not the trash — nothing here is going to be deleted, and there is no countdown. Archiving is
 * about the working list: a firm that has run four hundred engagements should not scroll past all
 * of them to find this month's, and the alternative people reach for otherwise is deleting things
 * they actually want to keep.
 *
 * Everything remains readable, and still counts everywhere the question is historical — the
 * delivery register, the client's own page, the insights.
 */
export default function ArchivePage() {
  const { canWrite } = useAuth();
  const toast = useToast();
  const { data, error, loading, reload } = useResource('/audits?archived=1', { initial: [] });

  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState('');

  const list = Array.isArray(data) ? data : [];

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((audit) =>
      [audit.name, audit.reference, audit.auditType, audit.company?.name, ...(audit.tags ?? [])]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(needle))
    );
  }, [list, search]);

  const restore = async (audit) => {
    setBusy(String(audit._id));
    try {
      await api.del(`/audits/${audit._id}/archive`);
      await reload({ quiet: true });
      toast.success('Back in the list', `"${audit.name}" is being worked on again.`);
    } catch (err) {
      toast.fromError(err);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={
          <Link
            to="/engagements"
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ArrowLeft size={13} />
            Engagements
          </Link>
        }
        title="Archive"
        description="Finished engagements, put away. Nothing here is deleted or expiring — it is out of the working list and otherwise entirely intact."
        actions={
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search the archive…"
            className="w-full sm:w-72"
          />
        }
      />

      <Card>
        {loading ? (
          <LoadingBlock label="Reading the archive…" />
        ) : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : filtered.length === 0 ? (
          <EmptyState
            icon={Archive}
            title={list.length === 0 ? 'Nothing archived yet' : 'Nothing matches that'}
            description={
              list.length === 0
                ? 'Archive an engagement from its Overview once the work is over. It leaves the engagements list and stays here, readable, for good.'
                : 'No archived engagement matches what you typed.'
            }
          />
        ) : (
          <Table>
            <THead>
              <TH>Engagement</TH>
              <TH width="12rem">Findings</TH>
              <TH width="8rem">State</TH>
              <TH width="10rem">Archived</TH>
              <TH width="7rem" />
            </THead>
            <TBody>
              {filtered.map((audit) => (
                <TR key={audit._id}>
                  <TD className="max-w-sm">
                    <Link
                      to={`/engagements/${audit._id}`}
                      className="block truncate text-sm font-medium text-fg transition hover:text-brand-300"
                    >
                      {audit.name}
                    </Link>
                    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-subtle">
                      {audit.reference ? <span>{audit.reference}</span> : null}
                      {audit.company?.name ? (
                        <span className="inline-flex items-center gap-1">
                          <Building2 size={10} />
                          {audit.company.name}
                        </span>
                      ) : null}
                      {(audit.tags ?? []).slice(0, 3).map((tag) => (
                        <span key={tag} className="rounded bg-white/[0.05] px-1.5 py-0.5">
                          {tag}
                        </span>
                      ))}
                    </span>
                  </TD>
                  <TD>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-xs tabular-nums text-fg-muted">
                        {audit.findingCount ?? 0}
                      </span>
                      <span className="min-w-0 flex-1">
                        <SeverityBar
                          counts={audit.severityCounts}
                          total={audit.findingCount}
                        />
                      </span>
                    </span>
                  </TD>
                  <TD>
                    <StateBadge state={audit.state} />
                  </TD>
                  <TD className="whitespace-nowrap text-xs text-fg-muted">
                    <span title={formatDate(audit.archivedAt)}>{timeAgo(audit.archivedAt)}</span>
                  </TD>
                  <TD align="right">
                    {canWrite ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={ArchiveRestore}
                        loading={busy === String(audit._id)}
                        onClick={() => restore(audit)}
                      >
                        Restore
                      </Button>
                    ) : (
                      <Badge tone="neutral">archived</Badge>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>
    </div>
  );
}
