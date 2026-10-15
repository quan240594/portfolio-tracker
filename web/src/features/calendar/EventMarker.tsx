import type { CalendarEventType } from '@portfolio/shared';
import { EVENT_META, type MarkerShape } from './calendarModel';

const SHAPES: Record<MarkerShape, { path: string; textY: number }> = {
  circle: { path: 'M10 1a9 9 0 1 0 0 18 9 9 0 0 0 0-18Z', textY: 14.2 },
  square: { path: 'M3 1h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2Z', textY: 14.2 },
  diamond: { path: 'M10 .5 19.5 10 10 19.5.5 10Z', textY: 14.2 },
  triangle: { path: 'M10 1.5 19 18H1Z', textY: 16 },
  hexagon: { path: 'M5.5 2h9L19 10l-4.5 8h-9L1 10Z', textY: 14.2 },
};

/** Colour + shape + letter marker of an event type (decorative: the type is always also spelled out in text). */
export function EventMarker({ type, className = 'h-4 w-4' }: Readonly<{ type: CalendarEventType; className?: string }>) {
  const meta = EVENT_META[type];
  const shape = SHAPES[meta.shape];
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true" className={`shrink-0 ${className}`} data-shape={meta.shape}>
      <path d={shape.path} className={meta.fill} />
      <text x="10" y={shape.textY} textAnchor="middle" fontSize="10.5" fontWeight="700" className="fill-white dark:fill-slate-950">
        {meta.letter}
      </text>
    </svg>
  );
}
