import { SCHEDULED_JOBS, toUnixCron } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { nextCronRun, parseCron } from './cron.js';

const utc = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);
const iso = (ms: number) => new Date(ms).toISOString();

describe('parseCron', () => {
  it('expands lists, ranges, steps and names', () => {
    const spec = parseCron('10-20/5,45 8,13 1,15 JAN,jul MON-FRI');
    expect(spec.minutes).toEqual([10, 15, 20, 45]);
    expect(spec.hours).toEqual([8, 13]);
    expect([...spec.daysOfMonth]).toEqual([1, 15]);
    expect([...spec.months]).toEqual([1, 7]);
    expect([...spec.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
    expect(spec.anyDayOfMonth).toBe(false);
    expect(spec.anyDayOfWeek).toBe(false);
  });

  it('knows */n, a number with a step and Sunday as 0 or 7', () => {
    expect(parseCron('*/20 * * * *').minutes).toEqual([0, 20, 40]);
    expect(parseCron('5/20 * * * *').minutes).toEqual([5, 25, 45]);
    expect([...parseCron('0 0 * * 0,7').daysOfWeek]).toEqual([0]);
    expect(parseCron('0 0 * * *').anyDayOfWeek).toBe(true);
  });

  it('rejects malformed expressions', () => {
    for (const bad of ['* * * *', '* * * * * *', '60 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', 'x * * * *', '5-1 * * * *', '1-2-3 * * * *', '*/0 * * * *', '1,,2 * * * *', '1/2/3 * * * *', '*/x * * * *', '* * * FOO *']) {
      expect(() => parseCron(bad), bad).toThrow();
    }
  });

  it('parses every cron the shared schedules produce', () => {
    for (const job of SCHEDULED_JOBS) expect(() => parseCron(toUnixCron(job))).not.toThrow();
  });
});

describe('nextCronRun in UTC', () => {
  it('finds the next minute, hour and day slot strictly after the start', () => {
    expect(iso(nextCronRun('*/15 * * * *', utc(2026, 1, 5, 10, 7)))).toBe('2026-01-05T10:15:00.000Z');
    expect(iso(nextCronRun('*/15 * * * *', utc(2026, 1, 5, 10, 15)))).toBe('2026-01-05T10:30:00.000Z');
    expect(iso(nextCronRun('0 6 * * *', utc(2026, 1, 5, 6, 0)))).toBe('2026-01-06T06:00:00.000Z');
    expect(iso(nextCronRun('0 6 * * *', new Date(utc(2026, 1, 5, 5, 59))))).toBe('2026-01-05T06:00:00.000Z');
  });

  it('is strictly after a start that falls inside a minute', () => {
    expect(iso(nextCronRun('0 6 * * *', utc(2026, 1, 5, 6, 0) + 1))).toBe('2026-01-06T06:00:00.000Z');
  });

  it('rolls over month and year ends', () => {
    expect(iso(nextCronRun('0 0 1 * *', utc(2026, 12, 31, 12)))).toBe('2027-01-01T00:00:00.000Z');
    expect(iso(nextCronRun('0 0 1 JAN,JUL *', utc(2026, 2, 1)))).toBe('2026-07-01T00:00:00.000Z');
  });

  it('applies the weekday filter', () => {
    // 2026-01-09 is a Friday.
    expect(iso(nextCronRun('0 8 * * MON-FRI', utc(2026, 1, 9, 9)))).toBe('2026-01-12T08:00:00.000Z');
    expect(iso(nextCronRun('0 8 * * SUN', utc(2026, 1, 9, 9)))).toBe('2026-01-11T08:00:00.000Z');
  });

  it('ORs the day fields when both are restricted, ANDs them otherwise', () => {
    // 2026-01-01 is a Thursday: the 13th OR a Friday fires on Friday the 2nd.
    expect(iso(nextCronRun('0 0 13 * FRI', utc(2026, 1, 1, 12)))).toBe('2026-01-02T00:00:00.000Z');
    expect(iso(nextCronRun('0 0 13 * *', utc(2026, 1, 1, 12)))).toBe('2026-01-13T00:00:00.000Z');
    // A field that starts with `*` counts as unrestricted (classic cron): the 1st/11th/21st/31st that is also a Monday.
    expect(iso(nextCronRun('0 0 */10 * MON', utc(2026, 1, 1, 12)))).toBe('2026-05-11T00:00:00.000Z');
  });

  it('finds a leap day years ahead and gives up on an impossible date', () => {
    expect(iso(nextCronRun('0 0 29 2 *', utc(2026, 1, 1)))).toBe('2028-02-29T00:00:00.000Z');
    expect(() => nextCronRun('0 0 31 2 *', utc(2026, 1, 1))).toThrow(/does not fire/);
  });
});

describe('nextCronRun in a time zone', () => {
  const AMS = 'Europe/Amsterdam';
  const prices = '0 8,13,18,22 * * MON-FRI';

  it('reads the hours on the local clock in winter (UTC+1)', () => {
    expect(iso(nextCronRun(prices, utc(2026, 1, 5, 9), AMS))).toBe('2026-01-05T12:00:00.000Z'); // 13:00 local
    expect(iso(nextCronRun(prices, utc(2026, 1, 9, 21), AMS))).toBe('2026-01-12T07:00:00.000Z'); // Friday 22:00 local was the last one
  });

  it('reads the hours on the local clock in summer (UTC+2)', () => {
    expect(iso(nextCronRun(prices, utc(2026, 7, 6, 0), AMS))).toBe('2026-07-06T06:00:00.000Z');
  });

  it('uses the local date, not the UTC date, near midnight', () => {
    // 2026-01-05 23:30 UTC is already Tuesday 00:30 in Amsterdam.
    expect(iso(nextCronRun('0 5 * * TUE', utc(2026, 1, 5, 23, 30), AMS))).toBe('2026-01-06T04:00:00.000Z');
  });

  it('skips a local time that does not exist (spring forward) and takes the first of an ambiguous one (fall back)', () => {
    expect(iso(nextCronRun('30 2 * * *', utc(2026, 3, 28, 12), AMS))).toBe('2026-03-30T00:30:00.000Z');
    expect(iso(nextCronRun('30 2 * * *', utc(2026, 10, 24, 12), AMS))).toBe('2026-10-25T00:30:00.000Z');
  });

  it('keeps the local hour across a daylight saving change', () => {
    expect(iso(nextCronRun('0 8 * * *', utc(2026, 3, 28, 12), AMS))).toBe('2026-03-29T06:00:00.000Z'); // 08:00 CEST
    expect(iso(nextCronRun('0 8 * * *', utc(2026, 3, 27, 12), AMS))).toBe('2026-03-28T07:00:00.000Z'); // 08:00 CET
  });

  it('handles a zone east of UTC+12 and a half hour zone', () => {
    expect(iso(nextCronRun('0 9 * * *', utc(2026, 1, 5, 0), 'Pacific/Auckland'))).toBe('2026-01-05T20:00:00.000Z'); // UTC+13 in January
    expect(iso(nextCronRun('0 9 * * *', utc(2026, 1, 5, 0), 'Asia/Kolkata'))).toBe('2026-01-05T03:30:00.000Z');
  });

  it('runs the shared schedules on Amsterdam time', () => {
    const [prices, calendar, broker] = SCHEDULED_JOBS;
    // Monday 2026-01-05 09:00Z = 10:00 local.
    const from = utc(2026, 1, 5, 9);
    expect(iso(nextCronRun(toUnixCron(prices), from, prices.timezone))).toBe('2026-01-05T12:00:00.000Z');
    expect(iso(nextCronRun(toUnixCron(calendar), from, calendar.timezone))).toBe('2026-01-06T04:30:00.000Z');
    expect(iso(nextCronRun(toUnixCron(broker), from, broker.timezone))).toBe('2026-01-06T05:30:00.000Z');
  });
});

describe('the Trading 212 quote schedules on Amsterdam time', () => {
  const quotes = SCHEDULED_JOBS.find((job) => job.name === 't212-quotes')!;
  const close = SCHEDULED_JOBS.find((job) => job.name === 't212-quotes-close')!;
  const nextQuote = (from: number) => iso(nextCronRun(toUnixCron(quotes), from, quotes.timezone));
  const nextClose = (from: number) => iso(nextCronRun(toUnixCron(close), from, close.timezone));

  it('fires every 15 minutes from 07:00 to 21:45 local time on weekdays (winter: UTC+1)', () => {
    // Monday 2026-01-05 05:50Z = 06:50 local.
    expect(nextQuote(utc(2026, 1, 5, 5, 50))).toBe('2026-01-05T06:00:00.000Z');
    expect(nextQuote(utc(2026, 1, 5, 6, 0))).toBe('2026-01-05T06:15:00.000Z');
    expect(nextQuote(utc(2026, 1, 5, 20, 44))).toBe('2026-01-05T20:45:00.000Z');
    // 21:45 local is the last slot; the next one is Tuesday 07:00 local.
    expect(nextQuote(utc(2026, 1, 5, 20, 45))).toBe('2026-01-06T06:00:00.000Z');
  });

  it('follows daylight saving time (summer: UTC+2)', () => {
    expect(nextQuote(utc(2026, 7, 6, 4, 0))).toBe('2026-07-06T05:00:00.000Z');
    expect(nextQuote(utc(2026, 7, 6, 19, 45))).toBe('2026-07-07T05:00:00.000Z');
    expect(nextClose(utc(2026, 7, 6, 12, 0))).toBe('2026-07-06T20:05:00.000Z');
    expect(nextClose(utc(2026, 1, 5, 12, 0))).toBe('2026-01-05T21:05:00.000Z');
  });

  it('skips weekends and the changeover week is still every 15 minutes', () => {
    // Friday 2026-01-09 21:00Z is after the last slot: the next one is Monday 07:00 local = 06:00Z.
    expect(nextQuote(utc(2026, 1, 9, 21, 0))).toBe('2026-01-12T06:00:00.000Z');
    expect(nextClose(utc(2026, 1, 9, 21, 5))).toBe('2026-01-12T21:05:00.000Z');
    // Sunday 2026-03-29 is the spring-forward day; Monday 07:00 local is then UTC+2.
    expect(nextQuote(utc(2026, 3, 27, 21, 0))).toBe('2026-03-30T05:00:00.000Z');
  });

  it('runs 60 slots a day plus the close', () => {
    let from = utc(2026, 1, 5, 0, 0);
    let slots = 0;
    for (;;) {
      from = nextCronRun(toUnixCron(quotes), from, quotes.timezone);
      if (from >= utc(2026, 1, 6, 0, 0)) break;
      slots++;
    }
    expect(slots).toBe(60);
  });
});

describe('the earnings watch schedule in Amsterdam time', () => {
  const watch = toUnixCron(SCHEDULED_JOBS.find((job) => job.name === 'earnings-watch')!);
  const morning = toUnixCron(SCHEDULED_JOBS.find((job) => job.name === 'earnings-watch-morning')!);
  const next = (cron: string, from: number) => iso(nextCronRun(cron, from, 'Europe/Amsterdam'));

  it('runs every 30 minutes from 13:00 to 23:30 on weekdays (summer time)', () => {
    expect(next(watch, utc(2026, 10, 21, 10, 0))).toBe('2026-10-21T11:00:00.000Z');
    expect(next(watch, utc(2026, 10, 21, 11, 0))).toBe('2026-10-21T11:30:00.000Z');
    expect(next(watch, utc(2026, 10, 21, 21, 0))).toBe('2026-10-21T21:30:00.000Z');
    // 23:30 CEST is the last run of the day; the next one is the following weekday at 13:00 CEST.
    expect(next(watch, utc(2026, 10, 21, 21, 30))).toBe('2026-10-22T11:00:00.000Z');
  });

  it('skips the weekend and follows the clock change of Sunday 25 October 2026 (CEST to CET)', () => {
    expect(next(watch, utc(2026, 10, 23, 21, 30))).toBe('2026-10-26T12:00:00.000Z');
    expect(next(watch, utc(2026, 10, 26, 12, 0))).toBe('2026-10-26T12:30:00.000Z');
    expect(next(watch, utc(2026, 10, 26, 22, 30))).toBe('2026-10-27T12:00:00.000Z');
  });

  it('keeps the morning run at 07:30 local time every day, before and after the clock change', () => {
    expect(next(morning, utc(2026, 10, 24, 5, 0))).toBe('2026-10-24T05:30:00.000Z');
    expect(next(morning, utc(2026, 10, 24, 5, 30))).toBe('2026-10-25T06:30:00.000Z');
    expect(next(morning, utc(2026, 10, 25, 6, 30))).toBe('2026-10-26T06:30:00.000Z');
  });

  it('follows the spring change (CET to CEST) of Sunday 29 March 2026 too', () => {
    expect(next(watch, utc(2026, 3, 27, 22, 30))).toBe('2026-03-30T11:00:00.000Z');
    expect(next(morning, utc(2026, 3, 28, 6, 30))).toBe('2026-03-29T05:30:00.000Z');
  });
});
