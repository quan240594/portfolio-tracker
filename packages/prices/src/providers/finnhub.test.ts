import { MemoryItemStore } from '@portfolio/platform';
import { describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../errors.js';
import { HttpClient } from '../http.js';
import { BlockBook, MemoryQuotaLedger, MinuteQuota, ProviderGate } from '../limits.js';
import { FakeFetch } from '../testing/fake-fetch.js';
import { earningsTargets } from './calendar.js';
import { FINNHUB_BACKOFF_MS, FINNHUB_PACE_MS, FinnhubEarnings, FinnhubPacingError, FinnhubRefusedError, finnhubTargets, parseFinnhubCompany, pickRows, type DatedRow } from './finnhub.js';

const TODAY = '2026-11-02';
const NOW = Date.parse('2026-11-02T04:30:10.000Z');
const KEY = 'fh-test-key';

/** The real response shape of `/calendar/earnings` (documented fields), with invented values. */
const row = (symbol: string, date: string, hour: string, quarter = 3, year = 2026) => ({ date, epsActual: null, epsEstimate: 1.58, hour, quarter, revenueActual: null, revenueEstimate: 158_000_000_000, symbol, year });
const answer = (...rows: unknown[]) => ({ earningsCalendar: rows });
const target = (symbol: string) => [{ symbol }];

function setup(options: { limit?: number; now?: () => number } = {}) {
  const fake = new FakeFetch();
  const store = new MemoryItemStore();
  const now = options.now ?? (() => NOW);
  const http = new HttpClient({ provider: 'finnhub', fetch: fake.fetch, sleep: () => Promise.resolve(), random: () => 0, maxRetries: 0 });
  const gate = new ProviderGate(new BlockBook(store, () => new Date(now())), 'finnhub', () => new Date(now()));
  const minute = new MinuteQuota(new MemoryQuotaLedger(), 'finnhub', options.limit ?? 30, now);
  const source = new FinnhubEarnings({ apiKey: KEY, http, minute, gate, now });
  return { fake, store, source, gate };
}

describe('FinnhubEarnings: one company at a time', () => {
  it('asks for one symbol, from three days back to ninety days ahead, with the key in a header and not in the URL', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io/api/v1/calendar/earnings', answer(row('KMB', '2026-11-05', 'bmo')));
    const result = await source.fetchCompany('KMB', target('KMB'), TODAY);
    expect(fake.urls).toEqual(['https://finnhub.io/api/v1/calendar/earnings?symbol=KMB&from=2026-10-30&to=2027-01-31']);
    expect(fake.requests[0]!.headers['x-finnhub-token']).toBe(KEY);
    expect(fake.urls[0]).not.toContain(KEY);
    expect(result).toEqual({ rows: 1, upcoming: '2026-11-05', events: [{ symbol: 'KMB', date: '2026-11-05', epsEstimate: 1.58, timeOfDay: 'BMO', source: 'finnhub' }] });
  });

  it('maps the verified answers: bmo, amc and the empty list of a company without a date', async () => {
    const { fake, source } = setup();
    fake.add('symbol=NVO&', answer(row('NVO', '2026-11-04', 'bmo')));
    fake.add('symbol=APP&', answer(row('APP', '2026-11-04', 'amc')));
    fake.add('symbol=ZZZ&', answer());
    expect((await source.fetchCompany('NVO', target('NVO'), TODAY)).events[0]).toMatchObject({ date: '2026-11-04', timeOfDay: 'BMO' });
    expect((await source.fetchCompany('APP', target('APP'), TODAY)).events[0]).toMatchObject({ date: '2026-11-04', timeOfDay: 'AMC' });
    expect(await source.fetchCompany('ZZZ', target('ZZZ'), TODAY)).toEqual({ rows: 0, events: [] });
  });

  it('keeps the next upcoming row and a report of the last three days, and an unknown hour is unknown', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', answer(row('AMZN', '2026-10-31', 'amc', 3), row('AMZN', '2027-01-29', '', 4), row('AMZN', '2027-02-05', 'amc', 4)));
    const result = await source.fetchCompany('AMZN', target('AMZN'), TODAY);
    expect(result.events.map((event) => `${event.date} ${event.timeOfDay}`)).toEqual(['2026-10-31 AMC', '2027-01-29 unknown']);
    expect(result.upcoming).toBe('2027-01-29');
  });

  it('puts the date on every app symbol of the ticker (an alias and the plain listing)', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', answer(row('CRM', '2026-11-05', 'amc')));
    const result = await source.fetchCompany('CRM', [{ symbol: 'CRM' }, { symbol: 'FOO.DE' }], TODAY);
    expect(result.events.map((event) => event.symbol)).toEqual(['CRM', 'FOO.DE']);
  });

  it('skips rows of another ticker, rows without a valid date and rows that are not objects; BRK-B is BRK.B', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', answer(row('OTHER', '2026-11-05', 'bmo'), { symbol: 'BRK.B', date: 'garbage', hour: 'amc' }, 'not-a-row', null, row('BRK.B', '2026-11-04', 'DMH')));
    const result = await source.fetchCompany('BRK.B', target('BRK-B'), TODAY);
    expect(result.events.map((event) => `${event.symbol} ${event.date} ${event.timeOfDay}`)).toEqual(['BRK-B 2026-11-04 DMH']);
    expect(result.rows).toBe(5);
  });

  it('a row without a usable estimate has none', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', answer({ symbol: 'KO', date: '2026-11-04', hour: 'bmo', epsEstimate: null, quarter: 3, year: 2026 }));
    expect((await source.fetchCompany('KO', target('KO'), TODAY)).events[0]).toEqual({ symbol: 'KO', date: '2026-11-04', timeOfDay: 'BMO', source: 'finnhub' });
  });
});

describe('pickRows', () => {
  const dated = (date: string, period?: number): DatedRow => ({ date, timeOfDay: undefined, epsEstimate: undefined, period });

  it('takes the first row from today on and the latest one of the last three days', () => {
    const rows = [dated('2026-12-01'), dated('2026-10-30'), dated('2026-10-31'), dated('2026-11-02'), dated('2026-10-29')];
    expect(pickRows(rows, TODAY)).toEqual({ recent: dated('2026-10-31'), upcoming: dated('2026-11-02') });
    expect(pickRows([dated('2026-12-01')], TODAY)).toEqual({ recent: undefined, upcoming: dated('2026-12-01') });
    expect(pickRows([], TODAY)).toEqual({ recent: undefined, upcoming: undefined });
  });

  it('ignores an upcoming row of a fiscal period that is not newer than the one just reported', () => {
    const q3 = 2026 * 4 + 3;
    const rows = [dated('2026-10-31', q3), dated('2026-11-06', q3), dated('2026-11-05', q3 - 1), dated('2027-01-29', q3 + 1)];
    expect(pickRows(rows, TODAY).upcoming).toEqual(dated('2027-01-29', q3 + 1));
    expect(pickRows([dated('2026-10-31', q3), dated('2026-11-06')], TODAY).upcoming).toEqual(dated('2026-11-06'));
    expect(pickRows([dated('2026-10-31'), dated('2026-11-06', q3)], TODAY).upcoming).toEqual(dated('2026-11-06', q3));
  });

  it('reads the period from year and quarter and ignores a row that does not give both', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', answer(row('AMZN', '2026-10-31', 'amc', 3, 2026), row('AMZN', '2026-11-06', 'amc', 3, 2026), { symbol: 'AMZN', date: '2026-11-07', hour: 'amc', quarter: 9, year: 2026 }));
    const result = await source.fetchCompany('AMZN', target('AMZN'), TODAY);
    expect(result.events.map((event) => event.date)).toEqual(['2026-10-31', '2026-11-07']);
  });
});

describe('finnhubTargets', () => {
  it('asks about a US ticker and a curated alias, not about funds, crypto or a bare ticker of another exchange', () => {
    const targets = finnhubTargets(['AMZN', 'BRK-B', 'FOO.DE', 'ASML.AS', 'BTC-EUR']);
    expect([...targets.keys()].toSorted((a, b) => a.localeCompare(b))).toEqual(['AMZN', 'BRK.B', 'CRM']);
    expect(targets.get('CRM')).toEqual([expect.objectContaining({ symbol: 'FOO.DE', via: 'alias' })]);
    expect(finnhubTargets(['ASML.AS']).size).toBe(0);
    expect(earningsTargets(['ASML.AS']).size).toBeGreaterThan(0);
  });
});

describe('failures', () => {
  it('a refused key (401, 403) is a FinnhubRefusedError that says what it means, after one request', async () => {
    for (const status of [401, 403]) {
      const { fake, source } = setup();
      fake.add('finnhub.io', { status });
      const error = await source.fetchCompany('AMZN', target('AMZN'), TODAY).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FinnhubRefusedError);
      expect((error as Error).message).toBe(`finnhub: HTTP ${status}: the key was refused or has no access to the earnings calendar`);
      expect((error as ProviderError).status).toBe(status);
      expect(fake.urls).toHaveLength(1);
    }
  });

  it('an "Invalid API key" body, even with a 200, is a refusal; never with the key in the message', async () => {
    for (const body of [{ error: 'Invalid API key' }, { error: "You don't have access to this resource." }]) {
      const { fake, source } = setup();
      fake.add('finnhub.io', body);
      const error = await source.fetchCompany('AMZN', target('AMZN'), TODAY).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FinnhubRefusedError);
      expect((error as Error).message).not.toContain(KEY);
    }
  });

  it('a 429 is a RateLimitError, makes one request and blocks every later call for ten minutes', async () => {
    let now = NOW;
    const { fake, source, gate } = setup({ now: () => now });
    fake.add('finnhub.io', { status: 429 });
    await expect(source.fetchCompany('AMZN', target('AMZN'), TODAY)).rejects.toBeInstanceOf(RateLimitError);
    expect(fake.urls).toHaveLength(1);
    await expect(source.fetchCompany('KO', target('KO'), TODAY)).rejects.toThrow('finnhub is limited until 2026-11-02T04:40:10.000Z');
    expect(fake.urls).toHaveLength(1);
    now += FINNHUB_BACKOFF_MS + 1;
    fake.add('finnhub.io', answer());
    await expect(source.fetchCompany('KO', target('KO'), TODAY)).resolves.toMatchObject({ rows: 0 });
    expect(gate.provider).toBe('finnhub');
  });

  it('a "limit reached" body is a rate limit too', async () => {
    const { fake, source } = setup();
    fake.add('finnhub.io', { error: 'API limit reached. Please try again later. Remaining Limit: 0' });
    await expect(source.fetchCompany('AMZN', target('AMZN'), TODAY)).rejects.toBeInstanceOf(RateLimitError);
  });

  it('other errors are plain failures of that company: a 500 (no retry), another error body, a non-calendar answer', async () => {
    const { fake, source } = setup();
    fake.add('symbol=A&', { status: 500 });
    fake.add('symbol=B&', { error: 'Something else' });
    fake.add('symbol=C&', null);
    fake.add('symbol=D&', { earningsCalendar: 'nope' });
    const failures = await Promise.all(['A', 'B', 'C', 'D'].map((ticker) => source.fetchCompany(ticker, target(ticker), TODAY).catch((caught: unknown) => caught)));
    for (const failure of failures) {
      expect(failure).toBeInstanceOf(ProviderError);
      expect(failure).not.toBeInstanceOf(FinnhubRefusedError);
      expect(failure).not.toBeInstanceOf(RateLimitError);
    }
    expect((failures[1] as Error).message).toBe('finnhub: unexpected response for /calendar/earnings (Something else)');
    expect((failures[2] as Error).message).toBe('finnhub: unexpected response for /calendar/earnings');
    expect(fake.urls).toHaveLength(4);
  });

  it('never exceeds the minute: the call that would is not made and the step is told how long to wait', async () => {
    let now = Date.parse('2026-11-02T04:30:50.000Z');
    const { fake, source } = setup({ limit: 2, now: () => now });
    fake.add('finnhub.io', answer());
    await source.fetchCompany('A', target('A'), TODAY);
    await source.fetchCompany('B', target('B'), TODAY);
    const waiting = await source.fetchCompany('C', target('C'), TODAY).catch((caught: unknown) => caught);
    expect(waiting).toBeInstanceOf(FinnhubPacingError);
    expect((waiting as FinnhubPacingError).delayMs).toBe(11_000);
    expect(fake.urls).toHaveLength(2);
    now += 11_000;
    await expect(source.fetchCompany('C', target('C'), TODAY)).resolves.toMatchObject({ rows: 0 });
    expect(Math.floor(60_000 / FINNHUB_PACE_MS) + 1).toBeLessThan(30);
  });

  it('a failure of the minute counter itself is not taken for a wait', async () => {
    const { fake, source, gate } = setup();
    const broken = new FinnhubEarnings({ apiKey: KEY, http: new HttpClient({ provider: 'finnhub', fetch: fake.fetch, sleep: () => Promise.resolve() }), minute: { consume: () => Promise.reject(new Error('store down')) } as unknown as MinuteQuota, gate, now: () => NOW });
    await expect(broken.fetchCompany('AMZN', target('AMZN'), TODAY)).rejects.toThrow('store down');
    expect(fake.urls).toEqual([]);
    expect(source.name).toBe('finnhub');
  });

  it('parses a calendar answer directly', () => {
    expect(parseFinnhubCompany(answer(row('KO', '2026-11-04', 'bmo')), 'KO', target('KO'), TODAY).upcoming).toBe('2026-11-04');
    expect(() => parseFinnhubCompany(undefined, 'KO', target('KO'), TODAY)).toThrow('unexpected response');
  });
});
