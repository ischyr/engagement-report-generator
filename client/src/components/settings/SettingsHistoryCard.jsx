import { History, RotateCcw } from 'lucide-react';

import { useResource } from '../../hooks/useResource.js';
import { displayName, formatDateTime, timeAgo } from '../../lib/utils.js';

import { Card, CardBody, CardHeader } from '../ui/Card.jsx';
import { Badge } from '../ui/Badge.jsx';
import { EmptyState, LoadingBlock } from '../ui/Feedback.jsx';

/**
 * Readable names for the settings that can change.
 *
 * A dotted path is precise and unreadable — "reviews.public.minReviewers" is not what anybody
 * calls it. Unknown paths fall through to the path itself, so a setting added later still shows
 * up rather than disappearing from the log for want of a label.
 */
const LABELS = {
  'branding.appName': 'Instance name',
  'branding.tagline': 'Tagline',
  'branding.logo': 'Logo',
  'report.public.dateFormat': 'Date format',
  'report.public.findingIdPrefix': 'Finding ID prefix',
  'report.public.captionStyle': 'Caption style',
  'report.public.codeBlockTheme': 'Code block theme',
  'report.public.extendCvssTemporalEnvironment': 'Extended CVSS metrics',
  'report.private.imageBorder': 'Screenshot borders',
  'report.private.imageBorderColor': 'Screenshot border colour',
  'reviews.enabled': 'Reviews',
  'reviews.public.mandatoryReview': 'Approvals required before approving',
  'reviews.public.minReviewers': 'Minimum approvals',
  'reviews.private.removeApprovalsUponUpdate': 'Clear approvals when the report changes',
  'danger.public.nbdaydelete': 'Days in the trash',
};

const labelFor = (path) => {
  if (LABELS[path]) return LABELS[path];
  // Colours are the one family worth deriving, since there are twelve of them.
  const colour = /^report\.public\.(cvssColors|remediationColorsPriority|remediationColorsComplexity)\.(\w+)$/.exec(
    path
  );
  if (colour) {
    const family = {
      cvssColors: 'Severity colour',
      remediationColorsPriority: 'Priority colour',
      remediationColorsComplexity: 'Complexity colour',
    }[colour[1]];
    const which = colour[2].replace(/Color$/, '');
    return `${family} — ${which.charAt(0).toUpperCase()}${which.slice(1)}`;
  }
  return path;
};

/** A colour reads better as a swatch than as six hex digits. */
function Value({ path, value }) {
  if (value === '') return <span className="text-fg-subtle">empty</span>;
  const isColour = /Color$/.test(path) && /^[0-9A-F]{6}$/i.test(value);
  return (
    <span className="inline-flex items-center gap-1.5">
      {isColour ? (
        <span
          aria-hidden
          className="size-2.5 rounded-sm ring-1 ring-line-soft"
          style={{ backgroundColor: `#${value}` }}
        />
      ) : null}
      <span className="font-mono text-[0.625rem]">{value}</span>
    </span>
  );
}

/**
 * Who changed a setting, when, and what it was before.
 *
 * Every engagement keeps an activity log; the settings governing all of them kept none, so the
 * review quorum could be lowered or the trash shortened with nothing to show for it afterwards.
 */
export default function SettingsHistoryCard() {
  const { data, loading } = useResource('/settings/history', { initial: null });
  const changes = data?.changes ?? [];

  return (
    <Card>
      <CardHeader
        icon={History}
        title="What has been changed here"
        description="Every save on this page, with what each value was before. Bulky values — a logo, say — are described rather than quoted."
      />
      {loading && !data ? (
        <LoadingBlock label="Reading the history…" />
      ) : changes.length === 0 ? (
        <EmptyState
          icon={History}
          title="Nothing changed yet"
          description="Saves on this page are recorded here: who, when, and the previous value."
        />
      ) : (
        <CardBody className="flex flex-col gap-2.5">
          {changes.map((entry) => (
            <div
              key={entry._id}
              className="rounded-lg border border-line-soft bg-canvas/40 px-3 py-2.5"
            >
              <p className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-medium text-fg">
                  {displayName(entry.actor) || 'Somebody'}
                </span>
                {entry.action === 'reset' ? (
                  <Badge tone="warning" icon={RotateCcw}>
                    restored the defaults
                  </Badge>
                ) : (
                  <span className="text-fg-muted">
                    changed {entry.changes.length} setting{entry.changes.length === 1 ? '' : 's'}
                  </span>
                )}
                <span className="ml-auto text-[0.625rem] text-fg-subtle" title={formatDateTime(entry.at)}>
                  {timeAgo(entry.at)}
                </span>
              </p>

              {entry.changes.length ? (
                <ul className="mt-1.5 flex flex-col gap-1">
                  {entry.changes.map((change) => (
                    <li
                      key={change.path}
                      className="flex flex-wrap items-center gap-x-2 text-[0.6875rem] text-fg-muted"
                    >
                      <span className="text-fg-subtle">{labelFor(change.path)}</span>
                      <Value path={change.path} value={change.from} />
                      <span className="text-fg-subtle">→</span>
                      <Value path={change.path} value={change.to} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))}
        </CardBody>
      )}
    </Card>
  );
}
