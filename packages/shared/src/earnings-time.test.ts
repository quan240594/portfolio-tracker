import { describe, expect, it } from 'vitest';
import { earningsReleaseTime, exchangeZoneOf, zoneLabel, zonedInstant } from './earnings-time.js';

describe('exchangeZoneOf', () => {
  it('maps a suffix to the exchange zone and everything else to the US', () => {
    expect(exchangeZoneOf('ASML.AS')).toBe('Europe/Amsterdam');
    expect(exchangeZoneOf('SAP.DE')).toBe('Europe/Berlin');
    expect(exchangeZoneOf('shel.l')).toBe('Europe/London');
    expect(exchangeZoneOf('7203.T')).toBe('Asia/Tokyo');
    expect(exchangeZoneOf('AMZN')).toBe('America/New_York');
    expect(exchangeZoneOf('BRK.B')).toBe('America/New_York');
    expect(exchangeZoneOf('FOO.ZZ')).toBe('America/New_York');
  });

  it('names a zone for running text', () => {
    expect(zoneLabel('America/New_York')).toBe('ET');
    expect(zoneLabel('Europe/Amsterdam')).toBe('Amsterdam');
    expect(zoneLabel('Europe/Berlin')).toBe('Berlin');
    expect(zoneLabel('America/Los_Angeles')).toBe('Los Angeles');
  });
});

describe('zonedInstant', () => {
  it('resolves a wall clock on either side of a daylight-saving switch', () => {
    expect(zonedInstant('2026-10-30', 16 * 60 + 5, 'America/New_York').toISOString()).toBe('2026-10-30T20:05:00.000Z');
    expect(zonedInstant('2026-11-02', 16 * 60 + 5, 'America/New_York').toISOString()).toBe('2026-11-02T21:05:00.000Z');
    expect(zonedInstant('2026-03-29', 3 * 60, 'Europe/Amsterdam').toISOString()).toBe('2026-03-29T01:00:00.000Z');
  });
});

describe('earningsReleaseTime: the gap between a US listing and Amsterdam', () => {
  const after = (date: string) => earningsReleaseTime({ symbol: 'AMZN', date, timeOfDay: 'AMC', timeSource: 'finnhub' });

  it('is 6 hours in summer (both on daylight saving) and in winter (both on standard time)', () => {
    expect(after('2026-10-20').text).toBe('After the close, typically ~16:05 ET = ~22:05 Amsterdam');
    expect(after('2026-11-02').text).toBe('After the close, typically ~16:05 ET = ~22:05 Amsterdam');
  });

  it('is 5 hours between the end of European summer time (25-10) and the end of US daylight saving (01-11)', () => {
    expect(after('2026-10-24').owner?.time).toBe('22:05');
    expect(after('2026-10-25').owner?.time).toBe('21:05');
    expect(after('2026-10-30').text).toBe('After the close, typically ~16:05 ET = ~21:05 Amsterdam');
    expect(after('2026-10-31').owner?.time).toBe('21:05');
    expect(after('2026-11-01').owner?.time).toBe('22:05');
  });

  it('is 5 hours again between the US switch (08-03-2026) and the European one (29-03-2026)', () => {
    expect(after('2026-03-10').owner?.time).toBe('21:05');
    expect(after('2026-03-30').owner?.time).toBe('22:05');
  });

  it('carries the source and the zones of the answer', () => {
    expect(after('2026-10-30')).toMatchObject({ kind: 'typical', category: 'AMC', source: 'finnhub', market: { zone: 'America/New_York', label: 'ET', time: '16:05' }, owner: { zone: 'Europe/Amsterdam', label: 'Amsterdam', time: '21:05', dayOffset: 0 } });
  });
});

describe('earningsReleaseTime: categories', () => {
  it('before the open: 07:00 market time with the usual US range', () => {
    expect(earningsReleaseTime({ symbol: 'KO', date: '2026-10-21', timeOfDay: 'BMO' }).text).toBe('Before the open, typically ~07:00 ET = ~13:00 Amsterdam (usually 06:00-08:30 ET)');
  });

  it('a European listing: its own zone, and one zone only for an Amsterdam listing', () => {
    expect(earningsReleaseTime({ symbol: 'SAP.DE', date: '2026-10-21', timeOfDay: 'BMO' }).text).toBe('Before the open, typically ~07:00 Berlin = ~07:00 Amsterdam');
    expect(earningsReleaseTime({ symbol: 'ASML.AS', date: '2026-10-21', timeOfDay: 'AMC' }).text).toBe('After the close, typically ~17:35 Amsterdam');
    expect(earningsReleaseTime({ symbol: 'SHEL.L', date: '2026-10-29', timeOfDay: 'AMC' }).short).toBe('~16:35 London = ~17:35 Amsterdam');
  });

  it('closes of other exchanges and a date that moves to the next or the previous day in Amsterdam', () => {
    expect(earningsReleaseTime({ symbol: '7203.T', date: '2026-10-21', timeOfDay: 'AMC' }).short).toBe('~15:35 Tokyo = ~08:35 Amsterdam');
    expect(earningsReleaseTime({ symbol: 'FOO.TO', date: '2026-10-21', timeOfDay: 'AMC' }).owner?.dayOffset).toBe(0);
    const late = earningsReleaseTime({ symbol: 'AMZN', date: '2026-10-21', timeOfDay: 'AMC' }, 'Pacific/Auckland');
    expect(late.owner?.dayOffset).toBe(1);
    expect(late.text).toContain('(next day)');
    expect(earningsReleaseTime({ symbol: '7203.T', date: '2026-10-21', timeOfDay: 'BMO' }, 'America/Los_Angeles').text).toContain('(previous day)');
  });

  it('during market hours and unknown have no clock time', () => {
    expect(earningsReleaseTime({ symbol: 'AMZN', date: '2026-10-21', timeOfDay: 'DMH', timeSource: 'finnhub' })).toEqual({ kind: 'unknown', category: 'DMH', source: 'finnhub', text: 'During market hours', short: 'During market hours' });
    expect(earningsReleaseTime({ symbol: 'AMZN', date: '2026-10-21' })).toEqual({ kind: 'unknown', category: 'unknown', text: 'Time not announced', short: 'Time not announced' });
  });

  it('an exact instant wins over the category and is not marked as approximate', () => {
    const exact = earningsReleaseTime({ symbol: 'AMZN', date: '2026-10-30', timeOfDay: 'AMC', releaseAt: '2026-10-30T20:30:00Z', timeSource: 'company' });
    expect(exact).toMatchObject({ kind: 'exact', source: 'company', at: '2026-10-30T20:30:00.000Z', text: 'Released at 16:30 ET = 21:30 Amsterdam' });
  });

  it('ignores an exact instant that is not a date', () => {
    expect(earningsReleaseTime({ symbol: 'AMZN', date: '2026-10-30', timeOfDay: 'AMC', releaseAt: 'soon' }).kind).toBe('typical');
  });
});
