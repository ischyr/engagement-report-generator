import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Check, Rocket, X } from 'lucide-react';

import { useAuth } from '../../context/AuthContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { cn } from '../../lib/utils.js';

import { Card, CardBody } from '../ui/Card.jsx';
import { Button } from '../ui/Button.jsx';

const DISMISSED = 'engy:setup:dismissed';

/**
 * The four things a fresh instance needs, in the order they need doing.
 *
 * A new instance dropped somebody on a Dashboard whose only guidance was a warning that there
 * were no templates — true, and no help at all about what to do first or what else was missing.
 *
 * Every step is derived from a count, never from a stored flag: an instance that has a client has
 * done that step whether or not anybody pressed anything here, and a flag would have to be
 * migrated, unset and kept honest for no benefit. The whole card disappears once the four are
 * done, so it cannot become furniture.
 */
export default function SetupChecklist() {
  const { isAdmin } = useAuth();
  const [hidden, setHidden] = useState(() => {
    try {
      return window.localStorage.getItem(DISMISSED) === '1';
    } catch {
      return false;
    }
  });

  /*
   * Counts, not lists.
   *
   * The alternative is fetching companies, templates, engagements and the library to ask whether
   * each has one row — which on a real instance is megabytes to answer four booleans.
   */
  const { data } = useResource('/setup', { initial: null });

  const steps = useMemo(() => {
    if (!data) return [];
    return [
      {
        key: 'client',
        done: data.companies > 0,
        title: 'Add a client',
        detail: 'Engagements belong to a company, and reports take their name and logo from it.',
        href: '/data',
        action: 'Clients & data',
      },
      {
        key: 'template',
        done: data.templates + data.htmlTemplates > 0,
        title: 'Upload a report template',
        detail:
          'Your own .docx, with placeholders where the content goes — the look of the report stays yours.',
        href: '/templates',
        action: 'Templates',
      },
      {
        key: 'engagement',
        done: data.engagements > 0,
        title: 'Create an engagement',
        detail: 'The container for findings, scope, evidence and everything else.',
        href: '/engagements',
        action: 'Engagements',
      },
      {
        key: 'library',
        done: data.library > 0,
        title: 'Fill the vulnerability library',
        detail:
          'Write a finding once and reuse it. `npm run seed` puts a starter set in, or add your own.',
        href: '/vulnerabilities',
        action: 'Library',
      },
    ];
  }, [data]);

  const done = steps.filter((step) => step.done).length;

  // Nothing to say once it is all done — or before the counts arrive, or to somebody who could
  // not action it anyway.
  if (!isAdmin || hidden || !steps.length || done === steps.length) return null;

  const dismiss = () => {
    try {
      window.localStorage.setItem(DISMISSED, '1');
    } catch {
      /* storage off: the card simply comes back next time, which is not a failure */
    }
    setHidden(true);
  };

  return (
    <Card className="border-brand-500/25 bg-brand-500/[0.05]">
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-start gap-3">
          <Rocket size={16} className="mt-0.5 shrink-0 text-brand-300" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-fg">Setting this up</p>
            <p className="mt-0.5 text-xs text-fg-muted">
              {done} of {steps.length} done. Everything here is derived from what the instance
              actually has, so it ticks itself off.
            </p>
          </div>
          {/* A progress bar and the count: the bar compares, the number is the value. */}
          <span className="hidden items-center gap-2 sm:flex">
            <span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full bg-brand-400 transition-all"
                style={{ width: `${(done / steps.length) * 100}%` }}
              />
            </span>
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            icon={X}
            title="Hide this"
            aria-label="Hide the setup checklist"
            onClick={dismiss}
          />
        </div>

        <ol className="flex flex-col gap-1.5">
          {steps.map((step, index) => (
            <li
              key={step.key}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2',
                step.done
                  ? 'border-line-soft bg-canvas/30 opacity-60'
                  : 'border-line-soft bg-canvas/50'
              )}
            >
              <span
                className={cn(
                  'grid size-5 shrink-0 place-items-center rounded-full text-[0.625rem] font-semibold',
                  step.done ? 'bg-low/15 text-low' : 'bg-white/8 text-fg-muted'
                )}
              >
                {step.done ? <Check size={12} /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-xs font-medium',
                    step.done ? 'text-fg-muted line-through' : 'text-fg'
                  )}
                >
                  {step.title}
                </span>
                <span className="block truncate text-[0.625rem] text-fg-subtle">{step.detail}</span>
              </span>
              {!step.done ? (
                <Button as={Link} to={step.href} variant="secondary" size="sm">
                  {step.action}
                </Button>
              ) : null}
            </li>
          ))}
        </ol>
      </CardBody>
    </Card>
  );
}
