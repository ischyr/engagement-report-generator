import { cn } from '../../lib/utils.js';
import { levelOf } from './skills-meta.js';

/**
 * A level as four pips.
 *
 * One hue, filled to the level — an ordinal scale drawn the way ordinal scales should be,
 * rather than four categorical colours that imply four unrelated things. The word is always
 * in the tooltip and in the sort, so nothing here rests on colour alone.
 */
export default function SkillPips({ level, size = 'sm', className }) {
  const { pips, label } = levelOf(level);
  const dot = size === 'lg' ? 'h-2 w-2' : 'h-1.5 w-1.5';
  return (
    <span
      className={cn('flex items-center gap-0.5', className)}
      title={label}
      aria-label={label}
    >
      {[1, 2, 3, 4].map((pip) => (
        <span
          key={pip}
          className={cn(dot, 'rounded-full', pip <= pips ? 'bg-brand-400' : 'bg-white/12')}
        />
      ))}
    </span>
  );
}

/**
 * How many people hold a skill at each level, as one bar.
 *
 * Four segments in one hue at rising opacity: the question is "how deep is this", and depth
 * is ordinal. Widths are shares of the holders, so a skill four people hold and one held by
 * one person are comparable at a glance while the numbers stay beside them.
 */
export function DepthBar({ levels, total, className }) {
  const count = total ?? Object.values(levels ?? {}).reduce((sum, n) => sum + n, 0);
  if (!count) return null;
  const segments = [
    { key: 'expert', opacity: 1 },
    { key: 'strong', opacity: 0.72 },
    { key: 'working', opacity: 0.44 },
    { key: 'learning', opacity: 0.22 },
  ];
  return (
    <span
      className={cn('flex h-1.5 w-full overflow-hidden rounded-full bg-white/8', className)}
      aria-hidden
    >
      {segments.map(({ key, opacity }) =>
        levels?.[key] ? (
          <span
            key={key}
            className="h-full first:rounded-l-full last:rounded-r-full"
            style={{
              width: `${(levels[key] / count) * 100}%`,
              backgroundColor: 'var(--color-brand-400)',
              opacity,
            }}
          />
        ) : null
      )}
    </span>
  );
}
