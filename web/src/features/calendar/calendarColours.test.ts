import { CALENDAR_EVENT_TYPES, CALENDAR_STATUSES, type CalendarEventType, type CalendarStatus } from '@portfolio/shared';
import { EX_DIVIDEND_MARKER_FILL, EX_DIVIDEND_TOKENS, KEY_SWATCH, STATUS_BORDER, STATUS_CHIP, chipClasses, eventClasses } from './calendarColours';
import { EVENT_META } from './calendarModel';

const channel = (hex: string, at: number): number => {
  const v = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string): number => 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);

/** WCAG 2.1 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The hex colours a class string spells for one theme (`dark:` ones or the plain ones), by utility prefix. */
function hexOf(classes: string, prefix: string, dark: boolean): string | undefined {
  const wanted = `${dark ? 'dark:' : ''}${prefix}-[`;
  const token = classes.split(' ').find((c) => c.startsWith(wanted));
  return token?.slice(wanted.length, -1);
}

const STATUS_PAGE = { light: '#ffffff', dark: '#0f172a' } as const;

describe('contrast helper', () => {
  it('matches the known WCAG extremes', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrast('#777777', '#ffffff')).toBeCloseTo(4.48, 2);
  });
});

describe('colour of an event by type and status', () => {
  const combos = CALENDAR_EVENT_TYPES.flatMap((type) => CALENDAR_STATUSES.map((status) => [type, status] as const));

  it.each(combos)('%s %s keeps its status border and is dashed only when estimated', (type, status) => {
    const classes = eventClasses(type, status);
    expect(hexOf(classes, 'border', false)).toBe(hexOf(STATUS_BORDER[status], 'border', false));
    expect(hexOf(classes, 'border', true)).toBe(hexOf(STATUS_BORDER[status], 'border', true));
    expect(classes.includes('border-dashed')).toBe(status === 'ESTIMATED');
  });

  it.each(CALENDAR_STATUSES)('payments, earnings, splits and corporate actions keep the %s status surface exactly', (status) => {
    for (const type of ['DIVIDEND_PAY', 'EARNINGS', 'SPLIT', 'CORPORATE_ACTION'] as const) {
      expect(eventClasses(type, status)).toBe(chipClasses(status));
    }
  });

  it.each(CALENDAR_STATUSES)('the ex-dividend is violet and differs from the payment of the same %s status', (status) => {
    const exDividend = eventClasses('EX_DIVIDEND', status);
    const payment = eventClasses('DIVIDEND_PAY', status);
    expect(exDividend).not.toBe(payment);
    expect(hexOf(exDividend, 'bg', false)).toBe(EX_DIVIDEND_TOKENS.light.surface);
    expect(hexOf(exDividend, 'bg', true)).toBe(EX_DIVIDEND_TOKENS.dark.surface);
    expect(hexOf(exDividend, 'text', false)).toBe(EX_DIVIDEND_TOKENS.light.text);
    expect(hexOf(exDividend, 'text', true)).toBe(EX_DIVIDEND_TOKENS.dark.text);
    expect(hexOf(payment, 'bg', false)).toBe(hexOf(STATUS_CHIP[status], 'bg', false));
  });

  it('draws the violet outline on solid ex-dividend rows only (estimated ones are dashed instead)', () => {
    expect(eventClasses('EX_DIVIDEND', 'CONFIRMED')).toContain('ring-[#7c3aed]');
    expect(eventClasses('EX_DIVIDEND', 'PAID')).toContain('dark:ring-[#c4b5fd]');
    expect(eventClasses('EX_DIVIDEND', 'ESTIMATED')).not.toContain('ring-');
  });

  it('spells the violet tokens in the marker fill', () => {
    expect(hexOf(EX_DIVIDEND_MARKER_FILL, 'fill', false)).toBe(EX_DIVIDEND_TOKENS.light.marker);
    expect(hexOf(EX_DIVIDEND_MARKER_FILL, 'fill', true)).toBe(EX_DIVIDEND_TOKENS.dark.marker);
    expect(EVENT_META.EX_DIVIDEND.fill).toBe(EX_DIVIDEND_MARKER_FILL);
    const neutral = new Set((Object.keys(EVENT_META) as CalendarEventType[]).filter((t) => t !== 'EX_DIVIDEND').map((t) => EVENT_META[t].fill));
    expect(neutral.size).toBe(1);
    expect(neutral.has(EX_DIVIDEND_MARKER_FILL)).toBe(false);
  });

  it('keeps the status border in step with the status chip', () => {
    for (const status of CALENDAR_STATUSES) {
      expect(hexOf(STATUS_BORDER[status], 'border', false)).toBe(hexOf(STATUS_CHIP[status], 'border', false));
      expect(hexOf(STATUS_BORDER[status], 'border', true)).toBe(hexOf(STATUS_CHIP[status], 'border', true));
    }
  });

  it('gives the colour key a swatch per hue, the estimated one dashed', () => {
    expect(KEY_SWATCH.exDividend).toContain(EX_DIVIDEND_TOKENS.light.surface);
    expect(KEY_SWATCH.ESTIMATED).toContain('border-dashed');
    expect(KEY_SWATCH.PAID).not.toContain('border-dashed');
  });
});

describe('contrast (WCAG 2.1 AA)', () => {
  const themes = ['light', 'dark'] as const;

  it.each(themes)('ex-dividend text on its surface is at least 4.5:1 (%s)', (theme) => {
    const t = EX_DIVIDEND_TOKENS[theme];
    expect(contrast(t.text, t.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('ex-dividend outline and marker are at least 3:1 against the page and the surface (%s)', (theme) => {
    const t = EX_DIVIDEND_TOKENS[theme];
    expect(contrast(t.outline, t.page)).toBeGreaterThanOrEqual(3);
    expect(contrast(t.marker, t.page)).toBeGreaterThanOrEqual(3);
    expect(contrast(t.marker, t.surface)).toBeGreaterThanOrEqual(3);
  });

  it.each(themes)('the letter inside the ex-dividend marker is at least 4.5:1 (%s)', (theme) => {
    const t = EX_DIVIDEND_TOKENS[theme];
    expect(contrast(t.markerLetter, t.marker)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('the faded secondary text of a row (80% opacity) is still at least 4.5:1 on the ex-dividend surface (%s)', (theme) => {
    const t = EX_DIVIDEND_TOKENS[theme];
    const mix = (a: string, b: string): string =>
      `#${[1, 3, 5].map((i) => Math.round(Number.parseInt(a.slice(i, i + 2), 16) * 0.8 + Number.parseInt(b.slice(i, i + 2), 16) * 0.2).toString(16).padStart(2, '0')).join('')}`;
    expect(contrast(mix(t.text, t.surface), t.surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(themes)('status chip text on its fill is at least 4.5:1 and its border at least 3:1 on the page (%s)', (theme) => {
    for (const status of CALENDAR_STATUSES as readonly CalendarStatus[]) {
      const dark = theme === 'dark';
      const chip = STATUS_CHIP[status];
      expect(contrast(hexOf(chip, 'text', dark) as string, hexOf(chip, 'bg', dark) as string)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hexOf(chip, 'border', dark) as string, STATUS_PAGE[theme])).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(themes)('the ex-dividend surface is not one of the status fills (%s)', (theme) => {
    const dark = theme === 'dark';
    const surface = EX_DIVIDEND_TOKENS[theme].surface;
    for (const status of CALENDAR_STATUSES) {
      expect(hexOf(STATUS_CHIP[status], 'bg', dark)).not.toBe(surface);
    }
  });
});
