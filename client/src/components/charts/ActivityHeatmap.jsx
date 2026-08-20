import { useMemo } from 'react';

import { cn, formatDate } from '../../lib/utils.js';

const WEEKDAYS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Activity as a calendar of squares: weeks across, days down.
 *
 * Five steps of one hue, not a gradient. The question is "was anything happening", and an ordinal
 * scale with a handful of levels answers it at a glance — a continuous ramp asks the reader to
 * compare two shades of blue, which nobody can do and which is unreadable to anyone with a colour
 * vision deficiency. Every square carries its date and count in the title, so the picture is a
 * summary and the tooltip is the data.
 *
 * The empty days are the point. A list of log rows cannot show a fortnight where nothing moved,
 * because there is nothing to list.
 */
export default function ActivityHeatmap({ days = [], onPickDay, selectedDay, className }) {
  const { weeks, months, peak } = useMemo(() => {
    if (!days.length) return { weeks: [], months: [], peak: 0 };

    const cells = days.map((entry) => ({
      ...entry,
      // The 12:00Z read keeps a day from slipping either side of midnight in any timezone the
      // browser happens to be in.
      date: new Date(`${entry.day}T12:00:00Z`),
    }));

    // Pad to the Monday before the first day, so every column is a whole week.
    const lead = (cells[0].date.getUTCDay() + 6) % 7;
    const padded = [...Array.from({ length: lead }, () => null), ...cells];

    const grouped = [];
    for (let at = 0; at < padded.length; at += 7) grouped.push(padded.slice(at, at + 7));

    /** A month label above the first week that starts inside it. */
    const labels = grouped.map((week, index) => {
      const first = week.find(Boolean);
      if (!first) return null;
      const month = first.date.getUTCMonth();
      const previous = grouped
        .slice(0, index)
        .reverse()
        .flat()
        .find(Boolean);
      return !previous || previous.date.getUTCMonth() !== month ? MONTHS[month] : null;
    });

    return {
      weeks: grouped,
      months: labels,
      peak: Math.max(...cells.map((cell) => cell.count), 0),
    };
  }, [days]);

  if (!weeks.length) return null;

  /** Five steps, so two adjacent levels are always distinguishable. */
  const level = (count) => {
    if (!count) return 0;
    if (peak <= 1) return 4;
    const share = count / peak;
    if (share > 0.66) return 4;
    if (share > 0.33) return 3;
    if (share > 0.12) return 2;
    return 1;
  };

  const OPACITY = [0, 0.22, 0.42, 0.66, 1];

  return (
    <div className={cn('flex gap-1.5 overflow-x-auto pb-1', className)}>
      {/* Day names down the side: three of seven, which is enough to orient without crowding. */}
      <span className="flex shrink-0 flex-col gap-[3px] pt-[14px]">
        {WEEKDAYS.map((label, index) => (
          <span
            key={index}
            className="h-[11px] text-[0.5rem] leading-[11px] text-fg-subtle"
            style={{ width: 20 }}
          >
            {label}
          </span>
        ))}
      </span>

      <span className="flex gap-[3px]">
        {weeks.map((week, index) => (
          <span key={index} className="flex flex-col gap-[3px]">
            <span className="h-[11px] text-[0.5rem] leading-[11px] text-fg-subtle">
              {months[index] ?? ''}
            </span>
            {week.map((cell, day) =>
              cell ? (
                <button
                  key={cell.day}
                  type="button"
                  onClick={() => onPickDay?.(cell.day === selectedDay ? null : cell.day)}
                  title={`${formatDate(cell.day)} — ${
                    cell.count === 0
                      ? 'nothing'
                      : `${cell.count} ${cell.count === 1 ? 'entry' : 'entries'}${
                          cell.people > 1 ? `, ${cell.people} people` : ''
                        }`
                  }`}
                  aria-label={`${cell.day}: ${cell.count} entries`}
                  className={cn(
                    'size-[11px] rounded-[2px] transition',
                    cell.count ? 'hover:ring-1 hover:ring-brand-300' : 'hover:ring-1 hover:ring-line',
                    cell.day === selectedDay ? 'ring-1 ring-brand-300' : ''
                  )}
                  style={{
                    backgroundColor: cell.count ? 'var(--color-brand-400)' : 'rgba(255,255,255,0.05)',
                    opacity: cell.count ? OPACITY[level(cell.count)] : 1,
                  }}
                />
              ) : (
                <span key={`pad-${day}`} className="size-[11px]" />
              )
            )}
          </span>
        ))}
      </span>
    </div>
  );
}

/** The scale, spelled out — the squares are eleven pixels wide. */
export function HeatmapLegend({ className }) {
  return (
    <span className={cn('flex items-center gap-1.5 text-[0.5625rem] text-fg-subtle', className)}>
      quiet
      {[0, 0.22, 0.42, 0.66, 1].map((opacity) => (
        <span
          key={opacity}
          className="size-[9px] rounded-[2px]"
          style={{
            backgroundColor: opacity ? 'var(--color-brand-400)' : 'rgba(255,255,255,0.05)',
            opacity: opacity || 1,
          }}
        />
      ))}
      busy
    </span>
  );
}
