import { Link, useParams } from 'react-router-dom';
import {
  Building2,
  ChevronLeft,
  ExternalLink,
  Mail,
  Phone,
  Repeat2,
  ScrollText,
  ShieldAlert,
  Users,
} from 'lucide-react';

import { useAuth } from '../context/AuthContext.jsx';
import { useResource } from '../hooks/useResource.js';
import ClientTimeline from '../components/clients/ClientTimeline.jsx';
import { formatDate, timeAgo } from '../lib/utils.js';

import { Card, CardBody, CardHeader } from '../components/ui/Card.jsx';
import { PageHeader, Stat, AvatarGroup } from '../components/ui/Misc.jsx';
import { Badge, StateBadge, SeverityBadge } from '../components/ui/Badge.jsx';
import { EmptyState, ErrorState, LoadingBlock } from '../components/ui/Feedback.jsx';
import { Table, TBody, TD, TH, THead, TR } from '../components/ui/Table.jsx';
import { SeverityBar, SeverityLegend } from '../components/cvss/CvssEditor.jsx';
import IntakeCard from '../components/clients/IntakeCard.jsx';
import { ProportionBar, STATUS_META } from '../components/charts/Charts.jsx';

/** The status split, as the three segments of one bar. */
const statusSegments = (remediation) => [
  { label: STATUS_META.open.label, value: remediation?.open ?? 0, fill: STATUS_META.open.fill },
  {
    label: STATUS_META.retesting.label,
    value: remediation?.retesting ?? 0,
    fill: STATUS_META.retesting.fill,
  },
  { label: STATUS_META.fixed.label, value: remediation?.fixed ?? 0, fill: STATUS_META.fixed.fill },
];

/**
 * One client, and every engagement you have run for them.
 *
 * A client is rarely a single job — it is a first assessment, a retest, then next
 * year's — and until now that history was only visible as unrelated rows in a flat
 * list with the client's name repeated on each.
 */
export default function ClientPage() {
  const { id } = useParams();
  const { canWrite } = useAuth();
  const { data, error, loading, reload } = useResource(`/data/companies/${id}/overview`, {
    initial: null,
  });

  if (loading && !data) return <LoadingBlock label="Loading client…" />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const { company, contacts, engagements, totals, recurring = [] } = data;
  const fixed = totals.remediation.fixed;
  const fixRate = totals.findings ? Math.round((fixed / totals.findings) * 100) : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        breadcrumb={
          <Link
            to="/data"
            className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition hover:text-fg"
          >
            <ChevronLeft size={13} />
            Clients &amp; data
          </Link>
        }
        title={company.name}
        description={
          [company.shortName, company.address].filter(Boolean).join(' · ') ||
          'No address on file'
        }
        actions={
          company.website ? (
            <a
              href={/^https?:/i.test(company.website) ? company.website : `https://${company.website}`}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 rounded-lg border border-line-soft px-3 py-2 text-xs text-fg-muted transition hover:border-brand-500/40 hover:text-fg"
            >
              <ExternalLink size={13} />
              {company.website.replace(/^https?:\/\//i, '')}
            </a>
          ) : null
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Engagements"
          value={totals.engagements}
          sub={totals.engagements === 1 ? 'one so far' : 'across all time'}
          icon={ScrollText}
        />
        <Stat label="Findings" value={totals.findings} sub="every engagement" icon={ShieldAlert} />
        <Stat
          label="Open critical & high"
          value={totals.openSerious}
          tone={totals.openSerious > 0 ? 'crit' : 'low'}
          sub={totals.openSerious === 0 ? 'nothing serious outstanding' : 'still not fixed'}
        />
        <Stat
          label="Fixed"
          value={fixRate === null ? '—' : `${fixRate}%`}
          tone={fixRate !== null && fixRate >= 50 ? 'low' : 'med'}
          sub={fixRate === null ? 'no findings yet' : `${fixed} of ${totals.findings} findings`}
        />
      </div>

      {/* Before the risk picture, because it is about work that has not started yet. */}
      <IntakeCard companyId={id} canWrite={canWrite} />

      {/* Risk across the whole relationship, not one engagement. */}
      {totals.findings > 0 ? (
        <Card>
          <CardBody className="flex flex-col gap-4 sm:flex-row sm:items-center sm:gap-8">
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <p className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
                  Severity, all engagements
                </p>
                <SeverityLegend counts={totals.severityCounts} className="gap-x-3" />
              </div>
              <SeverityBar counts={totals.severityCounts} total={totals.findings} height={8} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="mb-1.5 flex items-center justify-between gap-3">
                <p className="text-[0.6875rem] uppercase tracking-wider text-fg-subtle">
                  Remediation
                </p>
                <ul className="flex flex-wrap items-center gap-x-3">
                  {statusSegments(totals.remediation).map((segment) => (
                    <li key={segment.label} className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        style={{ background: segment.fill }}
                        className="size-2 rounded-sm"
                      />
                      <span className="text-[0.625rem] text-fg-muted">
                        {segment.label}
                        <span className="ml-1 font-mono tabular-nums text-fg-subtle">
                          {segment.value}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              <ProportionBar segments={statusSegments(totals.remediation)} height={8} />
            </div>
          </CardBody>
        </Card>
      ) : null}

      {/* What this client keeps being told. The most useful thing on the page for
          writing next year's report, and previously impossible to see at all. */}
      {recurring.length ? (
        <Card>
          <CardHeader
            icon={Repeat2}
            title="Recurring issues"
            description={
              totals.recurringOpen
                ? `${totals.recurringOpen} of ${recurring.length} have been reported before and are still not fixed.`
                : 'Reported in more than one engagement. All of these have since been fixed.'
            }
          />
          <Table>
            <THead>
              <TH>Issue</TH>
              <TH>Severity</TH>
              <TH>Engagements</TH>
              <TH>Latest status</TH>
              <TH align="right">First seen</TH>
            </THead>
            <TBody>
              {recurring.map((issue) => (
                <TR key={`${issue.title}-${issue.firstSeen}`}>
                  <TD className="max-w-sm">
                    <span className="block truncate text-sm text-fg" title={issue.title}>
                      {issue.title}
                    </span>
                    <span className="mt-0.5 block truncate text-[0.625rem] text-fg-subtle">
                      {issue.occurrences
                        .map((occurrence) => occurrence.reference || occurrence.auditName)
                        .join(' → ')}
                    </span>
                  </TD>
                  <TD>
                    <SeverityBadge severity={issue.severity} />
                  </TD>
                  <TD className="text-xs text-fg-muted">{issue.engagementCount}</TD>
                  <TD>
                    {issue.stillOpen ? (
                      <Badge tone="danger">
                        {issue.status === 'retesting' ? 'still being retested' : 'still not fixed'}
                      </Badge>
                    ) : (
                      <Badge tone="success">
                        fixed{issue.daysToFix !== null ? ` after ${issue.daysToFix} days` : ''}
                      </Badge>
                    )}
                  </TD>
                  <TD align="right" className="text-xs text-fg-muted">
                    {issue.firstSeen ? formatDate(issue.firstSeen) : '—'}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </Card>
      ) : null}

      {/* The point of the page: every engagement for this client, newest first. */}
      <Card>
        <CardHeader
          icon={ScrollText}
          title="Engagements"
          description="Every assessment run for this client, most recently worked on first."
        />
        {engagements.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title="No engagements for this client yet"
            description="Create one from the Engagements page and pick this client — it will appear here."
          />
        ) : (
          <Table>
            <THead>
              <TH>Engagement</TH>
              <TH>Findings</TH>
              <TH>Remediation</TH>
              <TH>Checks</TH>
              <TH>Team</TH>
              <TH>Status</TH>
              <TH align="right">Dates</TH>
            </THead>
            <TBody>
              {engagements.map((engagement) => (
                <TR key={engagement._id}>
                  <TD className="max-w-xs">
                    <Link
                      to={`/engagements/${engagement._id}`}
                      className="block truncate text-sm font-medium text-fg hover:text-brand-300"
                    >
                      {engagement.name}
                    </Link>
                    <p className="mt-0.5 truncate text-xs text-fg-muted">
                      {[engagement.reference, engagement.auditType].filter(Boolean).join(' · ') ||
                        '—'}
                    </p>
                  </TD>
                  <TD className="w-48">
                    {engagement.findingCount ? (
                      <div className="flex flex-col gap-1.5">
                        <SeverityBar
                          counts={engagement.severityCounts}
                          total={engagement.findingCount}
                        />
                        <SeverityLegend counts={engagement.severityCounts} className="gap-x-2.5" />
                      </div>
                    ) : (
                      <span className="text-xs text-fg-subtle">None yet</span>
                    )}
                  </TD>
                  <TD className="w-32">
                    {engagement.findingCount ? (
                      <div className="flex flex-col gap-1">
                        <ProportionBar segments={statusSegments(engagement.remediation)} height={6} />
                        <span className="font-mono text-[0.625rem] tabular-nums text-fg-subtle">
                          {engagement.remediation.fixed}/{engagement.findingCount} fixed
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-fg-subtle">—</span>
                    )}
                  </TD>
                  <TD className="whitespace-nowrap font-mono text-xs tabular-nums text-fg-muted">
                    {engagement.checks.total
                      ? `${engagement.checks.done}/${engagement.checks.total}`
                      : '—'}
                  </TD>
                  <TD>
                    <AvatarGroup
                      users={[engagement.creator, ...(engagement.collaborators ?? [])].filter(
                        Boolean
                      )}
                    />
                  </TD>
                  <TD>
                    <StateBadge state={engagement.state} />
                  </TD>
                  <TD align="right" className="whitespace-nowrap text-xs text-fg-muted">
                    {engagement.date_start || engagement.date_end ? (
                      <span>
                        {formatDate(engagement.date_start) || '?'} –{' '}
                        {formatDate(engagement.date_end) || '?'}
                      </span>
                    ) : (
                      <span title={`Last worked on ${timeAgo(engagement.updatedAt)}`}>
                        {timeAgo(engagement.updatedAt)}
                      </span>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        )}
      </Card>

      {/* The relationship as a story, assembled from the records the rest of this page summarises. */}
      <ClientTimeline companyId={id} />

      <Card>
        <CardHeader
          icon={Users}
          title="Contacts"
          description="The people at this client. A report's recipient is picked from these."
        />
        {contacts.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No contacts yet"
            description="Add them under Clients & data → Contacts so they can be selected on an engagement."
          />
        ) : (
          <CardBody className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {contacts.map((contact) => (
              <div
                key={contact._id}
                className="flex flex-col gap-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
              >
                <p className="truncate text-sm font-medium text-fg">
                  {[contact.firstname, contact.lastname].filter(Boolean).join(' ') || contact.email}
                </p>
                {contact.title ? (
                  <p className="truncate text-[0.6875rem] text-fg-subtle">{contact.title}</p>
                ) : null}
                <a
                  href={`mailto:${contact.email}`}
                  className="flex items-center gap-1.5 truncate text-xs text-fg-muted transition hover:text-brand-300"
                >
                  <Mail size={12} className="shrink-0" />
                  {contact.email}
                </a>
                {contact.phone || contact.cell ? (
                  <p className="flex items-center gap-1.5 text-xs text-fg-muted">
                    <Phone size={12} className="shrink-0" />
                    {[contact.phone, contact.cell].filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
            ))}
          </CardBody>
        )}
      </Card>

      {company.logo ? (
        <Card>
          <CardHeader
            icon={Building2}
            title="Logo"
            description="Used on the cover page when your template includes it."
          />
          <CardBody>
            <img
              src={company.logo}
              alt={`${company.name} logo`}
              className="max-h-24 rounded bg-white/5 p-2"
            />
          </CardBody>
        </Card>
      ) : null}
    </div>
  );
}
