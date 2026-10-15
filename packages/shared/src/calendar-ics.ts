/** iCalendar (RFC 5545) export of calendar events: all-day VEVENTs, UTF-8, CRLF line endings, lines folded at 75 octets. */
import { addIsoDays, roundTo } from './analytics.js';
import { CALENDAR_TYPE_LABELS, type CalendarEvent } from './calendar.js';

export const ICS_LINE_LIMIT = 75;
const CRLF = '\r\n';
const PRODID = '-//portfolio-tracker//Calendar//EN';
const UID_DOMAIN = 'portfolio-tracker';
const encoder = new TextEncoder();

/** Escapes a TEXT value: backslash, semicolon, comma and line breaks (RFC 5545 §3.3.11). */
export function escapeIcsText(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll(';', '\\;').replaceAll(',', '\\,').replaceAll(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a content line so that no line is longer than 75 octets (continuation lines start with one space that counts
 * towards the limit). Never splits a multi-byte UTF-8 character.
 */
export function foldIcsLine(line: string): string {
  const lines: string[] = [];
  let current = '';
  let octets = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    const limit = lines.length === 0 ? ICS_LINE_LIMIT : ICS_LINE_LIMIT - 1;
    if (octets + size > limit) {
      lines.push(current);
      current = '';
      octets = 0;
    }
    current += char;
    octets += size;
  }
  lines.push(current);
  return lines.join(`${CRLF} `);
}

const compactDate = (iso: string): string => iso.replaceAll('-', '');

/** `20261015T093000Z` */
export function icsTimestamp(now: Date): string {
  return now.toISOString().replaceAll(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function summaryOf(e: CalendarEvent): string {
  const label = e.type === 'SPLIT' || e.type === 'CORPORATE_ACTION' ? e.description : CALENDAR_TYPE_LABELS[e.type];
  const amount = e.expectedAmount === undefined ? '' : ` · ${roundTo(e.expectedAmount).toFixed(2)} ${e.status === 'PAID' ? 'received' : 'expected'}`;
  return `${e.symbol} · ${label}${amount}`;
}

function descriptionOf(e: CalendarEvent, baseCurrency: string): string {
  const lines = [e.name, e.description];
  if (e.exDate && e.type !== 'EX_DIVIDEND') lines.push(`Ex-dividend date: ${e.exDate}`);
  if (e.payDate && e.type !== 'DIVIDEND_PAY') lines.push(`Payment date: ${e.payDate}`);
  if (e.expectedAmount !== undefined) lines.push(`${e.status === 'PAID' ? 'Received' : 'Expected'} (net): ${baseCurrency} ${roundTo(e.expectedAmount).toFixed(2)}`);
  lines.push(`Status: ${e.status.toLowerCase()}`, `Source: ${e.source}`);
  return lines.join('\n');
}

function eventLines(e: CalendarEvent, stamp: string, baseCurrency: string): string[] {
  return [
    'BEGIN:VEVENT',
    `UID:${e.id}@${UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${compactDate(e.date)}`,
    // All-day events end on the following day (DTEND is exclusive).
    `DTEND;VALUE=DATE:${compactDate(addIsoDays(e.date, 1))}`,
    `SUMMARY:${escapeIcsText(summaryOf(e))}`,
    `DESCRIPTION:${escapeIcsText(descriptionOf(e, baseCurrency))}`,
    `CATEGORIES:${escapeIcsText(CALENDAR_TYPE_LABELS[e.type])}`,
    `STATUS:${e.status === 'ESTIMATED' ? 'TENTATIVE' : 'CONFIRMED'}`,
    'TRANSP:TRANSPARENT',
    'END:VEVENT',
  ];
}

export interface IcsOptions {
  calendarName?: string;
  baseCurrency?: string;
  /** DTSTAMP of every event (defaults to the current time). */
  now?: Date;
}

/** The complete .ics document (CRLF-terminated). Event UIDs are stable so re-imports update instead of duplicating. */
export function calendarToIcs(events: readonly CalendarEvent[], { calendarName = 'Portfolio calendar', baseCurrency = 'EUR', now = new Date() }: IcsOptions = {}): string {
  const stamp = icsTimestamp(now);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(calendarName)}`,
    ...events.flatMap((e) => eventLines(e, stamp, baseCurrency)),
    'END:VCALENDAR',
  ];
  return lines.map(foldIcsLine).join(CRLF) + CRLF;
}
