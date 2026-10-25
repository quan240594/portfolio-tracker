import type { CalendarEventType, CalendarStatus } from '@portfolio/shared';
import type { Theme } from '../../theme/ThemeProvider';

/**
 * Colour language of the calendar, two independent signals:
 * - STATUS (every row, chip, filter, chart): received = pastel green, estimated = pastel yellow (also dashed), confirmed/declared = pastel blue.
 *   On a row it is the left border and the status chip.
 * - TYPE: only the EX-DIVIDEND has its own hue (violet) as row/chip surface, outline and marker, so it never looks like a payment of the
 *   same status. Payment, earnings, split and corporate action keep the status surface and a neutral slate marker: a fifth and sixth hue
 *   would collide with the three status hues. Shape + letter (E, P, R, S, C) and the type text stay on every row.
 *
 * Contrast (WCAG 2.1, computed from the hex values, asserted in calendarColours.test.ts):
 * status text on its chip fill
 * light  received #14532d on #dcfce7 8.3:1 · estimated #422006 on #fef9c3 13.6:1 · confirmed #1e3a8a on #dbeafe 8.5:1
 * dark   received #dcfce7 on #1b4d33 8.9:1 · estimated #fffbe0 on #6b5a12 6.5:1 · confirmed #dbeafe on #1e3a6e 9.1:1
 * ex-dividend (violet): light text #3b0764 on #e9d5ff 11.0:1, outline #7c3aed on white 5.7:1, marker #6d28d9 on white 7.1:1;
 * dark text #f3e8ff on #4a2a7a 9.4:1, outline and marker #c4b5fd on the card #0f172a 9.7:1.
 * The outlines (≥ 4:1 on white, ≥ 8:1 on the dark card) keep the fills visible against either page background.
 */
export const STATUS_CHIP: Readonly<Record<CalendarStatus, string>> = {
  PAID: 'border-[#2f8f57] bg-[#dcfce7] text-[#14532d] dark:border-[#6ee7a0] dark:bg-[#1b4d33] dark:text-[#dcfce7]',
  ESTIMATED: 'border-[#a16207] bg-[#fef9c3] text-[#422006] dark:border-[#facc15] dark:bg-[#6b5a12] dark:text-[#fffbe0]',
  CONFIRMED: 'border-[#3b6fd4] bg-[#dbeafe] text-[#1e3a8a] dark:border-[#8db4ff] dark:bg-[#1e3a6e] dark:text-[#dbeafe]',
};

/** The border colour of each status alone, for surfaces that bring their own fill (the ex-dividend). */
export const STATUS_BORDER: Readonly<Record<CalendarStatus, string>> = {
  PAID: 'border-[#2f8f57] dark:border-[#6ee7a0]',
  ESTIMATED: 'border-[#a16207] dark:border-[#facc15]',
  CONFIRMED: 'border-[#3b6fd4] dark:border-[#8db4ff]',
};

/** Estimated: dashed outline (and italic text in chips) on top of the yellow, so it is not colour-only. */
export const DASHED_OUTLINE = 'border border-l-4 border-dashed [border-left-style:solid]';

/** The violet of the ex-dividend per theme; the class strings below spell the same hex values (a test keeps them in step). */
export const EX_DIVIDEND_TOKENS = {
  light: { surface: '#e9d5ff', text: '#3b0764', outline: '#7c3aed', marker: '#6d28d9', markerLetter: '#ffffff', page: '#ffffff' },
  dark: { surface: '#4a2a7a', text: '#f3e8ff', outline: '#c4b5fd', marker: '#c4b5fd', markerLetter: '#020617', page: '#0f172a' },
} as const;

const EX_DIVIDEND_SURFACE = 'bg-[#e9d5ff] text-[#3b0764] dark:bg-[#4a2a7a] dark:text-[#f3e8ff]';
const EX_DIVIDEND_OUTLINE = 'ring-1 ring-inset ring-[#7c3aed] dark:ring-[#c4b5fd]';
/** Fill of the ex-dividend marker (the letter inside is white / slate-950, see EventMarker). */
export const EX_DIVIDEND_MARKER_FILL = 'fill-[#6d28d9] dark:fill-[#c4b5fd]';

export const chipClasses = (status: CalendarStatus): string => (status === 'ESTIMATED' ? `${STATUS_CHIP[status]} ${DASHED_OUTLINE}` : STATUS_CHIP[status]);

/** Surface of a row or chip: the ex-dividend is violet whatever its status (the status stays the left border, which the row or chip itself sets as border-l-4); every other type shows its status colours. */
export function eventClasses(type: CalendarEventType, status: CalendarStatus): string {
  if (type !== 'EX_DIVIDEND') return chipClasses(status);
  const base = `${STATUS_BORDER[status]} ${EX_DIVIDEND_SURFACE}`;
  return status === 'ESTIMATED' ? `${base} ${DASHED_OUTLINE}` : `${base} ${EX_DIVIDEND_OUTLINE}`;
}

/** Swatch of the colour key: the surface a type or status gets in a row. */
export const KEY_SWATCH = {
  exDividend: `${EX_DIVIDEND_SURFACE} border border-[#7c3aed] dark:border-[#c4b5fd]`,
  PAID: `${STATUS_CHIP.PAID} border`,
  CONFIRMED: `${STATUS_CHIP.CONFIRMED} border`,
  ESTIMATED: `${STATUS_CHIP.ESTIMATED} border border-dashed [border-left-style:solid]`,
} as const;

export interface BarColours {
  fill: string;
  stroke: string;
}

export interface IncomeColours {
  paid: BarColours;
  declared: BarColours;
  estimated: BarColours;
}

/** Bar fills of the income chart (pastel on white, muted on the dark card) with a darker outline each. */
export function incomeColours(theme: Theme): IncomeColours {
  if (theme === 'dark') {
    return {
      paid: { fill: '#2f7a50', stroke: '#6ee7a0' },
      declared: { fill: '#33559e', stroke: '#8db4ff' },
      estimated: { fill: '#8a6d1a', stroke: '#facc15' },
    };
  }
  return {
    paid: { fill: '#86d9a0', stroke: '#2f8f57' },
    declared: { fill: '#bfdbfe', stroke: '#3b6fd4' },
    estimated: { fill: '#fde68a', stroke: '#a16207' },
  };
}
