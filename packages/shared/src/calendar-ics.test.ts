import { describe, expect, it } from 'vitest';
import { calendarToIcs, escapeIcsText, foldIcsLine, icsTimestamp } from './calendar-ics.js';
import type { CalendarEvent } from './calendar.js';

const NOW = new Date('2026-10-15T09:30:05.123Z');
const encoder = new TextEncoder();
const octets = (s: string) => encoder.encode(s).length;

const event = (e: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'ex:AAPL:2026-08-01',
  date: '2026-08-01',
  type: 'EX_DIVIDEND',
  symbol: 'AAPL',
  name: 'Apple Inc.',
  status: 'CONFIRMED',
  origin: 'HOLDING',
  source: 'market-data',
  description: '0.55 USD per share × 10 shares',
  exDate: '2026-08-01',
  payDate: '2026-08-14',
  expectedAmount: 3.74,
  ...e,
});

/** Unfolds the content lines of an .ics document (RFC 5545 §3.1). */
const unfold = (ics: string) => ics.replaceAll('\r\n ', '').split('\r\n');

describe('escapeIcsText', () => {
  it('escapes backslashes, semicolons, commas and line breaks', () => {
    expect(escapeIcsText(String.raw`a\b;c,d`)).toBe(String.raw`a\\b\;c\,d`);
    expect(escapeIcsText('one\ntwo\r\nthree\rfour')).toBe(String.raw`one\ntwo\nthree\nfour`);
    expect(escapeIcsText('plain')).toBe('plain');
  });
});

describe('foldIcsLine', () => {
  it('leaves short lines alone', () => {
    expect(foldIcsLine('SUMMARY:short')).toBe('SUMMARY:short');
    expect(foldIcsLine('x'.repeat(75))).toBe('x'.repeat(75));
  });

  it('folds at 75 octets with a leading space on continuation lines (also 74 content octets)', () => {
    const folded = foldIcsLine(`DESCRIPTION:${'x'.repeat(200)}`);
    const lines = folded.split('\r\n');
    expect(lines[0]).toHaveLength(75);
    expect(lines.slice(1).every((l) => l.startsWith(' ') && octets(l) <= 75)).toBe(true);
    expect(lines.slice(0, -1).every((l) => octets(l) === 75)).toBe(true);
    expect(folded.replaceAll('\r\n ', '')).toBe(`DESCRIPTION:${'x'.repeat(200)}`);
  });

  it('never splits a multi-byte UTF-8 character', () => {
    const text = `SUMMARY:${'€'.repeat(40)}${'😀'.repeat(20)}é`;
    const folded = foldIcsLine(text);
    const lines = folded.split('\r\n');
    expect(lines.every((l) => octets(l) <= 75)).toBe(true);
    expect(folded.replaceAll('\r\n ', '')).toBe(text);
    expect(folded).not.toContain('\uFFFD');
  });
});

describe('icsTimestamp', () => {
  it('formats UTC date-time values', () => {
    expect(icsTimestamp(NOW)).toBe('20261015T093005Z');
  });
});

describe('calendarToIcs', () => {
  const ics = calendarToIcs([event()], { now: NOW, calendarName: 'My, calendar; 1' });
  const lines = unfold(ics);

  it('is a CRLF-terminated VCALENDAR with one all-day VEVENT', () => {
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    expect(lines.slice(0, 6)).toEqual([
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//portfolio-tracker//Calendar//EN',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      String.raw`X-WR-CALNAME:My\, calendar\; 1`,
    ]);
    expect(lines.at(-2)).toBe('END:VCALENDAR');
    expect(lines.filter((l) => l === 'BEGIN:VEVENT')).toHaveLength(1);
  });

  it('writes stable UIDs, all-day dates and an exclusive DTEND', () => {
    expect(lines).toContain('UID:ex:AAPL:2026-08-01@portfolio-tracker');
    expect(lines).toContain('DTSTAMP:20261015T093005Z');
    expect(lines).toContain('DTSTART;VALUE=DATE:20260801');
    expect(lines).toContain('DTEND;VALUE=DATE:20260802');
    expect(lines).toContain('STATUS:CONFIRMED');
    expect(lines).toContain('TRANSP:TRANSPARENT');
    expect(lines).toContain('CATEGORIES:Ex-dividend');
    expect(calendarToIcs([event()], { now: new Date('2030-01-01T00:00:00Z') })).toContain('UID:ex:AAPL:2026-08-01@portfolio-tracker');
  });

  it('rolls DTEND over month and year ends', () => {
    const year = unfold(calendarToIcs([event({ date: '2026-12-31' })], { now: NOW }));
    expect(year).toContain('DTSTART;VALUE=DATE:20261231');
    expect(year).toContain('DTEND;VALUE=DATE:20270101');
    expect(unfold(calendarToIcs([event({ date: '2028-02-28' })], { now: NOW }))).toContain('DTEND;VALUE=DATE:20280229');
  });

  it('describes the event with amounts, dates and status', () => {
    expect(lines).toContain('SUMMARY:AAPL · Ex-dividend · 3.74 expected');
    const description = lines.find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(description).toBe(String.raw`DESCRIPTION:Apple Inc.\n0.55 USD per share × 10 shares\nPayment date: 2026-08-14\nExpected (net): EUR 3.74\nStatus: confirmed\nSource: market-data`);
  });

  it('marks estimates as tentative and shows received amounts', () => {
    const estimated = unfold(calendarToIcs([event({ status: 'ESTIMATED', type: 'DIVIDEND_PAY', id: 'est-pay:AAPL:2026-11-13', date: '2026-11-13' })], { now: NOW }));
    expect(estimated).toContain('STATUS:TENTATIVE');
    const paid = unfold(calendarToIcs([event({ status: 'PAID', type: 'DIVIDEND_PAY' })], { now: NOW, baseCurrency: 'USD' }));
    expect(paid).toContain('SUMMARY:AAPL · Dividend payment · 3.74 received');
    expect(paid.find((l) => l.startsWith('DESCRIPTION:'))).toContain('Received (net): USD 3.74');
    expect(paid.find((l) => l.startsWith('DESCRIPTION:'))).toContain(String.raw`Ex-dividend date: 2026-08-01`);
    expect(paid.find((l) => l.startsWith('DESCRIPTION:'))).not.toContain('Payment date');
  });

  it('uses the description as the title of splits and omits amounts that are unknown', () => {
    const split = unfold(calendarToIcs([event({ type: 'SPLIT', id: 'split:AAPL:2026-07-10', date: '2026-07-10', description: '4-for-1 stock split', expectedAmount: undefined, exDate: undefined, payDate: undefined })], { now: NOW }));
    expect(split).toContain('SUMMARY:AAPL · 4-for-1 stock split');
    expect(split).toContain('CATEGORIES:Stock split');
    expect(split.find((l) => l.startsWith('DESCRIPTION:'))).not.toMatch(/Expected|Received/);
  });

  it('escapes special characters and keeps UTF-8 intact in long, folded lines', () => {
    const name = 'Société Générale, S.A.; "SG" ✓ ' + 'é'.repeat(60);
    const doc = calendarToIcs([event({ name, description: 'Line one\nLine two' })], { now: NOW });
    expect(doc.split('\r\n').every((l) => octets(l) <= 75)).toBe(true);
    const description = unfold(doc).find((l) => l.startsWith('DESCRIPTION:'))!;
    expect(description).toContain(String.raw`Société Générale\, S.A.\; "SG" ✓ `);
    expect(description).toContain(String.raw`Line one\nLine two`);
    expect(doc).toContain('\r\n ');
  });

  it('produces an empty but valid calendar without events and defaults its name', () => {
    const empty = calendarToIcs([], { now: NOW });
    expect(unfold(empty)).toEqual(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//portfolio-tracker//Calendar//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Portfolio calendar', 'END:VCALENDAR', '']);
    expect(calendarToIcs([event()])).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
  });
});
