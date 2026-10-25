import { describe, expect, it } from 'vitest';
import { EARNINGS_REFRESH_INTERVAL_MS, sampleSummary, type EarningsHolding } from '@portfolio/shared';
import { MAX_TRIES_PER_DAY, armedMarker, planItems } from './backfill.js';
import { nextAllowanceReset } from './common.js';
import { EarningsService } from './service.js';
import { FakeAi, type AiCall } from './testing/fake-ai.js';
import type { FilingSpec } from './testing/fake-sec.js';
import { BANK_RELEASE, GENERIC_RELEASE, REIT_RELEASE, SAAS_RELEASE, type FixtureRelease } from './testing/fixtures.js';
import { earningsHarness, type EarningsHarness, type HarnessOptions } from './testing/harness.js';
import { FOREIGN_TEXT_RELEASE } from './testing/messy-fixtures.js';
import type { SecFiling } from './sec.js';

const holding = (release: FixtureRelease): EarningsHolding => ({ symbol: release.symbol, name: release.name, template: release.template, currency: 'USD' });
const tickersOf = (...releases: FixtureRelease[]) => Object.fromEntries(releases.map((release) => [release.symbol.split('.')[0]!, { cik: Number(release.cik), title: release.name }]));

/** The same invented release filed at several dates (newest first), each filing with an accession of its own. */
function quarterly(release: FixtureRelease, dates: readonly string[], extra: Partial<FilingSpec> = {}): FilingSpec[] {
  return dates.map((date, index) => ({ release: { ...release, filingDate: date, accession: `${release.accession.slice(0, 14)}${String(900 + index).padStart(6, '0')}` }, ...extra }));
}

const DATES = ['2026-10-21', '2026-07-22', '2026-04-22', '2026-01-21'];

function setup(releases: FixtureRelease[], extra: HarnessOptions & { dates?: readonly string[] } = {}): EarningsHarness {
  const { dates = DATES, ...options } = extra;
  return earningsHarness({
    filings: releases.flatMap((release) => quarterly(release, dates)),
    tickers: tickersOf(...releases),
    holdings: releases.map(holding),
    ai: new FakeAi((call: AiCall) => releases.find((release) => call.input.messages[1]!.content.includes(`Company: ${release.name}`))?.extraction),
    env: { EARNINGS_BACKFILL_QUARTERS: '2' },
    ...options,
  });
}

async function run(h: EarningsHarness, trigger: 'scheduled' | 'manual' = 'scheduled'): Promise<void> {
  await h.queue.enqueue({ job: 'backfillEarnings', payload: { trigger } });
  await h.queue.drain();
}

const results = (h: EarningsHarness) => h.queue.results.filter((entry) => entry.job === 'backfillEarnings').map((entry) => entry.result);
const companiesRead = (h: EarningsHarness): string[] => h.ai.calls.map((call) => /Company: (.*)\n/.exec(call.input.messages[1]!.content)![1]!);

describe('the plan of a company', () => {
  const filing = (accession: string, filingDate: string, form: string, items = form === '8-K' ? '2.02,9.01' : ''): SecFiling => ({ accession, filingDate, reportDate: filingDate, form, items: items.split(',').filter((item) => item !== ''), primaryDocument: 'p.htm' });

  it('keeps one 8-K 2.02 per quarter, newest first, up to the wanted quarters, and marks stored ones', () => {
    const filings = [
      filing('a-4', '2026-10-21', '8-K'),
      filing('a-3', '2026-10-05', '8-K'),
      filing('a-2', '2026-07-22', '8-K'),
      filing('a-1', '2026-04-22', '8-K'),
      filing('x-1', '2026-04-01', '8-K', '5.02'),
    ];
    const stored = [sampleSummary({ symbol: 'A', reportDate: '2026-07-22', accession: 'a-2' })];
    const items = planItems(filings, 2, '2026-10-25', stored);
    expect(items.map((item) => [item.accession, item.status])).toEqual([['a-4', 'todo'], ['a-2', 'stored']]);
  });

  it('keeps many 6-Ks of a foreign issuer (any may be the results) and drops filings older than the window', () => {
    const filings = [...Array.from({ length: 12 }, (_, index) => filing(`f-${index}`, `2026-10-${String(20 - index).padStart(2, '0')}`, '6-K')), filing('old', '2024-01-01', '6-K')];
    const items = planItems(filings, 2, '2026-10-25', []);
    expect(items).toHaveLength(8);
    expect(items.some((item) => item.accession === 'old')).toBe(false);
  });
});

describe('the backfill of every holding', () => {
  it('reads the latest quarter of every company first, then the quarter before; a partial run is already useful', async () => {
    const releases = [GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE];
    const h = setup(releases);
    await run(h);
    expect(results(h).at(-1)).toEqual({ status: 'complete' });
    const bySymbol = releases.toSorted((a, b) => a.symbol.localeCompare(b.symbol)).map((release) => release.name);
    expect(companiesRead(h)).toEqual([...bySymbol, ...bySymbol]);
    for (const release of releases) expect((await h.repo.latest(release.symbol, 5)).map((summary) => summary.reportDate)).toEqual(['2026-10-21', '2026-07-22']);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', quarters: 2, total: 6, done: 6, stored: 6, failed: 0, planned: 3, companies: 3 });
  });

  it('is ordered newest first across companies even when it stops half way', async () => {
    const releases = [GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE, SAAS_RELEASE];
    const h = setup(releases, { allowance: 400 });
    await run(h);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'running', waitReason: 'allowance', stored: 4, total: 8, done: 4 });
    for (const release of releases) expect((await h.repo.latest(release.symbol, 5)).map((summary) => summary.reportDate)).toEqual(['2026-10-21']);
  });

  it('stores backfilled quarters silently, except a release published within the last 48 hours', async () => {
    const h = setup([GENERIC_RELEASE]);
    await run(h);
    const stored = await h.repo.latest('LMFG', 5);
    expect(stored.map((summary) => [summary.reportDate, summary.origin])).toEqual([['2026-10-21', 'live'], ['2026-07-22', 'backfill']]);
    expect(h.queue.enqueued.filter((message) => message.job === 'notifyDividends')).toHaveLength(1);
  });

  it('recomputes quarter over quarter of the newer summary when its predecessor arrives, idempotently', async () => {
    const h = setup([GENERIC_RELEASE]);
    await run(h);
    const [newest, older] = await h.repo.latest('LMFG', 2);
    expect(older!.previousReportDate).toBeUndefined();
    expect(newest).toMatchObject({ previousReportDate: '2026-07-22' });
    expect(newest!.headline.revenue?.qoqPct).toBe(0);
    h.queue.enqueued.length = 0;
    await run(h);
    expect(await h.repo.latest('LMFG', 2)).toEqual([newest, older]);
  });

  it('costs one row read and no outbound call once complete, and again when only waiting', async () => {
    const h = setup([GENERIC_RELEASE]);
    await run(h);
    const requests = h.sec.requests.length;
    const calls = h.ai.calls.length;
    await run(h);
    await run(h);
    expect(results(h).slice(-2)).toEqual([{ status: 'complete' }, { status: 'complete' }]);
    expect(h.sec.requests).toHaveLength(requests);
    expect(h.ai.calls).toHaveLength(calls);
  });

  it('waits for the daily allowance with the time shown, fetches nothing meanwhile and resumes at 00:00 UTC', async () => {
    const h = setup([GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE], { allowance: 300 });
    await run(h);
    const marker = await h.repo.getBackfill();
    expect(marker).toMatchObject({ status: 'running', waitReason: 'allowance', waitUntil: nextAllowanceReset(h.clock.now()) });
    expect(results(h).at(-1)).toEqual({ status: 'waiting', waitReason: 'allowance' });
    const requests = h.sec.requests.length;
    h.clock.advance(15 * 60_000);
    await run(h);
    expect(h.sec.requests).toHaveLength(requests);
    h.clock.advance(5 * 3_600_000);
    h.meter.spent = 0;
    await run(h);
    expect(results(h).at(-1)).toEqual({ status: 'complete' });
    expect(h.meter.spent).toBeLessThanOrEqual(6000);
  });

  it('never lets the spent neurons pass the allowance of the day', async () => {
    const h = setup([GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE, SAAS_RELEASE], { allowance: 400 });
    await run(h);
    expect(h.meter.spent).toBeLessThanOrEqual(400);
    expect((await h.repo.getBackfill())?.waitReason).toBe('allowance');
  });

  it('stops on an SEC block, waits until it ends, and carries on', async () => {
    const h = setup([GENERIC_RELEASE, REIT_RELEASE]);
    h.sec.forceStatus = 429;
    await run(h);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'running', waitReason: 'sec-blocked' });
    const requests = h.sec.requests.length;
    h.clock.advance(15 * 60_000);
    await run(h);
    expect(h.sec.requests).toHaveLength(requests);
    h.sec.forceStatus = undefined;
    h.clock.advance(2 * 3_600_000);
    await run(h);
    expect(results(h).at(-1)).toEqual({ status: 'complete' });
  });

  it('treats the SEC rate-limit page (HTML with status 200) as a block, not as a broken document', async () => {
    const h = setup([GENERIC_RELEASE]);
    h.sec.rateLimitPage = true;
    await run(h);
    expect(await h.repo.getBackfill()).toMatchObject({ waitReason: 'sec-blocked' });
    expect(await h.repo.getSecBlock()).toMatchObject({ failures: 1, lastStatus: 429 });
  });

  it('says why a company is skipped: not an SEC registrant, or no results release at all', async () => {
    const h = setup([GENERIC_RELEASE], { tickers: tickersOf(GENERIC_RELEASE), holdings: [holding(GENERIC_RELEASE), { symbol: 'XYZ.DE', name: 'Nothing AG', template: 'generic' }, { symbol: 'QUIET', name: 'Quiet Corp', template: 'generic' }] });
    h.sec.addFiling({ release: { ...GENERIC_RELEASE, symbol: 'QUIET', cik: '1000999', accession: '0001000999-26-000001', filingDate: '2026-09-01' }, items: '5.02' });
    h.sec.addFiling({ release: { ...GENERIC_RELEASE, symbol: 'QUIET', cik: '1000999', accession: '0001000999-26-000002', filingDate: '2026-09-02' }, items: '1.01' });
    (h.deps.inputs as { build: unknown }).build = () => Promise.resolve({ holdings: h.holdings, calendar: {} });
    await run(h);
    expect((await h.repo.getState('XYZ.DE'))?.lastRun).toMatchObject({ stage: 'ticker-map' });
    expect((await h.repo.getState('LMFG'))?.lastRun).toMatchObject({ stage: 'ok', detail: 'summary stored' });
    expect(results(h).at(-1)).toEqual({ status: 'complete' });
  });

  it('a foreign issuer: 6-Ks that are no results release are skipped, the results ones stored newest first', async () => {
    const notices = (accession: string, date: string): FilingSpec => ({ release: { ...FOREIGN_TEXT_RELEASE, accession, filingDate: date, html: '<p>Notice of the annual general meeting of shareholders. Please vote.</p>' } });
    const results1: FilingSpec = { release: { ...FOREIGN_TEXT_RELEASE, accession: '0001000703-26-000100', filingDate: '2026-10-14' } };
    const results2: FilingSpec = { release: { ...FOREIGN_TEXT_RELEASE, accession: '0001000703-26-000090', filingDate: '2026-07-15' } };
    const h = earningsHarness({
      filings: [notices('0001000703-26-000120', '2026-10-20'), results1, notices('0001000703-26-000110', '2026-09-01'), results2, notices('0001000703-26-000080', '2026-06-01')],
      tickers: { DSVX: { cik: 1000703, title: 'Delft Semiconductor Systems N.V.' } },
      holdings: [holding(FOREIGN_TEXT_RELEASE)],
      ai: new FakeAi(FOREIGN_TEXT_RELEASE.extraction),
      env: { EARNINGS_BACKFILL_QUARTERS: '2' },
    });
    await run(h);
    expect((await h.repo.latest('DSVX.AS', 5)).map((summary) => [summary.reportDate, summary.form])).toEqual([['2026-10-14', '6-K'], ['2026-07-15', '6-K']]);
    expect(h.ai.calls).toHaveLength(2);
    const plan = (await h.repo.getState('DSVX.AS'))!.plan!;
    expect(plan.filter((item) => item.status === 'skipped')).toHaveLength(2);
  });

  it('an unreadable release is tried again once, later, then failed; the owner can re-arm it, bounded per day', async () => {
    const h = setup([GENERIC_RELEASE], { ai: new FakeAi({ raw: 'sorry' }), dates: ['2026-10-21'], env: { EARNINGS_BACKFILL_QUARTERS: '1' } });
    await run(h);
    expect(h.ai.calls).toHaveLength(2);
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'todo', tries: 1 });
    expect((await h.repo.getState('LMFG'))!.lastRun).toMatchObject({ stage: 'ai', detail: expect.stringContaining('invalid JSON') });
    h.clock.advance(15 * 60_000);
    await run(h);
    expect(h.ai.calls).toHaveLength(2);
    h.clock.advance(6 * 3_600_000);
    await run(h);
    expect(h.ai.calls).toHaveLength(4);
    expect((await h.repo.getState('LMFG'))!.plan![0]).toMatchObject({ status: 'failed', tries: 2 });
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', failed: 1, stored: 0 });
    // Retry: the failed release is reopened, tried once more (the second try of this UTC day), then not again before tomorrow.
    h.clock.advance(60 * 60_000);
    const service = new EarningsService({ repo: h.repo, config: h.config, aiBound: true, queue: h.queue, now: h.clock.now, neurons: () => Promise.resolve({ used: 0, allowance: 10_000, state: 'ok', resetsAt: '' }) });
    expect(await service.backfill()).toEqual({ accepted: true });
    await h.queue.drain();
    expect(h.ai.calls).toHaveLength(6);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'running', waitReason: 'attempts' });
    await run(h);
    await run(h);
    expect(h.ai.calls).toHaveLength(6);
    expect(MAX_TRIES_PER_DAY).toBe(2);
    h.clock.advance(24 * 3_600_000);
    await run(h);
    expect(h.ai.calls).toHaveLength(8);
  });

  it('a new value of EARNINGS_BACKFILL_QUARTERS re-arms a finished backfill by itself', async () => {
    const h = setup([GENERIC_RELEASE]);
    await run(h);
    expect(await h.repo.getBackfill()).toMatchObject({ status: 'complete', quarters: 2 });
    const more = earningsHarness({ filings: quarterly(GENERIC_RELEASE, DATES), tickers: tickersOf(GENERIC_RELEASE), holdings: [holding(GENERIC_RELEASE)], ai: new FakeAi(GENERIC_RELEASE.extraction), env: { EARNINGS_BACKFILL_QUARTERS: '4' } });
    await more.repo.putBackfill({ ...armedMarker(2, 'auto', more.clock.now()), status: 'complete' });
    await run(more);
    expect(await more.repo.getBackfill()).toMatchObject({ status: 'complete', quarters: 4, stored: 4 });
  });

  it('does nothing before the feature is configured', async () => {
    const h = earningsHarness({ configured: false });
    await run(h);
    expect(results(h)).toEqual([{ status: 'not-configured' }]);
    expect(await h.repo.getBackfill()).toBeNull();
  });
});

describe('Fetch all now', () => {
  const service = (h: EarningsHarness) => new EarningsService({ repo: h.repo, config: h.config, aiBound: true, queue: h.queue, now: h.clock.now, neurons: () => Promise.resolve({ used: 0, allowance: 10_000, state: 'ok', resetsAt: '' }) });

  it('re-arms the backfill and runs it, at most once an hour', async () => {
    const h = setup([GENERIC_RELEASE]);
    expect(await service(h).backfill()).toEqual({ accepted: true });
    await h.queue.drain();
    expect(await h.repo.getBackfill()).toMatchObject({ armedBy: 'manual', status: 'complete', stored: 2 });
    expect(await service(h).backfill()).toEqual({ accepted: false, reason: 'rate-limited', retryAfterSeconds: EARNINGS_REFRESH_INTERVAL_MS / 1000 });
    h.clock.advance(EARNINGS_REFRESH_INTERVAL_MS);
    expect(await service(h).backfill()).toEqual({ accepted: true });
  });

  it('is refused when the feature is not configured', async () => {
    const h = earningsHarness({ configured: false });
    const svc = new EarningsService({ repo: h.repo, config: h.config, aiBound: false, queue: h.queue, now: h.clock.now, neurons: () => Promise.resolve({ used: 0, allowance: 10_000, state: 'ok', resetsAt: '' }) });
    expect(await svc.backfill()).toEqual({ accepted: false, reason: 'not-configured' });
  });

  it('shows the progress and the pause in the status', async () => {
    const h = setup([GENERIC_RELEASE, REIT_RELEASE, BANK_RELEASE], { allowance: 300 });
    await run(h);
    const status = await service(h).status(h.holdings.map((entry) => ({ symbol: entry.symbol, eligible: true })));
    expect(status.backfill).toMatchObject({ status: 'running', waitReason: 'allowance', quarters: 2, total: 6, done: 3, stored: 3 });
    expect(status.backfill?.waitUntil).toBe(nextAllowanceReset(h.clock.now()));
    expect(status.symbols.find((entry) => entry.symbol === 'HSRT')).toMatchObject({ releases: { planned: 2, stored: 1, failed: 0 } });
    expect(status.lastFullPassAt).toBeDefined();
  });
});
