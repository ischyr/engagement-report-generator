import { useMemo } from 'react';
import { Award, Languages, Pencil, Sparkles, TriangleAlert, Wrench } from 'lucide-react';

import { cn, formatDate } from '../../lib/utils.js';

import { Modal } from '../ui/Modal.jsx';
import { Button } from '../ui/Button.jsx';
import { Badge } from '../ui/Badge.jsx';
import { Avatar } from '../ui/Misc.jsx';
import SkillPips from './SkillPips.jsx';
import { LEVELS, byStrength, expiryState, isDeep, levelOf, monthsAway } from './skills-meta.js';

/**
 * One person, in full, with what is true of them that no card could say.
 *
 * The two facts worth surfacing here are about the *team*, not the person: which of their
 * skills nobody else holds — the ones an absence would cost — and which they are the only
 * deep holder of. Both are answers a reader would otherwise assemble by cross-referencing
 * every other profile on the page.
 */
export default function PersonProfile({ person, skills, open, onClose, onEdit, canEdit, isMe }) {
  const insight = useMemo(() => {
    if (!person) return null;
    const byName = new Map((skills ?? []).map((skill) => [skill.name.toLowerCase(), skill]));

    const unique = [];
    const soleDeep = [];
    for (const skill of person.skills) {
      const tally = byName.get(skill.name.toLowerCase());
      if (!tally) continue;
      if (tally.people === 1) unique.push(skill);
      else if (isDeep(skill.level) && tally.depth === 1) soleDeep.push(skill);
    }

    const grouped = LEVELS.map((level) => ({
      ...level,
      items: person.skills.filter((skill) => skill.level === level.value).sort(byStrength),
    }))
      .filter((group) => group.items.length)
      .reverse();

    const certifications = [...person.certifications].sort((a, b) => {
      const left = a.expiresAt || '9999';
      const right = b.expiresAt || '9999';
      return left.localeCompare(right) || a.name.localeCompare(b.name);
    });

    return { unique, soleDeep, grouped, certifications };
  }, [person, skills]);

  if (!person || !insight) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="lg"
      title={person.fullname}
      description={person.headline || person.title || 'No headline recorded yet.'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {canEdit ? (
            <Button variant="primary" icon={Pencil} onClick={onEdit}>
              {isMe ? 'Edit yours' : `Edit ${person.firstname || person.fullname}`}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-start gap-3">
          <Avatar user={person} size={44} />
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg">
              <span className="font-semibold">{person.fullname}</span>
              {isMe ? <Badge tone="brand">you</Badge> : null}
              <span className="text-[0.6875rem] capitalize text-fg-subtle">{person.role}</span>
            </p>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.6875rem] text-fg-subtle">
              <span className="font-mono text-fg-muted">@{person.username}</span>
              {person.yearsExperience !== null ? (
                <span>
                  {person.yearsExperience} year{person.yearsExperience === 1 ? '' : 's'} in the
                  trade
                </span>
              ) : null}
              {person.languages.length ? (
                <span className="flex items-center gap-1">
                  <Languages size={11} />
                  {person.languages.join(', ')}
                </span>
              ) : null}
            </p>
          </div>
        </div>

        {person.bio ? (
          <p className="whitespace-pre-wrap border-l-2 border-line pl-3 text-xs leading-relaxed text-fg-muted">
            {person.bio}
          </p>
        ) : null}

        {/* What the team loses without them. The point of a skills record is not the list. */}
        {insight.unique.length || insight.soleDeep.length ? (
          <div className="flex flex-col gap-2 rounded-lg border border-line-soft bg-canvas/40 p-3">
            <p className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
              <Sparkles size={12} className="text-brand-300" />
              What only they cover
            </p>
            {insight.unique.length ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                <span className="shrink-0">Nobody else has recorded</span>
                {insight.unique.sort(byStrength).map((skill) => (
                  <span
                    key={skill.name}
                    className="rounded-md bg-brand-500/12 px-1.5 py-0.5 text-brand-300 ring-1 ring-brand-500/25"
                  >
                    {skill.name}
                  </span>
                ))}
              </p>
            ) : null}
            {insight.soleDeep.length ? (
              <p className="flex flex-wrap items-center gap-1.5 text-xs text-fg-muted">
                <TriangleAlert size={12} className="shrink-0 text-med" />
                <span className="shrink-0">Only person who could take the work on</span>
                {insight.soleDeep.sort(byStrength).map((skill) => (
                  <span
                    key={skill.name}
                    className="rounded-md bg-med/12 px-1.5 py-0.5 text-med ring-1 ring-med/25"
                  >
                    {skill.name}
                  </span>
                ))}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Skills grouped by level, strongest group first — a profile is read to find out
            what somebody can be given, and that is the top of this list. */}
        <div className="flex flex-col gap-3">
          <p className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
            <Wrench size={12} />
            Skills
            <span className="font-mono normal-case tracking-normal text-fg-subtle">
              {person.skills.length}
            </span>
          </p>
          {insight.grouped.length ? (
            insight.grouped.map((group) => (
              <div key={group.value} className="flex flex-wrap items-center gap-2">
                <span
                  className={cn(
                    'flex w-36 shrink-0 items-center gap-2 text-[0.6875rem]',
                    group.pips >= 3 ? 'text-fg' : 'text-fg-subtle'
                  )}
                >
                  <SkillPips level={group.value} />
                  {group.label}
                </span>
                <span className="flex flex-1 flex-wrap gap-1.5">
                  {group.items.map((skill) => (
                    <span
                      key={skill.name}
                      className="rounded-lg bg-white/[0.03] px-2 py-1 text-xs text-fg ring-1 ring-line-soft"
                    >
                      {skill.name}
                    </span>
                  ))}
                </span>
              </div>
            ))
          ) : (
            <p className="text-xs text-fg-subtle">Nothing recorded yet.</p>
          )}
        </div>

        {/* Certifications, soonest expiry first: the list is read for what needs renewing. */}
        {insight.certifications.length ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 text-[0.6875rem] font-semibold uppercase tracking-wider text-fg-subtle">
              <Award size={12} />
              Certifications
              <span className="font-mono normal-case tracking-normal text-fg-subtle">
                {insight.certifications.length}
              </span>
            </p>
            {insight.certifications.map((entry) => {
              const state = expiryState(entry.expiresAt);
              const months = monthsAway(entry.expiresAt);
              return (
                <div
                  key={`${entry.name}-${entry.obtainedAt}`}
                  className="flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2 text-xs"
                >
                  <span className="font-medium text-fg">{entry.name}</span>
                  {entry.issuer ? <span className="text-fg-subtle">{entry.issuer}</span> : null}
                  {entry.obtainedAt ? (
                    <span className="text-[0.625rem] text-fg-subtle">
                      held since {formatDate(entry.obtainedAt)}
                    </span>
                  ) : null}
                  <span className="ml-auto flex items-center gap-2">
                    {entry.expiresAt ? (
                      <span className="text-[0.625rem] text-fg-subtle">
                        {formatDate(entry.expiresAt)}
                        {months !== null && months >= 0 && months <= 18
                          ? ` · ${months === 0 ? 'this month' : `${months} month${months === 1 ? '' : 's'}`}`
                          : ''}
                      </span>
                    ) : null}
                    <Badge tone={state.tone}>{state.label}</Badge>
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
