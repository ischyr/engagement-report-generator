import { useState } from 'react';
import { CalendarCheck, Sparkles, UserPlus } from 'lucide-react';

import { api } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { useResource } from '../../hooks/useResource.js';
import { displayName } from '../../lib/utils.js';

import { Badge } from '../ui/Badge.jsx';
import { Button } from '../ui/Button.jsx';
import { Avatar } from '../ui/Misc.jsx';

const LEVEL_TONE = { expert: 'success', strong: 'success', working: 'neutral', learning: 'neutral' };

/**
 * Who else could be asked, and why.
 *
 * The skills matrix knew who could do what, leave and bookings knew who was around, and findings
 * carry a category — three things that had never been introduced. The reason is always shown:
 * a suggestion nobody can interrogate is one nobody acts on.
 */
export default function ReviewerSuggestions({ audit, onAdded }) {
  const toast = useToast();
  const { data, loading } = useResource(`/audits/${audit._id}/reviewer-suggestions`, {
    initial: null,
  });
  const [adding, setAdding] = useState('');

  const add = async (person) => {
    setAdding(String(person._id));
    try {
      const reviewers = [
        ...(audit.reviewers ?? []).map((entry) => String(entry?._id ?? entry)),
        String(person._id),
      ];
      await api.put(`/audits/${audit._id}`, { reviewers });
      toast.success(
        `${displayName(person)} added as a reviewer`,
        'They have not been asked yet — request the review when you are ready.'
      );
      await onAdded?.();
    } catch (error) {
      toast.fromError(error);
    } finally {
      setAdding('');
    }
  };

  if (loading && !data) return null;
  if (!data?.suggestions?.length) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="flex items-start gap-2 text-[0.6875rem] leading-relaxed text-fg-subtle">
        <Sparkles size={12} className="mt-0.5 shrink-0 text-brand-300" />
        {/*
          The two cases are worded differently on purpose. Matching somebody's recorded skill to
          what the engagement is about is a real reason; simply being free is not, and dressing
          the second up as the first is how a suggestion engine loses its credibility.
        */}
        {data.bySkill ? (
          <span>
            Who else could look at it. These people have recorded skills in{' '}
            {data.topics.slice(0, 3).join(', ')} and are around this week.
          </span>
        ) : (
          <span>
            Nobody has recorded skills matching what this engagement is about, so these are simply
            the people who are free this week.
          </span>
        )}
      </p>

      <ul className="flex flex-col gap-1.5">
        {data.suggestions.map((person) => (
          <li
            key={person._id}
            className="flex flex-wrap items-center gap-2.5 rounded-lg border border-line-soft bg-canvas/40 px-3 py-2"
          >
            <Avatar user={person} size={24} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-xs text-fg">{displayName(person)}</span>
              <span className="block truncate text-[0.625rem] text-fg-subtle">
                {person.title || person.headline || person.username}
              </span>
            </span>

            {person.matchedSkills.slice(0, 2).map((skill) => (
              <Badge
                key={skill.name}
                tone={LEVEL_TONE[skill.level] ?? 'neutral'}
                title={`Recorded as ${skill.level} — matched against "${skill.about}"`}
              >
                {skill.name} · {skill.level}
              </Badge>
            ))}

            <Badge tone="neutral" icon={CalendarCheck}>
              {person.availableDays === person.workingDays
                ? 'free all week'
                : `${person.availableDays} of ${person.workingDays} days`}
            </Badge>

            <Button
              variant="ghost"
              size="sm"
              icon={UserPlus}
              loading={adding === String(person._id)}
              onClick={() => add(person)}
            >
              Add
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
