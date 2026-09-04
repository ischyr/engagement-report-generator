import { useMemo } from 'react';
import { TriangleAlert } from 'lucide-react';

import { cn, initialsOf } from '../../lib/utils.js';
import { levelOf, isDeep, LEVELS } from './skills-meta.js';

/**
 * Skills down, people across — the view that answers what a list of profiles cannot.
 *
 * Reading twelve profiles to work out that only one person can run an Active Directory job
 * is the failure this replaces. A grid makes a thin row obvious without anybody counting,
 * and a blank column obvious too.
 *
 * A cell is filled to its level, in one hue: this is an ordinal scale, so four categorical
 * colours would imply four unrelated things. The level is in every cell's tooltip and in the
 * legend, because a grid that can only be read in colour cannot be read by everybody.
 */
export default function SkillMatrix({ skills, people, onPick, activeSkill }) {
  /*
   * Only people who hold something appear as a column.
   *
   * A roster of empty columns is a wall of nothing between the reader and the answer — and
   * the count of people with no record is already on the page as a number worth acting on.
   */
  const columns = useMemo(
    () => people.filter((person) => person.skills.length > 0),
    [people]
  );

  const held = useMemo(() => {
    const map = new Map();
    for (const person of columns) {
      for (const skill of person.skills) {
        map.set(`${person.id}|${skill.name.toLowerCase()}`, skill.level);
      }
    }
    return map;
  }, [columns]);

  if (!skills.length || !columns.length) return null;

  return (
    <div className="flex flex-col gap-3">
      {/* The grid scrolls sideways on its own rather than the page: a wide team should not
          make the whole layout scroll. */}
      <div className="overflow-x-auto">
        <table className="w-full border-separate border-spacing-0 text-xs">
          <thead>
            <tr>
              {/* The name column takes the slack, so the people columns stay a cell wide and
                  a row can be read across without the eye travelling. */}
              <th className="sticky left-0 z-10 w-full bg-surface px-2 pb-2 text-left text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                Skill
              </th>
              <th className="px-2 pb-2 text-right text-[0.625rem] font-semibold uppercase tracking-wider text-fg-subtle">
                Deep
              </th>
              {columns.map((person) => (
                <th key={person.id} className="w-9 px-1 pb-2 align-bottom">
                  {/* Initials, not names: a column per person only works if the header is
                      narrow, and the full name is one hover away. */}
                  <span
                    className="mx-auto grid size-6 place-items-center rounded-md bg-white/[0.04] text-[0.625rem] font-semibold text-fg-muted ring-1 ring-line-soft"
                    title={`${person.fullname}${person.headline ? ` — ${person.headline}` : ''}`}
                  >
                    {initialsOf(person) || '??'}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {skills.map((skill) => {
              const thin = skill.depth <= 1;
              return (
                <tr key={skill.name} className="group/row">
                  <td
                    className={cn(
                      'sticky left-0 z-10 max-w-56 truncate border-t border-line-soft bg-surface px-2 py-1.5',
                      activeSkill === skill.name ? 'text-brand-300' : 'text-fg-muted'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => onPick?.(skill.name)}
                      className="truncate text-left transition hover:text-fg"
                      title={`${skill.people} hold this · ${skill.depth} could take the work today`}
                    >
                      {skill.name}
                    </button>
                  </td>
                  {/* Depth as a number, and marked when it is one or none: this column is
                      the reason the matrix exists. */}
                  <td className="whitespace-nowrap border-t border-line-soft px-2 py-1.5 text-right font-mono tabular-nums">
                    <span className={thin ? 'text-med' : 'text-fg-muted'}>
                      {thin ? (
                        <TriangleAlert size={10} className="mr-1 inline-block align-[-1px]" />
                      ) : null}
                      {skill.depth}
                    </span>
                  </td>
                  {columns.map((person) => {
                    const level = held.get(`${person.id}|${skill.name.toLowerCase()}`);
                    const meta = level ? levelOf(level) : null;
                    return (
                      <td key={person.id} className="w-9 border-t border-line-soft px-1 py-1.5">
                        <button
                          type="button"
                          onClick={() => onPick?.(skill.name)}
                          title={
                            level
                              ? `${person.fullname} — ${skill.name}: ${meta.label}`
                              : `${person.fullname} has not recorded ${skill.name}`
                          }
                          className={cn(
                            'mx-auto grid size-5 place-items-center rounded-[0.25rem] text-[0.5625rem] font-semibold transition',
                            level ? 'text-canvas' : 'text-transparent'
                          )}
                          style={
                            level
                              ? {
                                  // One hue, opacity by level. Deep holdings get a ring as
                                  // well, so "who can actually do this" survives being
                                  // printed, dimmed, or looked at by somebody who cannot
                                  // tell the two blues apart.
                                  backgroundColor: 'var(--color-brand-400)',
                                  opacity: 0.22 + meta.pips * 0.19,
                                  boxShadow: isDeep(level)
                                    ? 'inset 0 0 0 1px var(--color-brand-300)'
                                    : undefined,
                                }
                              : { backgroundColor: 'rgba(255,255,255,0.04)' }
                          }
                        >
                          {level ? meta.short : '·'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* The legend is not decoration: the cells are one letter wide. */}
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.625rem] text-fg-subtle">
        {LEVELS.map((level) => (
          <span key={level.value} className="flex items-center gap-1.5">
            <span
              className="grid size-4 place-items-center rounded-[0.25rem] text-[0.5rem] font-semibold text-canvas"
              style={{
                backgroundColor: 'var(--color-brand-400)',
                opacity: 0.22 + level.pips * 0.19,
              }}
            >
              {level.short}
            </span>
            {level.label}
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-med">
          <TriangleAlert size={11} />
          one deep or none — nobody to cover the work
        </span>
      </p>
    </div>
  );
}
