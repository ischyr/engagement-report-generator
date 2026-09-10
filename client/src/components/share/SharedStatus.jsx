import { CalendarClock, MapPin, ShieldQuestion } from 'lucide-react';

import { formatDate, formatDateTime } from '../../lib/utils.js';
import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Alert } from '../ui/Alert.jsx';

/**
 * What a client sees while the test is still running.
 *
 * The question they ask on day three is "how is it going", and it went by email because nothing
 * here could be shown to them mid-test. This is that answer: how far through the scope the team
 * has got, how much has been found, and the assets they need to do something about.
 *
 * **There is no finding text on this page at all** — not a title, not a description, not a status.
 * That is decided on the server, in `statusView`, and this renders what it is given; but it is
 * worth saying here too, because the temptation to add "just the titles" is exactly the thing the
 * separation exists to resist. A count is a fact about progress. A draft finding is somebody's
 * half-written argument, and a client reading one over an author's shoulder is how a report gets
 * argued about before it is written.
 *
 * The caveat at the bottom is not boilerplate either: a page that looks like a report, on a link
 * that behaves like a report's, will be read as one unless it says plainly that it is not.
 */

const SEVERITY_TONE = {
  Critical: 'text-crit',
  High: 'text-high',
  Medium: 'text-med',
  Low: 'text-low',
  None: 'text-info',
};

/** A list of assets with the sentence the team wrote for this client about each. */
function AssetList({ icon: Icon, title, description, assets }) {
  if (!assets?.length) return null;
  return (
    <Card>
      <CardHeader icon={Icon} title={`${title} (${assets.length})`} description={description} />
      <CardBody className="p-0">
        <ul className="divide-y divide-line-soft">
          {assets.map((asset) => (
            <li key={asset.asset} className="px-4 py-2.5">
              <span className="block font-mono text-xs text-fg">{asset.asset}</span>
              {asset.note ? (
                <span className="mt-0.5 block text-[0.6875rem] leading-relaxed text-fg-muted">
                  {asset.note}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </CardBody>
    </Card>
  );
}

export default function SharedStatus({ data }) {
  const { engagement, coverage, findings } = data;
  const reached = coverage.total ? Math.round((coverage.tested / coverage.total) * 100) : 0;

  return (
    <div className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-6">
        <p className="text-xs font-medium uppercase tracking-wider text-brand-300">{data.firm}</p>
        <h1 className="mt-1 text-2xl font-semibold text-fg">{engagement.name}</h1>
        <p className="mt-1 text-sm text-fg-muted">
          {[engagement.client, engagement.type].filter(Boolean).join(' · ')}
          {engagement.from && engagement.to
            ? ` · ${formatDate(engagement.from)} to ${formatDate(engagement.to)}`
            : ''}
        </p>
      </header>

      <Card className="mb-4">
        <CardBody className="flex flex-wrap items-center gap-x-8 gap-y-3">
          <span className="text-sm text-fg">
            <CalendarClock size={14} className="mr-1.5 inline text-brand-300" />
            {data.stateLabel}
          </span>
          <span className="ml-auto text-[0.6875rem] text-fg-subtle">
            As of {formatDateTime(data.asOf)}
          </span>
        </CardBody>
      </Card>

      {coverage.total ? (
        <Card className="mb-4">
          <CardHeader
            icon={MapPin}
            title="How much of the scope has been reached"
            description={`${coverage.tested} of ${coverage.total} assets tested so far.`}
          />
          <CardBody className="flex flex-col gap-3">
            <div
              className="h-2 w-full overflow-hidden rounded-full bg-white/6"
              role="img"
              aria-label={`${reached}% of the scope tested`}
            >
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${reached}%` }} />
            </div>
            <div className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
              <span className="text-fg">
                <span className="text-xl font-semibold">{coverage.tested}</span>{' '}
                <span className="text-xs text-fg-muted">tested</span>
              </span>
              <span className="text-fg">
                <span className="text-xl font-semibold">{coverage.pending}</span>{' '}
                <span className="text-xs text-fg-muted">not yet</span>
              </span>
              <span className="text-fg">
                <span className="text-xl font-semibold">{coverage.excluded}</span>{' '}
                <span className="text-xs text-fg-muted">excluded</span>
              </span>
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Card className="mb-4">
        <CardHeader
          icon={ShieldQuestion}
          title="What has been found so far"
          description="Counts only, and provisional. Severities move as things are confirmed, and every one of these is written up in the report you will receive."
        />
        <CardBody className="flex flex-wrap gap-x-8 gap-y-2">
          {findings.total ? (
            findings.bySeverity
              .filter((row) => row.count)
              .map((row) => (
                <span key={row.severity} className="text-sm text-fg">
                  <span
                    className={`text-xl font-semibold ${SEVERITY_TONE[row.severity] ?? 'text-fg'}`}
                  >
                    {row.count}
                  </span>{' '}
                  <span className="text-xs text-fg-muted">
                    {row.severity === 'None' ? 'informational' : row.severity.toLowerCase()}
                  </span>
                </span>
              ))
          ) : (
            <span className="text-sm text-fg-muted">Nothing raised yet.</span>
          )}
        </CardBody>
      </Card>

      <div className="mb-4 flex flex-col gap-4">
        <AssetList
          icon={MapPin}
          title="Not reached yet"
          description="Still on the list. If one of these needs access arranging, this is the moment to say."
          assets={coverage.notYetTested}
        />
        <AssetList
          icon={MapPin}
          title="Excluded"
          description="Agreed as out of scope, or not reachable. The note says which."
          assets={coverage.excludedAssets}
        />
      </div>

      <Alert tone="info" title="This is a progress view, not the report">
        Everything here is provisional: findings are still being written and confirmed, and
        severities can move. The report you receive at the end is the record — this page is only so
        you do not have to ask how it is going.
      </Alert>

      <p className="mt-6 text-center text-[0.6875rem] text-fg-subtle">
        This link expires on {formatDate(data.expiresAt)}.
      </p>
    </div>
  );
}
