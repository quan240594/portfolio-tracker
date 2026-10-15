import type { CalendarStatus } from '@portfolio/shared';
import type { Theme } from '../../theme/ThemeProvider';

/**
 * Colour language of the calendar: the STATUS of a payment is the colour, the event TYPE is the marker shape + letter.
 * Received (paid) = pastel green, Estimated = pastel yellow (also dashed), Confirmed/declared = pastel blue.
 *
 * Contrast of the text on its chip fill (WCAG 2.1, computed from the hex values):
 * light  received #14532d on #dcfce7 8.3:1 · estimated #422006 on #fef9c3 13.6:1 · confirmed #1e3a8a on #dbeafe 8.5:1
 * dark   received #dcfce7 on #1b4d33 8.9:1 · estimated #fffbe0 on #6b5a12 6.5:1 · confirmed #dbeafe on #1e3a6e 9.1:1
 * The outlines (≥ 4:1 on white, ≥ 8:1 on the dark card) keep the fills visible against either page background.
 */
export const STATUS_CHIP: Readonly<Record<CalendarStatus, string>> = {
  PAID: 'border-[#2f8f57] bg-[#dcfce7] text-[#14532d] dark:border-[#6ee7a0] dark:bg-[#1b4d33] dark:text-[#dcfce7]',
  ESTIMATED: 'border-[#a16207] bg-[#fef9c3] text-[#422006] dark:border-[#facc15] dark:bg-[#6b5a12] dark:text-[#fffbe0]',
  CONFIRMED: 'border-[#3b6fd4] bg-[#dbeafe] text-[#1e3a8a] dark:border-[#8db4ff] dark:bg-[#1e3a6e] dark:text-[#dbeafe]',
};

/** Estimated: dashed outline (and italic text in chips) on top of the yellow, so it is not colour-only. */
export const DASHED_OUTLINE = 'border border-l-4 border-dashed [border-left-style:solid]';

export const chipClasses = (status: CalendarStatus): string => (status === 'ESTIMATED' ? `${STATUS_CHIP[status]} ${DASHED_OUTLINE}` : STATUS_CHIP[status]);

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
